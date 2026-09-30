// Contract: docs/specs/001-gitea-dashboard/research.md R1/R4-R6/R10,
// contracts/gitea-api.md A10-A13/A15, data-model.md ("Run",
// "workflows:<instanceId>"), spec.md SC-008/SC-009.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL
// pathname+query (like tests/integration/poller-prs.test.ts). No real HTTP
// is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createPoller } from '../../src/background/poller';
import { applyBadge } from '../../src/background/poller/badge';
import { prsSection } from '../../src/background/poller/prs';
import { runsSection } from '../../src/background/poller/runs';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

import runsActiveFixture from '../fixtures/runs-active.json';
import runsRecentFixture from '../fixtures/runs-recent.json';
import runsFloodFixture from '../fixtures/runs-flood.json';
import runsMineFixture from '../fixtures/runs-mine.json';
import workflowsFixture from '../fixtures/workflows.json';
import issuesReviewFixture from '../fixtures/issues-search-review.json';
import issuesCreatedFixture from '../fixtures/issues-search-created.json';
import pullsOpenFixture from '../fixtures/pulls-open.json';
import statusSuccessFixture from '../fixtures/status-success.json';
import statusEmptyFixture from '../fixtures/status-empty.json';

const BASE_URL = 'https://git.example.test';

// -- fixed test world (fixtures/README.md): me (id 1), alice (2), bob (3);
// org acme (10); repos acme/platform, acme/core, umbrella/web. --

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_runstest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: true, orgs: ['acme'], missingScopes: [] },
    ...overrides,
  };
}

type Handler = (url: URL) => unknown | Promise<unknown>;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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
    // Awaited even for error statuses (whose body the client never reads)
    // so an async handler's side effects — e.g. simulating a concurrent
    // storage write mid-cycle — are guaranteed to land before this call
    // resolves.
    const body = await route.handler(url);
    return jsonResponse(body, route.status ?? 200);
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function runsResponse(runs: unknown[]): { total_count: number; workflow_runs: unknown[] } {
  return { total_count: runs.length, workflow_runs: runs };
}

/** Minimal `ApiActionWorkflowRun`-shaped object (only the fields the domain reads). */
function mkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    run_attempt: 1,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: 'deadbeef',
    display_title: 'push: main',
    path: 'ci.yml@refs/heads/main',
    actor: { login: 'alice' },
    trigger_actor: { login: 'alice' },
    repository: { full_name: 'acme/platform' },
    html_url: 'https://git.example.test/acme/platform/actions/runs/1',
    started_at: '2026-09-26T09:00:00Z',
    completed_at: '2026-09-26T09:05:00Z',
    pull_requests: [],
    ...overrides,
  };
}

function orgRunsRoute(org: string, handlerByKind: {
  active: Handler;
  recent: Handler;
  mine: Handler;
}): Route[] {
  return [
    {
      match: (u) => path(u) === `/orgs/${org}/actions/runs` && u.searchParams.getAll('status').length > 0,
      handler: handlerByKind.active,
    },
    {
      match: (u) =>
        path(u) === `/orgs/${org}/actions/runs` &&
        u.searchParams.getAll('status').length === 0 &&
        u.searchParams.get('actor') === null,
      handler: handlerByKind.recent,
    },
    {
      match: (u) => path(u) === `/orgs/${org}/actions/runs` && u.searchParams.get('actor') !== null,
      handler: handlerByKind.mine,
    },
  ];
}

function repoRunsRoute(owner: string, repo: string, handler: Handler, status = 200): Route {
  return { match: (u) => path(u) === `/repos/${owner}/${repo}/actions/runs`, handler, status };
}

function workflowsRoute(): Route {
  return {
    match: (u) => /\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(path(u)),
    handler: () => workflowsFixture,
  };
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope },
  };
}

async function setUp(inst: Instance, settings: Settings, pins: { owner: string; name: string }[] = []): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(settings);
  await storage.setPins(inst.id, pins);
}

