// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// ("Alarms"), spec.md US6 (FR-040/FR-050/FR-060).
//
// Exercises the same effects `src/entrypoints/background.ts`'s
// `settings-changed` message handler drives, but through
// `src/background/router.ts`'s `createRouter` (T071) -- the actual
// production wiring, not a hand-rolled copy of it -- via `fireSettingsChanged`
// below. Since T071 (L1 fix), `settings-changed` also triggers an immediate
// `runCycle('base')` (a settings change like narrowing `scope` must not leave
// stale data visible until the next alarm), so the real poller and a fetch
// mock are wired through the router too.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL
// pathname+query (like tests/integration/poller-prs.test.ts and
// poller-runs.test.ts). No real HTTP is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { checkConnection } from '../../src/background/connection';
import { createNotifier } from '../../src/background/notifier';
import { createPoller, type Poller } from '../../src/background/poller';
import { applyBadge } from '../../src/background/poller/badge';
import { prsSection } from '../../src/background/poller/prs';
import { runsSection } from '../../src/background/poller/runs';
import { createRouter, type Router } from '../../src/background/router';
import { POLL_ALARM_NAME, createHeartbeatLoop, ensurePollAlarm, reschedule } from '../../src/background/schedule';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';

// -- fixed test world: me (login 'me'); orgs acme (kept) + umbrella
// (excluded via scope.excludeOrgs); repos acme/keep (kept), acme/drop
// (pinned, excluded via scope.excludeRepos), umbrella/web (excluded via its
// org). --

function instance(): Instance {
  return {
    id: 'i_settingstest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: false, orgs: ['acme', 'umbrella'], missingScopes: [] },
  };
}

type Handler = (url: URL) => unknown;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function makeFetchMock(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = routes.find((r) => r.match(url));
    if (!route) {
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    return jsonResponse(route.handler(url));
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope },
    notify: { ...DEFAULT_SETTINGS.notify, ...overrides.notify },
  };
}

function issueFor(id: number, number: number, repoFullName: string): unknown {
  return {
    id,
    number,
    title: `PR #${number}`,
    user: { login: 'bob' },
    updated_at: '2026-09-26T06:00:00Z',
    html_url: `${BASE_URL}/${repoFullName}/pulls/${number}`,
    repository: { full_name: repoFullName },
    pull_request: { draft: false },
  };
}

function runsResponse(runs: unknown[]): { total_count: number; workflow_runs: unknown[] } {
  return { total_count: runs.length, workflow_runs: runs };
}

/** Minimal `ApiActionWorkflowRun`-shaped object (only the fields the domain reads). */
function mkRun(id: number, repoFullName: string): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    run_number: 1,
    status: 'in_progress',
    conclusion: undefined,
    event: 'push',
    head_branch: 'main',
    head_sha: `sha${id}`,
    display_title: 'push: main',
    path: 'ci.yml@refs/heads/main',
    actor: { login: 'me' },
    trigger_actor: { login: 'me' },
    repository: { full_name: repoFullName },
    html_url: `${BASE_URL}/${repoFullName}/actions/runs/${id}`,
    started_at: '2026-09-26T09:00:00Z',
    completed_at: undefined,
    pull_requests: [],
  };
}

