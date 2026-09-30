// Poll Section: Actions runs (US4). Sources come from `runSources` (R1/R4/
// R10): A10 (org active), A11 (org recent, base only), A15 (org "mine",
// research R4 "не вытесняются") per organization, and A12 per repo (pinned
// repos always get their own source even when their org is already covered
// — R4 flood protection). Workflow human names (A13) are cached per
// instance for 24h (`workflows:<instanceId>`, R5); on a cache miss/expiry
// for a repo referenced this cycle we fetch once per repo and fall back to
// the raw file name on error (R5 "При ошибке — имя файла").
//
// Sources are fetched with `Promise.allSettled` (review H1): a 404/403/500
// on *one* source (e.g. a deleted pinned repo, a typo'd `includeRepos`
// entry) must not take down the whole `runs` section every cycle — the
// failed source is simply skipped and the runs from the rest are kept.
// `sectionErrors.runs` is only set (by rethrowing, letting
// `poller/index.ts` do its normal mapping) when *every* source this cycle
// failed, since at that point there is genuinely nothing to show.
//
// Two exceptions:
// - A 401 (`ApiError.kind==='auth'`) on *any* source is rethrown
//   immediately, regardless of the other sources, so the poller's
//   auth-pause (`pausedForAuth`) still kicks in right away.
// - A 403 from an org-scoped request (R1's `capabilities.actions==='org'`
//   mode) only downgrades `capabilities.actions` to `'repo'` when *every*
//   org-kind source this cycle (across *all* organizations —
//   orgActive/orgRecent/orgMine) came back 403; a 403 on a subset of orgs
//   (or a non-403 failure) leaves `capabilities.actions` at `'org'` and
//   just drops that one source's runs.
//
// Source of truth: docs/specs/001-gitea-dashboard/research.md R1/R4-R6/R10,
// contracts/gitea-api.md A10-A13/A15, data-model.md "Run"/"workflows:<id>".

import { ApiError } from '../../api/client';
import { createEndpoints, type Endpoints } from '../../api/endpoints';
import type { ApiActionWorkflowRun } from '../../api/types';
import { redUntilFrom } from '../../domain/badge';
import { buildRunList, runCounts, type RunContext } from '../../domain/runs';
import { runSources, type RunSource } from '../../domain/scope';
import {
  ACTIVE_RUN_STATES,
  type Capabilities,
  type PullRequest,
  type RepoRef,
  type Run,
  type Snapshot,
  type SnapshotCounts,
} from '../../domain/types';
import * as storage from '../../lib/storage';
import type { Section, SectionContext } from './index';

const DEFAULT_COUNTS: SnapshotCounts = {
  reviews: 0,
  activeMine: 0,
  activeOthers: 0,
  failedOthers: 0,
};

const WORKFLOWS_TTL_MS = 24 * 60 * 60 * 1000;
const OWN_REPOS_TTL_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function repoFullName(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}