describe('poller-runs integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    vi.spyOn(browser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
  });

  it('org mode: exactly 3 requests per org in base cycle, 2 in fast, plus 1 per pinned repo source; workflow names (A13) cached 24h', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => runsResponse(runsActiveFixture.workflow_runs),
        recent: () => runsResponse(runsRecentFixture.workflow_runs),
        mine: () => runsResponse(runsMineFixture.workflow_runs),
      }),
      repoRunsRoute('acme', 'platform', () => runsResponse([mkRun({ id: 8000 })])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const baseCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    const orgCalls = baseCalls.filter((u) => path(u) === '/orgs/acme/actions/runs');
    const repoCalls = baseCalls.filter((u) => path(u) === '/repos/acme/platform/actions/runs');
    const workflowCalls = baseCalls.filter((u) => /\/actions\/workflows$/.test(path(u)));

    expect(orgCalls).toHaveLength(3); // A10 + A11 + A15
    expect(repoCalls).toHaveLength(1); // A12, pinned repo
    // Repos referenced this cycle: acme/platform, acme/core, umbrella/web.
    expect(workflowCalls).toHaveLength(3);

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.runs.some((r) => r.id === 8000)).toBe(true);

    // Second, unchanged cycle: workflow names are cached (TTL 24h) -> no A13.
    fetchMock.mockClear();
    await poller.runCycle('base');
    const secondCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    expect(secondCalls.filter((u) => /\/actions\/workflows$/.test(path(u)))).toHaveLength(0);
    // ...but the run sources themselves are still requested every cycle.
    expect(secondCalls.filter((u) => path(u) === '/orgs/acme/actions/runs')).toHaveLength(3);

    // Fast cycle: only active+mine per org (no orgRecent) + pinned repo.
    fetchMock.mockClear();
    await poller.runCycle('fast');
    const fastCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    const fastOrgCalls = fastCalls.filter((u) => path(u) === '/orgs/acme/actions/runs');
    const fastRepoCalls = fastCalls.filter((u) => path(u) === '/repos/acme/platform/actions/runs');
    expect(fastOrgCalls).toHaveLength(2);
    expect(fastRepoCalls).toHaveLength(1);
  });

  it('a flood of others\' runs on the org endpoints does not push out my runs (A15) nor a pinned repo\'s own runs (A12)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => runsResponse([]),
        recent: () => runsResponse(runsFloodFixture.workflow_runs), // 60 others' runs
        mine: () => runsResponse(runsMineFixture.workflow_runs), // 5 of "me"'s runs
      }),
      repoRunsRoute('acme', 'platform', () => runsResponse([mkRun({ id: 8000, actor: { login: 'me' }, trigger_actor: { login: 'me' } })])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot).toBeDefined();

    const runIds = new Set(snapshot!.runs.map((r) => r.id));
    for (const mineId of [9000, 9001, 9002, 9003, 9004]) {
      expect(runIds.has(mineId)).toBe(true);
    }
    expect(runIds.has(8000)).toBe(true); // pinned repo's own run
    // The flood is present too (merge doesn't drop it), just doesn't crowd out mine/pinned.
    expect(runIds.has(10000)).toBe(true);
  });

  it('a 403 from an org endpoint falls back to repo mode (this cycle and persisted for the next)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => { throw new Error('unused'); },
        recent: () => { throw new Error('unused'); },
        mine: () => { throw new Error('unused'); },
      }).map((r) => ({ ...r, handler: () => ({}), status: 403 })),
      repoRunsRoute('acme', 'platform', () => runsResponse([mkRun({ id: 8000 })])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const firstCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    expect(firstCalls.some((u) => path(u) === '/repos/acme/platform/actions/runs')).toBe(true);

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.sectionErrors?.runs).toBeUndefined(); // fallback, not an error
    expect(snapshot?.runs.some((r) => r.id === 8000)).toBe(true);

    const { instances } = await storage.getInstances();
    expect(instances[0]?.capabilities.actions).toBe('repo');

    // Next cycle: capabilities are now 'repo' -> no /orgs/ requests at all.
    fetchMock.mockClear();
    await poller.runCycle('base');
    const secondCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    expect(secondCalls.some((u) => path(u).startsWith('/orgs/'))).toBe(false);
  });

  it('L6: a concurrent capabilities.orgs write mid-cycle survives this section\'s own actions-downgrade write', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    let concurrentWriteDone = false;
    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        // Simulate another write (e.g. Options save, or notes.ts's own
        // persistCapabilities) landing on `capabilities.orgs` while this
        // section's org requests are in flight — i.e. strictly before this
        // section re-reads+writes `capabilities.actions` below.
        active: async () => {
          const state = await storage.getInstances();
          await storage.setInstances({
            ...state,
            instances: state.instances.map((i) =>
              i.id === inst.id
                ? { ...i, capabilities: { ...i.capabilities, orgs: ['acme', 'newco'] } }
                : i
            ),
          });
          concurrentWriteDone = true;
          return {};
        },
        recent: () => ({}),
        mine: () => ({}),
      }).map((r) => ({ ...r, status: 403 })),
      repoRunsRoute('acme', 'platform', () => runsResponse([mkRun({ id: 9000 })])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    expect(concurrentWriteDone).toBe(true);
    const { instances } = await storage.getInstances();
    // This section's own write (actions -> 'repo') must land...
    expect(instances[0]?.capabilities.actions).toBe('repo');
    // ...without clobbering the concurrent orgs write with a stale copy.
    expect(instances[0]?.capabilities.orgs).toEqual(['acme', 'newco']);
  });

  it('a 404 from a run endpoint sets sectionErrors.runs while prs still updates (SC-008)', async () => {
    const inst = instance();
    const settings = settingsWith({ showOtherPrs: false });
    await setUp(inst, settings, [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      { match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('review_requested') === 'true', handler: () => issuesReviewFixture, status: 200 },
      { match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('created') === 'true', handler: () => issuesCreatedFixture, status: 200 },
      { match: (u) => path(u) === '/repos/acme/platform/pulls', handler: () => pullsOpenFixture.filter((p) => p.number === 12 || p.number === 9) },
      { match: (u) => path(u) === '/repos/acme/core/pulls', handler: () => pullsOpenFixture.filter((p) => p.number === 7) },
      { match: (u) => path(u) === '/repos/me/dotfiles/pulls', handler: () => pullsOpenFixture.filter((p) => p.number === 21) },
      { match: (u) => path(u) === '/repos/acme/platform/commits/d3adbeefcafe00000000000000000000000001/status', handler: () => statusSuccessFixture },
      { match: (u) => path(u) === '/repos/acme/core/commits/d3adbeefcafe00000000000000000000000002/status', handler: () => statusEmptyFixture },
      { match: (u) => path(u) === '/repos/me/dotfiles/commits/d3adbeefcafe00000000000000000000000003/status', handler: () => statusEmptyFixture },
      ...orgRunsRoute('acme', {
        active: () => ({}),
        recent: () => ({}),
        mine: () => ({}),
      }).map((r) => ({ ...r, status: 404 })),
      // Pinned-repo runs 404 too, so the section has no data source to fall
      // back on and the error propagates as a section failure.
      repoRunsRoute('acme', 'platform', () => ({}), 404),
      workflowsRoute(),
    ];

    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.sectionErrors?.runs?.kind).toBe('server'); // not-found -> server
    expect(snapshot?.prs.length).toBeGreaterThan(0); // prs section still updated
    expect(snapshot?.counts.reviews).toBe(2);
  });

  it('H1: a 404 from a pinned repo source is skipped, other run sources still update, no sectionErrors.runs, no backoff (base and fast)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => runsResponse(runsActiveFixture.workflow_runs),
        recent: () => runsResponse(runsRecentFixture.workflow_runs),
        mine: () => runsResponse(runsMineFixture.workflow_runs),
      }),
      repoRunsRoute('acme', 'platform', () => ({}), 404),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.sectionErrors?.runs).toBeUndefined();
    expect(snapshot?.runs.length).toBeGreaterThan(0); // org sources still present

    const pollState = await storage.getPollState(inst.id);
    expect(pollState?.backoffSec).toBe(0);

    // Next cycle isn't skipped by backoff.
    fetchMock.mockClear();
    await poller.runCycle('base');
    const secondCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    expect(secondCalls.some((u) => path(u) === '/orgs/acme/actions/runs')).toBe(true);

    // Same in a fast cycle: org sources ok, pinned repo still 404.
    fetchMock.mockClear();
    await poller.runCycle('fast');
    const fastSnapshot = await storage.getSnapshot(inst.id);
    expect(fastSnapshot?.sectionErrors?.runs).toBeUndefined();
    expect(fastSnapshot?.runs.length).toBeGreaterThan(0);
  });

  it('H1: a 403 on one of two orgs keeps capabilities.actions=org and keeps the healthy org\'s runs', async () => {
    const inst = instance({
      capabilities: { actions: 'org', notifications: true, orgs: ['acme', 'umbrella'], missingScopes: [] },
    });
    await setUp(inst, settingsWith());

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => runsResponse([mkRun({ id: 7000, repository: { full_name: 'acme/platform' } })]),
        recent: () => runsResponse([]),
        mine: () => runsResponse([]),
      }),
      ...orgRunsRoute('umbrella', {
        active: () => ({}),
        recent: () => ({}),
        mine: () => ({}),
      }).map((r) => ({ ...r, status: 403 })),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.sectionErrors?.runs).toBeUndefined();
    expect(snapshot?.runs.some((r) => r.id === 7000)).toBe(true);

    const { instances } = await storage.getInstances();
    expect(instances[0]?.capabilities.actions).toBe('org'); // not downgraded — only one of two orgs is 403
  });

  it('H1: all run sources failing with 500 sets sectionErrors.runs (full outage)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => ({}),
        recent: () => ({}),
        mine: () => ({}),
      }).map((r) => ({ ...r, status: 500 })),
      repoRunsRoute('acme', 'platform', () => ({}), 500),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.sectionErrors?.runs?.kind).toBe('server');
  });

  it('H1: a 401 on one run source still pauses the poller for auth immediately', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
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
        handler: () => ({}),
        status: 401,
      },
      repoRunsRoute('acme', 'platform', () => runsResponse([])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const pollState = await storage.getPollState(inst.id);
    expect(pollState?.pausedForAuth).toBe(true);
    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.error?.kind).toBe('auth');
  });

  it('badge builds mode reflects counts.activeMine after a cycle', async () => {
    const inst = instance();
    const settings = settingsWith({ badgeMode: 'builds' });
    await setUp(inst, settings, [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      ...orgRunsRoute('acme', {
        active: () => runsResponse([mkRun({ id: 5000, actor: { login: 'me' }, trigger_actor: { login: 'me' }, status: 'in_progress', conclusion: undefined })]),
        recent: () => runsResponse([]),
        mine: () => runsResponse([]),
      }),
      repoRunsRoute('acme', 'platform', () => runsResponse([])),
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.counts.activeMine).toBe(1);

    const setBadgeTextSpy = vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    await applyBadge(settings, snapshot!, new Date('2026-09-26T10:00:00Z'));
    expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: '1' });
  });

  it('budget: 3 orgs + 5 pinned repos + 5 own repos stay within SC-009\'s <=35 requests/base-cycle ceiling; ownRepos cached hourly (T066)', async () => {
    const inst = instance({
      userId: 1,
      capabilities: { actions: 'org', notifications: true, orgs: ['acme', 'umbrella', 'walnut'], missingScopes: [] },
    });
    const pins = [
      { owner: 'acme', name: 'p1' },
      { owner: 'acme', name: 'p2' },
      { owner: 'umbrella', name: 'p3' },
      { owner: 'walnut', name: 'p4' },
      { owner: 'other', name: 'p5' },
    ];
    await setUp(inst, settingsWith(), pins);

    const ownReposResponse = {
      ok: true,
      data: ['own1', 'own2', 'own3', 'own4', 'own5'].map((name, i) => ({
        id: 900 + i,
        owner: { login: 'myown' },
        name,
        full_name: `myown/${name}`,
        private: false,
        updated_at: '2026-09-26T09:00:00Z',
        html_url: `https://git.example.test/myown/${name}`,
        has_actions: true,
      })),
    };

    const routes: Route[] = [
      {
        match: (u) => path(u) === '/repos/search' && u.searchParams.get('uid') === '1',
        handler: () => ownReposResponse,
      },
      { match: (u) => /^\/orgs\/[^/]+\/actions\/runs$/.test(path(u)), handler: () => runsResponse([]) },
      { match: (u) => /^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(path(u)), handler: () => runsResponse([]) },
      workflowsRoute(),
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const firstCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));

    // 3 orgs * 3 (A10+A11+A15) + 5 pinned repos * 1 (A12) + 5 own repos
    // (outside the orgs) * 1 (A12) = 19.
    const runsCalls = firstCalls.filter((u) => /\/actions\/runs$/.test(path(u)));
    expect(runsCalls).toHaveLength(19);

    // Plus exactly one A4 ownRepos lookup this cycle.
    const ownReposCalls = firstCalls.filter((u) => path(u) === '/repos/search');
    expect(ownReposCalls).toHaveLength(1);

    expect(firstCalls.length).toBeLessThanOrEqual(35);

    // Second base cycle within the same hour: ownRepos is cached, no new
    // /repos/search call.
    fetchMock.mockClear();
    await poller.runCycle('base');
    const secondCalls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
    expect(secondCalls.filter((u) => path(u) === '/repos/search')).toHaveLength(0);
    expect(secondCalls.filter((u) => /\/actions\/runs$/.test(path(u)))).toHaveLength(19);
  });
});