/** Routes covering both prsSection and runsSection for the fixed test world above. */
function baseRoutes(): Route[] {
  return [
    // A5/A6: no review/created PRs in this world.
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('review_requested') === 'true',
      handler: () => [],
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('created') === 'true',
      handler: () => [],
    },
    // A7: owner=<org>/owner=<login> "other" candidates.
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'acme',
      handler: () => [issueFor(101, 1, 'acme/keep'), issueFor(102, 2, 'acme/drop')],
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'umbrella',
      handler: () => [issueFor(103, 3, 'umbrella/web')],
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'me',
      handler: () => [],
    },
    // A8: pull heads -- kept empty, this test doesn't exercise CI merge.
    { match: (u) => path(u) === '/repos/acme/keep/pulls', handler: () => [] },
    { match: (u) => path(u) === '/repos/acme/drop/pulls', handler: () => [] },
    { match: (u) => path(u) === '/repos/umbrella/web/pulls', handler: () => [] },
    // A10/A11/A15 per org.
    {
      match: (u) => path(u) === '/orgs/acme/actions/runs' && u.searchParams.getAll('status').length > 0,
      handler: () => runsResponse([]),
    },
    {
      match: (u) =>
        path(u) === '/orgs/acme/actions/runs' &&
        u.searchParams.getAll('status').length === 0 &&
        u.searchParams.get('actor') === null,
      handler: () => runsResponse([]),
    },
    {
      match: (u) => path(u) === '/orgs/acme/actions/runs' && u.searchParams.get('actor') !== null,
      handler: () => runsResponse([]),
    },
    {
      match: (u) => path(u) === '/orgs/umbrella/actions/runs' && u.searchParams.getAll('status').length > 0,
      handler: () => runsResponse([mkRun(9100, 'umbrella/web')]),
    },
    {
      match: (u) =>
        path(u) === '/orgs/umbrella/actions/runs' &&
        u.searchParams.getAll('status').length === 0 &&
        u.searchParams.get('actor') === null,
      handler: () => runsResponse([]),
    },
    {
      match: (u) => path(u) === '/orgs/umbrella/actions/runs' && u.searchParams.get('actor') !== null,
      handler: () => runsResponse([]),
    },
    // A12: pinned repo acme/drop's own runs.
    { match: (u) => path(u) === '/repos/acme/drop/actions/runs', handler: () => runsResponse([mkRun(9000, 'acme/drop')]) },
    // A13: workflow names -- irrelevant here, always empty.
    { match: (u) => /\/actions\/workflows$/.test(path(u)), handler: () => ({ total_count: 0, workflows: [] }) },
  ];
}

async function setUp(settings: Settings, pins: { owner: string; name: string }[] = []): Promise<void> {
  const inst = instance();
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(settings);
  await storage.setPins(inst.id, pins);
}

/** Builds the real `createRouter` wiring (T071) around a given `poller`. */
function makeRouter(poller: Poller, now: () => Date): Router {
  async function afterCycle(): Promise<void> {
    const { instances, activeInstanceId } = await storage.getInstances();
    const inst = instances.find((candidate) => candidate.id === activeInstanceId);
    if (!inst) return;
    const [settings, snapshot] = await Promise.all([storage.getSettings(), storage.getSnapshot(inst.id)]);
    await applyBadge(settings, snapshot ?? null, now());
  }
  return createRouter({
    poller,
    notifier: createNotifier({ now }),
    afterCycle,
    reschedule,
    ensurePollAlarm,
    heartbeat: createHeartbeatLoop({ runFast: () => Promise.resolve() }),
    checkConnection,
    getSettings: storage.getSettings,
    getSnapshot: storage.getSnapshot,
    getInstances: storage.getInstances,
    now,
  });
}

/**
 * Fires the `settings-changed` message through the real router (T071),
 * resolving once `sendResponse` is called -- same effects, same order, as
 * `src/entrypoints/background.ts`'s registered listener: `poller.resume()`
 * -> re-read settings -> `reschedule(settings.pollIntervalSec)` ->
 * `poller.runCycle('base')` -> re-apply the badge from the fresh snapshot.
 */
async function fireSettingsChanged(poller: Poller, now: Date): Promise<void> {
  const router = makeRouter(poller, () => now);
  await new Promise<void>((resolve) => {
    router.onMessage({ type: 'settings-changed' }, {}, () => resolve());
  });
}

