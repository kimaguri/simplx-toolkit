// Contract: docs/specs/002-fullpage-dashboard/research.md R5, data-model.md
// "RunHistoryCache", contracts/page-surface.md "Запросы к Gitea", spec.md
// FR-111/FR-112.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL
// pathname+query (like tests/integration/poller-runs.test.ts). No real HTTP
// is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { loadHistory, loadMore } from '../../src/features/builds/history-loader';
import type { Instance, PullRequest, Settings, Snapshot } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';
const REF_NOW = new Date('2026-09-26T10:00:00Z');

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_histtest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: true, orgs: ['acme'], missingScopes: [] },
    ...overrides,
  };
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope },
  };
}

async function setUp(
  inst: Instance,
  settings: Settings,
  pins: { owner: string; name: string }[] = []
): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(settings);
  await storage.setPins(inst.id, pins);
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
    const body = await route.handler(url);
    return jsonResponse(body, route.status ?? 200);
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function mkRun(id: number, startedAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    run_number: id,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: `sha${id}`,
    display_title: `push #${id}`,
    path: 'ci.yml@refs/heads/main',
    actor: { login: 'alice' },
    trigger_actor: { login: 'alice' },
    repository: { full_name: 'acme/platform' },
    html_url: `https://git.example.test/acme/platform/actions/runs/${id}`,
    started_at: startedAt,
    completed_at: startedAt,
    pull_requests: [],
    ...overrides,
  };
}

function settingsRoute(maxResponseItems: number): Route {
  return { match: (u) => path(u) === '/settings/api', handler: () => ({ max_response_items: maxResponseItems }) };
}

function mkPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 42,
    title: 'my pr',
    author: 'me',
    updatedAt: REF_NOW.toISOString(),
    htmlUrl: 'https://git.example.test/acme/platform/pulls/42',
    draft: false,
    group: 'mine',
    ci: { state: 'none', fetchedAt: REF_NOW.toISOString() },
    ...overrides,
  };
}

