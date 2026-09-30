// Security tests (SC-007, FR-003/FR-005/FR-006): the PAT never leaves
// `storage.local["token:<instanceId>"]` — not into `storage.sync`, not into
// `Snapshot`, and not into any `console.*` call, including on error paths
// (401 "auth", a thrown/aborted fetch "unreachable", and a 500 "server").
// Also: every request goes to the configured `baseUrl` origin, is a GET,
// and `fetch()` is only ever called from `src/api/client.ts` (no other
// module in `src/**` talks to the network directly or uses a non-GET
// method).
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL pathname
// (like tests/integration/poller-prs.test.ts / poller-runs.test.ts /
// notify-dedupe.test.ts). No real HTTP is made.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { checkConnection } from '../../src/background/connection';
import { createNotifier } from '../../src/background/notifier';
import { createPoller } from '../../src/background/poller';
import { prsSection } from '../../src/background/poller/prs';
import { runsSection } from '../../src/background/poller/runs';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const TOKEN = 'tok_SECRET_4f9a'; // gitleaks:allow — fake token used to assert it never leaks
const BASE_URL = 'https://git.example.test';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_sectest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'repo', notifications: true, orgs: [], missingScopes: [] },
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    notify: { ...DEFAULT_SETTINGS.notify, ...overrides.notify },
    scope: { ...DEFAULT_SETTINGS.scope, includeRepos: ['acme/platform'], ...overrides.scope },
  };
}

async function setUp(inst: Instance, s: Settings): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, TOKEN);
  await storage.setSettings(s);
}

type Handler = (url: URL) => unknown;
interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers));
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => h.get(name) ?? null },
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
  } as unknown as Response;
}

function makeFetchMock(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    // Requirement (3): every request stays on baseUrl's origin and is GET.
    expect(url.origin).toBe(new URL(BASE_URL).origin);
    expect(init?.method === undefined || init.method === 'GET').toBe(true);
    const route = routes.find((r) => r.match(url));
    if (!route) {
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    return jsonResponse(route.handler(url));
  });
}

function issuesSearchRoute(param: 'review_requested' | 'created', ownerLogin?: string): Route {
  return {
    match: (u) =>
      path(u) === '/repos/issues/search' &&
      (ownerLogin
        ? u.searchParams.get('owner') === ownerLogin
        : u.searchParams.get(param) === 'true'),
    handler: () => [],
  };
}

function workflowsRoute(): Route {
  return {
    match: (u) => /\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(path(u)),
    handler: () => ({ total_count: 0, workflows: [] }),
  };
}

function runsRoute(status: 'ok' | 'failed'): Route {
  return {
    match: (u) => path(u) === '/repos/acme/platform/actions/runs',
    handler: () => ({
      total_count: status === 'failed' ? 1 : 0,
      workflow_runs:
        status === 'failed'
          ? [
              {
                id: 900,
                run_attempt: 1,
                run_number: 1,
                status: 'completed',
                conclusion: 'failure',
                event: 'push',
                head_branch: 'main',
                head_sha: 'deadbeef',
                display_title: 'push: main',
                path: 'ci.yml@refs/heads/main',
                actor: { login: 'me' },
                trigger_actor: { login: 'me' },
                repository: { full_name: 'acme/platform' },
                html_url: `${BASE_URL}/acme/platform/actions/runs/900`,
                started_at: '2026-09-26T09:00:00Z',
                completed_at: '2026-09-26T09:05:00Z',
                pull_requests: [],
              },
            ]
          : [],
    }),
  };
}

function pullsRoute(): Route {
  return { match: (u) => path(u) === '/repos/acme/platform/pulls', handler: () => [] };
}

function baseRoutes(): Route[] {
  return [
    issuesSearchRoute('review_requested'),
    issuesSearchRoute('created'),
    issuesSearchRoute('review_requested', 'me'),
    pullsRoute(),
    runsRoute('ok'),
    workflowsRoute(),
  ];
}

/** JSON.stringify of every value currently in a `browser.storage.<area>`. */
async function snapshotStorage(area: 'sync' | 'local'): Promise<Record<string, unknown>> {
  return browser.storage[area].get(null);
}

function wirePoller(): { poller: ReturnType<typeof createPoller>; notifier: ReturnType<typeof createNotifier> } {
  const notifier = createNotifier();
  const poller = createPoller({
    sections: [prsSection, runsSection],
    clientFactory: createClient,
    onCycleComplete: async (prev, next, inst) => {
      const s = await storage.getSettings();
      await notifier.handleCycle(prev, next, inst, s);
    },
  });
  return { poller, notifier };
}