function splitFullName(fullName: string): RepoRef {
  const slash = fullName.indexOf('/');
  if (slash === -1) {
    return { owner: fullName, name: '' };
  }
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

function workflowFileOf(path: string): string {
  const at = path.indexOf('@');
  return at === -1 ? path : path.slice(0, at);
}

/** Fetches the raw `workflow_runs[]` for one `RunSource`. */
async function fetchSource(
  endpoints: Endpoints,
  source: RunSource,
  login: string
): Promise<ApiActionWorkflowRun[]> {
  switch (source.kind) {
    case 'orgActive':
      return (await endpoints.orgActiveRuns(source.org)).workflow_runs;
    case 'orgRecent':
      return (await endpoints.orgRecentRuns(source.org)).workflow_runs;
    case 'orgMine':
      return (await endpoints.orgMyRuns(source.org, login)).workflow_runs;
    case 'repo':
      return (await endpoints.repoRuns(source.owner, source.repo, source.limit)).workflow_runs;
  }
}

/** Fetches every source independently — one source's failure never aborts the rest. */
async function fetchAllSettled(
  endpoints: Endpoints,
  sources: RunSource[],
  login: string
): Promise<PromiseSettledResult<ApiActionWorkflowRun[]>[]> {
  return Promise.allSettled(sources.map((s) => fetchSource(endpoints, s, login)));
}

function isAuthError(reason: unknown): boolean {
  return reason instanceof ApiError && reason.kind === 'auth';
}

function isForbiddenError(reason: unknown): boolean {
  return reason instanceof ApiError && reason.kind === 'forbidden';
}

/**
 * A 401 must stop the cycle immediately (poller/index.ts's auth-pause),
 * regardless of how many other sources are still pending/settled — never
 * swallowed into a "some sources failed" skip.
 */
function throwIfAuth(settled: PromiseSettledResult<unknown>[]): void {
  for (const r of settled) {
    if (r.status === 'rejected' && isAuthError(r.reason)) {
      throw r.reason;
    }
  }
}

/**
 * Persists a `capabilities` patch (L6 fix): re-reads `instances` right
 * before writing and merges the patch onto whatever is currently stored,
 * rather than the possibly-stale `ctx.instance.capabilities` snapshot taken
 * at the start of this cycle — a concurrent write to another field (e.g.
 * `notes.ts`'s own `persistCapabilities`, or an Options save) landing
 * mid-cycle must not be clobbered by this section writing back its own,
 * now-outdated copy of the rest of `capabilities`.
 */
async function persistCapabilities(
  instanceId: string,
  patch: Partial<Capabilities>
): Promise<void> {
  const state = await storage.getInstances();
  const instances = state.instances.map((instance) =>
    instance.id === instanceId
      ? { ...instance, capabilities: { ...instance.capabilities, ...patch } }
      : instance
  );
  await storage.setInstances({ ...state, instances });
}

/**
 * Loads the signed-in user's own repos with Actions enabled (T066, research
 * R1), refreshed at most hourly and only in `base` mode: a `fast` cycle
 * always reuses whatever is cached (or `[]` if nothing has been fetched
 * yet), since `runSources` only ever consults `ownRepos` in `base` mode
 * anyway. A fetch failure (network, missing `userId`, ...) falls back to
 * the last cached value rather than failing the whole `runs` section.
 */
async function loadOwnRepos(
  endpoints: Endpoints,
  instanceId: string,
  userId: number | undefined,
  mode: 'base' | 'fast' | 'page-fast',
  now: Date
): Promise<RepoRef[]> {
  const cache = await storage.getOwnReposCache(instanceId);
  const isExpired =
    !cache || now.getTime() - new Date(cache.fetchedAt).getTime() >= OWN_REPOS_TTL_MS;

  if (mode !== 'base' || !isExpired || userId === undefined) {
    return cache?.repos ?? [];
  }

  try {
    const apiRepos = await endpoints.ownRepos(userId);
    const repos = apiRepos.map((r) => ({ owner: r.owner.login, name: r.name }));
    await storage.setOwnReposCache(instanceId, { fetchedAt: now.toISOString(), repos });
    return repos;
  } catch {
    // Leave the stale cache (and its TTL) in place so the next cycle
    // retries instead of silently locking in an empty list for an hour.
    return cache?.repos ?? [];
  }
}

/** "owner/repo" -> set of my open PR numbers in that repo (R6). */
function buildMyOpenPrs(prs: PullRequest[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const pr of prs) {
    if (pr.group !== 'mine') continue;
    const key = repoFullName(pr.repo);
    const set = map.get(key) ?? new Set<number>();
    set.add(pr.number);
    map.set(key, set);
  }
  return map;
}

/**
 * Repo-fallback candidates (R1 "закреплённые + где мои PR/сборки за 7
 * дней"): repos of my own open PRs, plus repos of my runs (from the
 * previous snapshot) started within the last 7 days.
 */
function recentMineRepos(prs: PullRequest[], prevRuns: Run[] | undefined, now: Date): RepoRef[] {
  const seen = new Set<string>();
  const result: RepoRef[] = [];
  const add = (r: RepoRef): void => {
    const key = repoFullName(r);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(r);
  };

  for (const pr of prs) {
    if (pr.group === 'mine') add(pr.repo);
  }

  const cutoffMs = now.getTime() - SEVEN_DAYS_MS;
  for (const run of prevRuns ?? []) {
    if (!run.mine || !run.startedAt) continue;
    if (new Date(run.startedAt).getTime() >= cutoffMs) {
      add(run.repo);
    }
  }

  return result;
}

/** repoFullName -> set of workflow file names referenced this cycle. */
function filesByRepo(rawLists: ApiActionWorkflowRun[][]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const list of rawLists) {
    for (const api of list) {
      const full = api.repository.full_name;
      const file = workflowFileOf(api.path);
      const set = map.get(full) ?? new Set<string>();
      set.add(file);
      map.set(full, set);
    }
  }
  return map;
}

