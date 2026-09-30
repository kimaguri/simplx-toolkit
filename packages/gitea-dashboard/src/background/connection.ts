// FR-001: connection diagnosis + Instance persistence.
// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md ("Коды ответа →
// диагностика"), contracts/extension-surface.md (ConnectionReport, "Словарь
// ошибок"), research.md R1-R3.
//
// Probe order (each step short-circuits into a ConnectionReport on failure,
// except the notifications probe which is never fatal):
//   1. normalizeBaseUrl -> invalid input never reaches fetch() (kind 'bad-url').
//   2. A2 /user -> 401 'auth', thrown/aborted 'unreachable', non-JSON
//      'not-gitea' (via ApiError.kind -> toConnectionKind).
//   3. A1 /version -> best-effort; failure never fails the whole check.
//   4. A3 /user/orgs -> 403 -> 'scope' + missingScopes ['read:organization'].
//   5. Actions capability probe (R1): org-runs (A10) on the first org, falling
//      back to a probe repo (A4 + A12) when the org probe is inconclusive or
//      there are no orgs at all.
//   6. A14 /notifications -> 403 is recorded as a missing scope but never
//      fails the report (polish-stage feature, R3).
//
// On success, persists the checked Instance (without the token — saving the
// token is the options page's job, FR-003). Whether it becomes/stays the
// active instance is gated by `persist` (default true) — see
// `persistInstance` below (M5 review fix: a manual check of an unsaved URL
// must never hijack `activeInstanceId`).

import { createClient, ApiError, type ApiClient } from '../api/client';
import { createEndpoints, type Endpoints } from '../api/endpoints';
import {
  toConnectionKind,
  type Capabilities,
  type ConnectionKind,
  type ConnectionReport,
  type Instance,
  type Scope,
} from '../domain/types';
import { getInstances, instanceId, normalizeBaseUrl, setInstances } from '../lib/storage';

export interface ClientFactoryArgs {
  baseUrl: string;
  token: string;
}

export interface CheckConnectionDeps {
  clientFactory?: (args: ClientFactoryArgs) => ApiClient;
  now?: () => Date;
}

type ProbeOutcome = 'ok' | 'not-found' | 'forbidden';

function messageKeyForKind(kind: ConnectionKind): string {
  return `diag_${kind.replace(/-/g, '_')}`;
}

function badUrlReport(): ConnectionReport {
  return {
    ok: false,
    kind: 'bad-url',
    actions: 'unsupported',
    missingScopes: [],
    messageKey: messageKeyForKind('bad-url'),
  };
}

function failureReport(
  kind: ConnectionKind,
  extra: { login?: string; version?: string; missingScopes?: Scope[] } = {}
): ConnectionReport {
  return {
    ok: false,
    kind,
    login: extra.login,
    version: extra.version,
    actions: 'unsupported',
    missingScopes: extra.missingScopes ?? [],
    messageKey: messageKeyForKind(kind),
  };
}

/** Runs a single actions-probe request, classifying its outcome. Rethrows
 * anything that isn't a 404/403 ApiError (e.g. network/server errors bubble
 * up to the top-level handler, which turns them into a proper report). */
async function probeRun(fn: () => Promise<unknown>): Promise<ProbeOutcome> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.kind === 'not-found') return 'not-found';
      if (err.kind === 'forbidden') return 'forbidden';
    }
    throw err;
  }
}

/** A4 (limit 1) + A12 (limit 1) against one repo the token can see. Returns
 * `undefined` when no repo is visible at all (capability stays undetermined
 * from the repo side). */
async function probeRepoActions(endpoints: Endpoints): Promise<ProbeOutcome | undefined> {
  const repos = await endpoints.searchRepos('', 1);
  const repo = repos[0];
  if (!repo) {
    return undefined;
  }
  return probeRun(() => endpoints.repoRuns(repo.owner.login, repo.name, 1));
}

/** R1: org-runs first, falling back to repo-runs when the org probe isn't a
 * plain success (no orgs, 404 "unsupported", or 403 "forbidden"). */