function mkSnapshot(prs: PullRequest[]): Snapshot {
  return {
    fetchedAt: REF_NOW.toISOString(),
    prs,
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

describe('history-fetch integration (T020)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('budget: first load caps at 20 requests total (incl. apiSettings), "show more" adds exactly 5, a repeat within 5 min makes 0 requests, and a refetch past the 5 min TTL continues from the cursor (not page 1)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    // Hourly spacing keeps every page well inside the 30d period, so the
    // source never reaches "covered" within any budget used here — every
    // call below is purely a budget/cursor test, not a coverage test.
    const routes: Route[] = [
      settingsRoute(1),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          const startedAt = new Date(REF_NOW.getTime() - page * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(page, startedAt)] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const first = await loadHistory({ period: '30d', now: REF_NOW });
    expect(first.requests).toBe(20); // 1 apiSettings + 19 pages
    expect(first.hasMore).toBe(true);
    expect(first.runs).toHaveLength(19);
    expect(fetchMock.mock.calls).toHaveLength(20);

    fetchMock.mockClear();
    const more = await loadMore({ period: '30d', now: REF_NOW });
    expect(more.requests).toBe(5);
    expect(more.runs).toHaveLength(24);
    const morePages = (fetchMock.mock.calls as [string][])
      .map(([u]) => Number(new URL(u).searchParams.get('page')))
      .filter((p) => !Number.isNaN(p));
    expect(morePages).toEqual([20, 21, 22, 23, 24]);

    fetchMock.mockClear();
    const repeat = await loadHistory({ period: '30d', now: REF_NOW });
    expect(repeat.requests).toBe(0);
    expect(repeat.runs).toHaveLength(24);
    expect(fetchMock.mock.calls).toHaveLength(0);

    fetchMock.mockClear();
    const later = new Date(REF_NOW.getTime() + 6 * 60 * 1000); // past the 5 min TTL
    const resumed = await loadHistory({ period: '30d', now: later });
    expect(resumed.requests).toBe(20); // apiSettings still cached (24h) -> full 20-page budget
    const resumedPages = (fetchMock.mock.calls as [string][])
      .map(([u]) => Number(new URL(u).searchParams.get('page')))
      .filter((p) => !Number.isNaN(p));
    expect(resumedPages).toEqual(Array.from({ length: 20 }, (_, i) => 25 + i)); // continues, doesn't restart at page 1
    expect(fetchMock.mock.calls.some(([u]) => path(new URL(u)) === '/settings/api')).toBe(false);
  });

  it("period 'today' pages back to midnight Almaty (UTC+5), not 24h", async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    // REF_NOW = 15:00 Almaty -> boundary 2026-09-25T19:00Z, 15 hourly pages back.
    const routes: Route[] = [
      settingsRoute(1),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          const startedAt = new Date(REF_NOW.getTime() - page * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(page, startedAt)] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const today = await loadHistory({ period: 'today', now: REF_NOW });
    expect(today.requests).toBe(16); // 1 apiSettings + pages 1..15
    expect(today.hasMore).toBe(false);
    expect(today.runs).toHaveLength(15);
    expect(today.runs.every((r) => r.startedAt! >= '2026-09-25T19:00:00.000Z')).toBe(true);
  });

  it('stops paging once the oldest run on a page is at/before the period start, and reuses that cache for a wider period with 0 extra requests', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    // Daily spacing: the 7d period is exactly covered after page 7.
    const routes: Route[] = [
      settingsRoute(1),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          const startedAt = new Date(REF_NOW.getTime() - page * 24 * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(page, startedAt)] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const sevenDay = await loadHistory({ period: '7d', now: REF_NOW });
    expect(sevenDay.requests).toBe(8); // 1 apiSettings + pages 1..7
    expect(sevenDay.hasMore).toBe(false);
    expect(sevenDay.runs).toHaveLength(7);

    // M5 (review fix, T028): widening the period within the 5 min TTL must
    // keep paging from the cached cursor — the 5 min TTL only protects the
    // *already-answered* period from repeat requests, it must not silently
    // report "done" for a wider period nobody has fetched yet.
    fetchMock.mockClear();
    const thirtyDay = await loadHistory({ period: '30d', now: REF_NOW });
    expect(thirtyDay.requests).toBe(20); // fresh but wider than the 7d already answered -> full budget, no apiSettings re-fetch
    expect(thirtyDay.runs).toHaveLength(27); // 7 cached + 20 new pages (8..27)
    expect(thirtyDay.hasMore).toBe(true); // 27d < 30d requested -> still not covered
    const thirtyDayPages = (fetchMock.mock.calls as [string][])
      .map(([u]) => Number(new URL(u).searchParams.get('page')))
      .filter((p) => !Number.isNaN(p));
    expect(thirtyDayPages).toEqual(Array.from({ length: 20 }, (_, i) => 8 + i)); // continues from the cursor, not page 1

    // A repeat of the *same* (already-answered) 30d period within the TTL
    // still makes 0 requests — freshness still protects against hammering
    // for a period that was just asked about.
    fetchMock.mockClear();
    const thirtyDayRepeat = await loadHistory({ period: '30d', now: REF_NOW });
    expect(thirtyDayRepeat.requests).toBe(0);
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('a single selected branch/event server filter uses its own cache key (separate requests from the unfiltered query)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    const seenBranches: Array<string | null> = [];
    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          seenBranches.push(u.searchParams.get('branch'));
          return { total_count: 2, workflow_runs: [mkRun(1, REF_NOW.toISOString()), mkRun(2, REF_NOW.toISOString())] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const filtered = await loadHistory({ period: '24h', now: REF_NOW, serverFilter: { branch: 'main' } });
    expect(filtered.requests).toBe(2); // apiSettings + 1 page (exhausted: 2 < 50)

    fetchMock.mockClear();
    const unfiltered = await loadHistory({ period: '24h', now: REF_NOW });
    // Different cache key (no branch filter) -> not reused from the filtered call.
    expect(unfiltered.requests).toBe(1); // apiSettings already cached; 1 page
    expect(fetchMock.mock.calls).toHaveLength(1);

    expect(seenBranches).toEqual(['main', null]);
  });

  it('one source failing with 404 is skipped (reported in sourceErrors) while a healthy source still contributes its runs', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(1, REF_NOW.toISOString())] }),
      },
      {
        match: (u) => path(u) === '/repos/acme/platform/actions/runs',
        handler: () => ({}),
        status: 404,
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const result = await loadHistory({ period: '24h', now: REF_NOW });

    expect(result.sourceErrors).toEqual({ 'repo:acme/platform': 'not-found' });
    expect(result.runs.some((r) => r.id === 1)).toBe(true);
  });

  it('a 401 from any source aborts the whole load with an auth ApiError', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    const routes: Route[] = [
      settingsRoute(50),
      { match: (u) => path(u) === '/orgs/acme/actions/runs', handler: () => ({}), status: 401 },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    await expect(loadHistory({ period: '24h', now: REF_NOW })).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'auth',
    });
    // (imported for type-level use in the rejects.toMatchObject cast below)
    void ApiError;
  });

  // ---------------------------------------------------------------------
  // T028 (Phase 8 review fixes)
  // ---------------------------------------------------------------------

  it('H1: a source that is already fully covered still gets a top-up refresh from page 1 once its cache goes stale, so a run created after the last fetch becomes visible ("tomorrow" case)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    let tomorrow = false;
    const routes: Route[] = [
      settingsRoute(1),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          if (tomorrow && page === 1) {
            // A brand new run landed at the top overnight.
            return { total_count: 1, workflow_runs: [mkRun(1000, new Date(REF_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString())] };
          }
          // Once a new run exists, everything that used to be on page N is
          // now on page N+1 — real Gitea Actions pagination shifts this way.
          const effectivePage = tomorrow ? page - 1 : page;
          const startedAt = new Date(REF_NOW.getTime() - effectivePage * 24 * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(effectivePage, startedAt)] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    // Daily spacing: the 7d period is exactly covered after page 7 (same
    // shape as the "stops paging" test above) — hasMore false, not exhausted.
    const first = await loadHistory({ period: '7d', now: REF_NOW });
    expect(first.requests).toBe(8); // 1 apiSettings + pages 1..7
    expect(first.hasMore).toBe(false);
    expect(first.runs.map((r) => r.id)).not.toContain(1000);

    // Past the 5 min TTL ("tomorrow"), request the same 7d window (now
    // shifted a day later) — the source is still fully covered by the old
    // cache, which is exactly the case the old code froze on forever.
    tomorrow = true;
    fetchMock.mockClear();
    const later = new Date(REF_NOW.getTime() + 24 * 60 * 60 * 1000);
    const resumed = await loadHistory({ period: '7d', now: later });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0); // NOT frozen at 0 requests forever
    expect(resumed.runs.some((r) => r.id === 1000)).toBe(true); // the new run is visible
    expect(resumed.hasMore).toBe(false); // still covered — no need to page deeper
  });

  it('M6: loadMore only spends its budget on sources not yet covering the period, skipping an already-covered source entirely', async () => {
    const inst = instance();
    await setUp(inst, settingsWith(), [{ owner: 'acme', name: 'platform' }]);

    const routes: Route[] = [
      settingsRoute(1),
      {
        // Daily spacing: covered after page 7 for a 7d period.
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          const startedAt = new Date(REF_NOW.getTime() - page * 24 * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(1000 + page, startedAt)] };
        },
      },
      {
        // Hourly spacing: never comes close to covering a 7d period.
        match: (u) => path(u) === '/repos/acme/platform/actions/runs',
        handler: (u) => {
          const page = Number(u.searchParams.get('page'));
          const startedAt = new Date(REF_NOW.getTime() - page * 60 * 60 * 1000).toISOString();
          return { total_count: 1, workflow_runs: [mkRun(page, startedAt)] };
        },
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    await loadHistory({ period: '7d', now: REF_NOW });

    fetchMock.mockClear();
    await loadMore({ period: '7d', now: REF_NOW });

    const orgCalls = (fetchMock.mock.calls as [string][]).filter(
      ([u]) => path(new URL(u)) === '/orgs/acme/actions/runs'
    );
    const repoCalls = (fetchMock.mock.calls as [string][]).filter(
      ([u]) => path(new URL(u)) === '/repos/acme/platform/actions/runs'
    );
    expect(orgCalls).toHaveLength(0); // org source already covers 7d -> loadMore must not touch it
    expect(repoCalls).toHaveLength(5); // the whole "show more" budget goes to the source still short of the period
  });

  it('H2 (loader): a failing GET /settings/api (5xx) does not abort the whole load — falls back to the default limit', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());

    const routes: Route[] = [
      { match: (u) => path(u) === '/settings/api', handler: () => ({}), status: 500 },
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(1, REF_NOW.toISOString())] }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const result = await loadHistory({ period: '24h', now: REF_NOW });

    expect(result.runs.some((r) => r.id === 1)).toBe(true);
    expect(result.sourceErrors ?? {}).not.toHaveProperty('org:acme');
  });

  it('M4: a run triggered by another actor on my own open PR is still grouped as "mine"', async () => {
    const inst = instance({ login: 'me' });
    await setUp(inst, settingsWith());
    await storage.setSnapshot(inst.id, mkSnapshot([mkPr({ number: 42, author: 'someone-else' })]));

    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({
          total_count: 1,
          workflow_runs: [
            mkRun(1, REF_NOW.toISOString(), {
              actor: { login: 'ci-bot' },
              trigger_actor: { login: 'ci-bot' },
              pull_requests: [{ number: 42 }],
            }),
          ],
        }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const result = await loadHistory({ period: '24h', now: REF_NOW });

    const run = result.runs.find((r) => r.id === 1);
    expect(run?.mine).toBe(true);
    expect(run?.group).toBe('mine');
  });
});