function cacheKey(repoFull: string, file: string): string {
  return `${repoFull}::${file}`;
}

// Sentinel marking "this repo's workflow list was fetched" independent of
// which files got a name back — a repo can reference a workflow file that
// no longer has an entry in `GET .../actions/workflows` (e.g. deleted after
// the run happened); without this a repo with such a file would be
// re-probed every single cycle instead of respecting the 24h TTL.
function probedKey(repoFull: string): string {
  return `__probed::${repoFull}`;
}

/**
 * Ensures `workflows:<instanceId>` has a human name for every workflow file
 * referenced by `rawLists` this cycle (R5, TTL 24h): repos whose files are
 * already cached (and the cache isn't stale) are skipped; the rest get one
 * `repoWorkflows` call each. A failed lookup is swallowed — `toRun` already
 * falls back to the file name (R5 "При ошибке — имя файла").
 */
async function ensureWorkflowNames(
  endpoints: Endpoints,
  instanceId: string,
  rawLists: ApiActionWorkflowRun[][],
  now: Date
): Promise<Map<string, Map<string, string>>> {
  const cache = await storage.getWorkflowsCache(instanceId);
  const names: Record<string, string> = { ...(cache?.names ?? {}) };
  const isExpired =
    !cache || now.getTime() - new Date(cache.fetchedAt).getTime() >= WORKFLOWS_TTL_MS;

  const repoFiles = filesByRepo(rawLists);
  const reposNeeding: string[] = [];
  for (const full of repoFiles.keys()) {
    if (isExpired || !(probedKey(full) in names)) {
      reposNeeding.push(full);
    }
  }

  if (reposNeeding.length > 0) {
    const fetched = await Promise.all(
      reposNeeding.map(async (full) => {
        const { owner, name } = splitFullName(full);
        const workflows = await endpoints.repoWorkflows(owner, name).catch(() => []);
        return { full, workflows };
      })
    );
    for (const { full, workflows } of fetched) {
      names[probedKey(full)] = '1';
      for (const wf of workflows) {
        names[cacheKey(full, wf.id)] = wf.name;
      }
    }
    await storage.setWorkflowsCache(instanceId, { fetchedAt: now.toISOString(), names });
  }

  const workflowNames = new Map<string, Map<string, string>>();
  for (const [key, name] of Object.entries(names)) {
    if (key.startsWith('__probed::')) continue;
    const sep = key.indexOf('::');
    const full = key.slice(0, sep);
    const file = key.slice(sep + 2);
    const perRepo = workflowNames.get(full) ?? new Map<string, string>();
    perRepo.set(file, name);
    workflowNames.set(full, perRepo);
  }
  return workflowNames;
}

/** Fresh runs win by id; other previous runs stay; active first, then newest. */
function mergePageFast(prevRuns: Run[], fresh: Run[]): Run[] {
  const freshIds = new Set(fresh.map((r) => r.id));
  const merged = [...fresh, ...prevRuns.filter((r) => !freshIds.has(r.id))];
  const activeStates: readonly string[] = ACTIVE_RUN_STATES;
  const started = (r: Run): number => (r.startedAt ? new Date(r.startedAt).getTime() : 0);
  return merged.sort((a, b) => {
    const aActive = activeStates.includes(a.state);
    const bActive = activeStates.includes(b.state);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return started(b) - started(a);
  });
}