describe('settings-apply integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    vi.spyOn(browser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
  });

  it('T053a: changing settings.pollIntervalSec then firing settings-changed reschedules the poll alarm', async () => {
    await setUp(settingsWith({ pollIntervalSec: 60 }));
    const alarmsCreateSpy = vi.spyOn(browser.alarms, 'create').mockResolvedValue(undefined);

    // Initial schedule, as background.ts does once on load.
    await reschedule((await storage.getSettings()).pollIntervalSec);
    expect(alarmsCreateSpy).toHaveBeenLastCalledWith(POLL_ALARM_NAME, { periodInMinutes: 1 });

    const poller = createPoller({ sections: [], clientFactory: createClient });
    await storage.setSettings(settingsWith({ pollIntervalSec: 1800 }));
    await fireSettingsChanged(poller, new Date('2026-09-26T10:00:00Z'));

    expect(alarmsCreateSpy).toHaveBeenLastCalledWith(POLL_ALARM_NAME, { periodInMinutes: 30 });
  });

  it("T053b: adding a repo to scope.excludeRepos / an org to scope.excludeOrgs drops its PRs+runs and stops requesting that org's run endpoints on the next cycle", async () => {
    await setUp(settingsWith(), [{ owner: 'acme', name: 'drop' }]);
    fetchMock.mockImplementation(makeFetchMock(baseRoutes()).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const inst = instance();
    let snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();
    const prKey = (pr: { repo: { owner: string; name: string }; number: number }): string =>
      `${pr.repo.owner}/${pr.repo.name}#${pr.number}`;
    expect(snapshot!.prs.map(prKey)).toEqual(
      expect.arrayContaining(['acme/keep#1', 'acme/drop#2', 'umbrella/web#3'])
    );
    expect(snapshot!.runs.some((r) => r.id === 9000)).toBe(true); // acme/drop's own run
    expect(snapshot!.runs.some((r) => r.id === 9100)).toBe(true); // umbrella org run

    // Apply the settings-changed path with acme/drop + umbrella now excluded.
    await storage.setSettings(
      settingsWith({ scope: { excludeRepos: ['acme/drop'], excludeOrgs: ['umbrella'], includeRepos: [] } })
    );
    await fireSettingsChanged(poller, new Date('2026-09-26T10:01:00Z'));

    fetchMock.mockClear();
    await poller.runCycle('base');

    const secondCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(String(u)));
    expect(secondCalls.some((u) => path(u) === '/orgs/umbrella/actions/runs')).toBe(false); // excludeOrgs: no org endpoints requested
    expect(secondCalls.some((u) => path(u) === '/repos/acme/drop/actions/runs')).toBe(false); // excludeRepos: pinned repo's run source dropped

    snapshot = await storage.getSnapshot(inst.id);
    const prKeys = snapshot!.prs.map(prKey);
    expect(prKeys).toContain('acme/keep#1');
    expect(prKeys).not.toContain('acme/drop#2'); // excludeRepos
    expect(prKeys).not.toContain('umbrella/web#3'); // excludeOrgs
    expect(snapshot!.runs.some((r) => r.id === 9000)).toBe(false); // excludeRepos
    expect(snapshot!.runs.some((r) => r.id === 9100)).toBe(false); // excludeOrgs
  });

  it('T053c: a badgeMode change takes effect immediately on settings-changed, which also runs a fresh poll cycle (T071/L1)', async () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    await setUp(settings, [{ owner: 'acme', name: 'drop' }]);
    fetchMock.mockImplementation(makeFetchMock(baseRoutes()).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const inst = instance();
    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.counts.reviews).toBe(0); // no review-group PRs in this fixture world
    expect(snapshot!.counts.activeMine).toBe(2); // acme/drop (9000) + umbrella/web (9100), both actor 'me', in_progress

    const setBadgeTextSpy = vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    await applyBadge(settings, snapshot!, new Date('2026-09-26T10:00:00Z'));
    expect(setBadgeTextSpy).toHaveBeenLastCalledWith({ text: '' }); // reviews mode, 0 reviews -> empty badge

    setBadgeTextSpy.mockClear();
    fetchMock.mockClear();
    await storage.setSettings(settingsWith({ badgeMode: 'builds' }));
    await fireSettingsChanged(poller, new Date('2026-09-26T10:00:30Z'));

    // T071/L1 fix: settings-changed now also triggers an immediate
    // `runCycle('base')` so stale data (e.g. from a narrowed `scope`) never
    // lingers until the next alarm -- the same `baseRoutes()` fixture world
    // is re-fetched here.
    expect(fetchMock).toHaveBeenCalled();
    expect(setBadgeTextSpy).toHaveBeenLastCalledWith({ text: '2' }); // builds mode reflects activeMine immediately
  });
});