describe('history-fetch old-shape cache (T054)', () => {
  it('a cached run stored without branch/event/workflow does not throw and comes back with string fields', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([settingsRoute(50), { match: (u) => path(u).endsWith('/actions/runs'), handler: () => ({ total_count: 0, workflow_runs: [] }) }])
    );
    const inst = instance();
    await setUp(inst, settingsWith());
    const startedAt = new Date(REF_NOW.getTime() - 60 * 60 * 1000).toISOString();
    const old = {
      id: 77,
      attempt: 1,
      number: 77,
      repo: { owner: 'acme', name: 'platform' },
      headSha: 'x',
      htmlUrl: 'https://git.example.test/acme/platform/actions/runs/77',
      state: 'success',
      startedAt,
      completedAt: startedAt,
      mine: false,
      group: 'others',
    };
    await storage.setRunHistoryCache(inst.id, 'org:acme', {
      fetchedAt: REF_NOW.toISOString(),
      runs: [old as never],
      nextPage: 2,
      exhausted: true,
      oldestStartedAt: startedAt,
    });
    const result = await loadHistory({ period: '30d', now: REF_NOW });
    const got = result.runs.find((r) => r.id === 77);
    expect(got).toBeDefined();
    expect(got?.branch).toBe('');
    expect(got?.event).toBe('');
    expect(got?.workflow).toBe('');
    expect(got?.actor).toBe('');
    expect(got?.title).toBe('');
  });
});