export const runsSection: Section = {
  name: 'runs',
  // FR-041/research R10: the `poll-fast` alarm only refreshes builds.
  fast: true,
  async run(ctx: SectionContext): Promise<Partial<Snapshot>> {
    const { instance, settings, client, prev, now, mode } = ctx;
    const endpoints = createEndpoints(client);
    const login = instance.login ?? '';

    const pins = await storage.getPins(instance.id);
    const ownRepos = await loadOwnRepos(endpoints, instance.id, instance.userId, mode, now);
    const currentPrs = ctx.merged.prs ?? prev?.prs ?? [];
    const recentMine = recentMineRepos(currentPrs, prev?.runs, now);

    let caps = instance.capabilities;
    let sourcesResult = runSources({ caps, settings, orgs: caps.orgs, pins, ownRepos, recentMine, mode });
    let orgSources: RunSource[] = sourcesResult.sources.filter((s) => s.kind !== 'repo');
    let repoSources: RunSource[] = sourcesResult.sources.filter((s) => s.kind === 'repo');

    if (mode === 'page-fast' && sourcesResult.sources.length === 0) {
      return {};
    }

    let orgSettled = await fetchAllSettled(endpoints, orgSources, login);
    throwIfAuth(orgSettled);

    const allOrgForbidden =
      orgSources.length > 0 && orgSettled.every((r) => r.status === 'rejected' && isForbiddenError(r.reason));

    if (allOrgForbidden && caps.actions === 'org') {
      caps = { ...caps, actions: 'repo' };
      await persistCapabilities(instance.id, { actions: 'repo' });
      sourcesResult = runSources({ caps, settings, orgs: caps.orgs, pins, ownRepos, recentMine, mode });
      orgSources = [];
      repoSources = sourcesResult.sources;
      orgSettled = [];
    }

    const repoSettled = await fetchAllSettled(endpoints, repoSources, login);
    throwIfAuth(repoSettled);

    const allSettled = [...orgSettled, ...repoSettled];
    const rawLists: ApiActionWorkflowRun[][] = [];
    let failedCount = 0;
    let firstFailure: unknown;
    for (const r of allSettled) {
      if (r.status === 'fulfilled') {
        rawLists.push(r.value);
      } else {
        failedCount += 1;
        firstFailure ??= r.reason;
      }
    }

    // Only surface a `sectionErrors.runs` failure when *every* source this
    // cycle failed — a subset failing just means fewer runs this cycle.
    if (allSettled.length > 0 && failedCount === allSettled.length) {
      throw firstFailure;
    }

    const workflowNames = await ensureWorkflowNames(endpoints, instance.id, rawLists, now);

    const runCtx: RunContext = {
      me: login,
      myOpenPrs: buildMyOpenPrs(currentPrs),
      pinned: new Set(pins.map(repoFullName)),
      workflowNames,
    };

    const fresh = buildRunList(rawLists, runCtx, now.toISOString(), settings.recentWindowHours);
    // T043: a page-fast cycle only saw the ACTIVE lists, so it may only
    // refresh/add active runs. Everything else in the previous snapshot
    // (completed runs, and active runs that just vanished from the active
    // list -- their real outcome comes with the next regular cycle, and the
    // notifier must not see them disappear) is kept untouched.
    const runs = mode === 'page-fast' ? mergePageFast(prev?.runs ?? [], fresh) : fresh;
    const counts = runCounts(runs);
    const redUntil = redUntilFrom(runs, settings.redBadgeWindowMin, now);

    const baseCounts = ctx.merged.counts ?? prev?.counts ?? DEFAULT_COUNTS;

    return {
      runs,
      counts: {
        ...baseCounts,
        activeMine: counts.activeMine,
        activeOthers: counts.activeOthers,
        failedOthers: counts.failedOthers,
      },
      redUntil,
    };
  },
};