async function probeActionsCapability(
  endpoints: Endpoints,
  orgs: string[]
): Promise<Capabilities['actions']> {
  let orgOutcome: ProbeOutcome | undefined;
  if (orgs.length > 0) {
    orgOutcome = await probeRun(() => endpoints.orgActiveRuns(orgs[0] as string));
    if (orgOutcome === 'ok') {
      return 'org';
    }
  }

  const repoOutcome = await probeRepoActions(endpoints);

  if (repoOutcome === 'ok') {
    return 'repo';
  }
  if (orgOutcome === 'not-found' && (repoOutcome === 'not-found' || repoOutcome === undefined)) {
    return 'unsupported';
  }
  if (orgOutcome === undefined && repoOutcome === 'not-found') {
    return 'unsupported';
  }
  if (orgOutcome === undefined && repoOutcome === undefined) {
    return 'unsupported';
  }
  return 'forbidden';
}

/** A14: never fatal (R3, "этап полировки"). */
async function probeNotifications(
  endpoints: Endpoints
): Promise<{ notifications: boolean; missingScopes: Scope[] }> {
  try {
    await endpoints.notifications(new Date(0).toISOString());
    return { notifications: true, missingScopes: [] };
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'forbidden') {
      return { notifications: false, missingScopes: ['read:notification'] };
    }
    return { notifications: true, missingScopes: [] };
  }
}

/**
 * Persists the checked instance's capabilities.
 *
 * - `persist: true` (default, Save flow): the checked instance becomes (or
 *   stays) the active one, as before.
 * - `persist: false` (manual "Проверить подключение", M5 fix): never touches
 *   `activeInstanceId` or adds a new Instance — checking an unsaved/different
 *   URL must not silently switch the poller to an instance without a token.
 *   The one exception: if the checked URL *is* the current active instance
 *   (a re-probe, e.g. after a 403 downgrade), its capabilities are still
 *   refreshed in place so the options page reflects reality.
 */
async function persistInstance(
  baseUrl: string,
  info: {
    login?: string;
    userId?: number;
    version?: string;
    capabilities: Capabilities;
  },
  now: () => Date,
  persist: boolean
): Promise<void> {
  const id = await instanceId(baseUrl);
  const { instances, activeInstanceId } = await getInstances();

  if (!persist) {
    if (activeInstanceId !== id) {
      return;
    }
    const existing = instances.find((entry) => entry.id === id);
    if (!existing) {
      return;
    }
    const updated: Instance = {
      ...existing,
      login: info.login,
      userId: info.userId,
      serverVersion: info.version,
      capabilities: info.capabilities,
      checkedAt: now().toISOString(),
    };
    const nextInstances = instances.map((entry) => (entry.id === id ? updated : entry));
    await setInstances({ instances: nextInstances, activeInstanceId });
    return;
  }

  const instance: Instance = {
    id,
    baseUrl,
    login: info.login,
    userId: info.userId,
    serverVersion: info.version,
    capabilities: info.capabilities,
    checkedAt: now().toISOString(),
  };
  const nextInstances = [...instances.filter((existing) => existing.id !== id), instance];
  await setInstances({ instances: nextInstances, activeInstanceId: id });
}

export interface CheckConnectionOptions {
  /** Defaults to `true` (existing Save-flow behavior). */
  persist?: boolean;
}

export async function checkConnection(
  baseUrl: string,
  token: string,
  options: CheckConnectionOptions = {},
  deps: CheckConnectionDeps = {}
): Promise<ConnectionReport> {
  const persist = options.persist ?? true;
  let normalized: string;
  try {
    normalized = normalizeBaseUrl(baseUrl);
  } catch {
    return badUrlReport();
  }

  const clientFactory = deps.clientFactory ?? createClient;
  const now = deps.now ?? (() => new Date());
  const client = clientFactory({ baseUrl: normalized, token });
  const endpoints = createEndpoints(client);

  let login: string | undefined;
  let userId: number | undefined;
  let version: string | undefined;

  try {
    const user = await endpoints.currentUser();
    login = user.login;
    userId = user.id;

    try {
      version = (await endpoints.version()).version;
    } catch {
      version = undefined;
    }

    let orgs: string[];
    try {
      orgs = (await endpoints.userOrgs()).map((org) => org.username);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'forbidden') {
        return failureReport('scope', { login, version, missingScopes: ['read:organization'] });
      }
      throw err;
    }

    const actions = await probeActionsCapability(endpoints, orgs);
    const { notifications, missingScopes } = await probeNotifications(endpoints);

    const capabilities: Capabilities = { actions, notifications, orgs, missingScopes };
    await persistInstance(normalized, { login, userId, version, capabilities }, now, persist);

    return {
      ok: true,
      login,
      version,
      actions,
      missingScopes,
      messageKey: 'diag_ok',
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return failureReport(toConnectionKind(err.kind), { login, version });
    }
    throw err;
  }
}