describe('security integration (SC-007, FR-003/005/006)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    vi.spyOn(browser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    // Spy every console method for the whole test — scenario (2) asserts
    // the token appears in none of their captured arguments.
    consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
  });

  function assertNoTokenInConsole(): void {
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const serialized = call
          .map((arg: unknown) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
          .join(' ');
        expect(serialized).not.toContain(TOKEN);
      }
    }
  }

  it('scenario 1: after a full base cycle (prs + runs + notifier), the token is confined to storage.local["token:<id>"]', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(baseRoutes()).getMockImplementation()!);

    const { poller } = wirePoller();
    await poller.runCycle('base');

    const syncDump = await snapshotStorage('sync');
    const localDump = await snapshotStorage('local');

    // storage.sync must not contain the token at all.
    expect(JSON.stringify(syncDump)).not.toContain(TOKEN);

    // storage.local: only the dedicated `token:<id>` key may hold it.
    const tokenKey = `token:${inst.id}`;
    expect(localDump[tokenKey]).toBe(TOKEN);
    const localWithoutToken = { ...localDump };
    delete localWithoutToken[tokenKey];
    expect(JSON.stringify(localWithoutToken)).not.toContain(TOKEN);

    assertNoTokenInConsole();
  });

  /** Directly exercises `createClient` against the current `fetchMock` and
   * asserts the thrown `ApiError`'s message never contains the token — the
   * invariant documented at the top of src/api/client.ts. */
  async function assertClientErrorHasNoToken(): Promise<void> {
    const client = createClient({ baseUrl: BASE_URL, token: TOKEN });
    let threw = false;
    try {
      await client.get('/user');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(TOKEN);
    }
    expect(threw).toBe(true);
  }

  it('scenario 2a: a 401 (auth) cycle leaks the token nowhere (storage, snapshot, console)', async () => {
    const inst = instance({ id: 'i_sectest_auth' });
    await setUp(inst, settings());
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(BASE_URL).origin);
      expect(init?.method === undefined || init.method === 'GET').toBe(true);
      return errorResponse(401);
    });

    const { poller } = wirePoller();
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.error?.kind).toBe('auth');
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);

    const syncDump = await snapshotStorage('sync');
    const localDump = await snapshotStorage('local');
    expect(JSON.stringify(syncDump)).not.toContain(TOKEN);
    const localWithoutToken = { ...localDump };
    delete localWithoutToken[`token:${inst.id}`];
    expect(JSON.stringify(localWithoutToken)).not.toContain(TOKEN);

    await assertClientErrorHasNoToken();
    assertNoTokenInConsole();
  });

  it('scenario 2b: an unreachable (fetch throws) cycle leaks the token nowhere', async () => {
    const inst = instance({ id: 'i_sectest_unreach' });
    await setUp(inst, settings());
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(BASE_URL).origin);
      expect(init?.method === undefined || init.method === 'GET').toBe(true);
      throw new TypeError('network down');
    });

    const { poller } = wirePoller();
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.error?.kind).toBe('network');
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);

    const syncDump = await snapshotStorage('sync');
    const localDump = await snapshotStorage('local');
    expect(JSON.stringify(syncDump)).not.toContain(TOKEN);
    const localWithoutToken = { ...localDump };
    delete localWithoutToken[`token:${inst.id}`];
    expect(JSON.stringify(localWithoutToken)).not.toContain(TOKEN);

    await assertClientErrorHasNoToken();
    assertNoTokenInConsole();
  });

  it('scenario 2c: a 500 (server) cycle leaks the token nowhere', async () => {
    const inst = instance({ id: 'i_sectest_500' });
    await setUp(inst, settings());
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(BASE_URL).origin);
      expect(init?.method === undefined || init.method === 'GET').toBe(true);
      return errorResponse(500);
    });

    const { poller } = wirePoller();
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.error?.kind).toBe('server');
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(JSON.stringify(snapshot!.sectionErrors)).not.toContain(TOKEN);

    const syncDump = await snapshotStorage('sync');
    const localDump = await snapshotStorage('local');
    expect(JSON.stringify(syncDump)).not.toContain(TOKEN);
    const localWithoutToken = { ...localDump };
    delete localWithoutToken[`token:${inst.id}`];
    expect(JSON.stringify(localWithoutToken)).not.toContain(TOKEN);

    await assertClientErrorHasNoToken();
    assertNoTokenInConsole();
  });

  it('scenario 4: checkConnection reports (success and failure) never contain the token', async () => {
    // Success: /user, /version, /user/orgs, an org-runs probe, /notifications.
    const successRoutes: Route[] = [
      { match: (u) => path(u) === '/user', handler: () => ({ id: 1, login: 'me' }) },
      { match: (u) => path(u) === '/version', handler: () => ({ version: '1.24.0' }) },
      { match: (u) => path(u) === '/user/orgs', handler: () => [] },
      { match: (u) => path(u) === '/notifications', handler: () => [] },
    ];
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(BASE_URL).origin);
      expect(init?.method === undefined || init.method === 'GET').toBe(true);
      const route = successRoutes.find((r) => r.match(url));
      if (!route) {
        return errorResponse(404);
      }
      return jsonResponse(route.handler(url));
    });

    const okReport = await checkConnection(BASE_URL, TOKEN);
    expect(JSON.stringify(okReport)).not.toContain(TOKEN);

    // Failure: 401 on the very first probe.
    fetchMock.mockImplementation(async () => errorResponse(401));
    const failReport = await checkConnection(BASE_URL, TOKEN);
    expect(JSON.stringify(failReport)).not.toContain(TOKEN);

    assertNoTokenInConsole();
  });

  it('scenario 5: no fetch() call outside src/api/client.ts, and no non-GET `method:` in src/**', () => {
    const srcRoot = join(__dirname, '..', '..', 'src');
    const files = listTsFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    const clientPath = join(srcRoot, 'api', 'client.ts');
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const code = stripComments(content);
      if (file !== clientPath) {
        expect(/(?<![.\w])fetch\s*\(/.test(code)).toBe(false);
      }
      const methodMatches = [...code.matchAll(/\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/g)];
      for (const m of methodMatches) {
        expect(m[1]).toBe('GET');
      }
    }
  });
});

// Strips line and block comments (good enough for this repo's TS — no
// template-literal edge cases containing "//" in the files under test).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}
