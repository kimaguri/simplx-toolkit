// T058: `refreshHead` tops up the *head* of an already-cached history page
// (page 1, up to a small per-source cap) ignoring the 5-min `loadHistory`
// freshness window, but skipping a source whose cache was itself refreshed
// less than 60s ago (0 requests) — the interval BuildsHistory.tsx drives
// every 60s / on visibilitychange / once after a mount reload.
// Contract: tasks.md T058, research.md R5 (extended).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHistory, refreshHead } from '../../src/features/builds/history-loader';
import type { Instance, Settings } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';
const REF_NOW = new Date('2026-09-29T10:00:00Z');

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_headrefresh',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: true, orgs: ['acme'], missingScopes: [] },
    ...overrides,
  };
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides, scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope } };
}

async function setUp(inst: Instance, settings: Settings): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(settings);
  await storage.setPins(inst.id, []);
}

type Handler = (url: URL) => unknown;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

function makeFetchMock(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    return jsonResponse(route.handler(url));
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function mkRun(id: number, startedAt: string): Record<string, unknown> {
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
    html_url: `${BASE_URL}/acme/platform/actions/runs/${id}`,
    started_at: startedAt,
    completed_at: startedAt,
    pull_requests: [],
  };
}

function settingsRoute(maxResponseItems: number): Route {
  return { match: (u) => path(u) === '/settings/api', handler: () => ({ max_response_items: maxResponseItems }) };
}

describe('refreshHead (T058)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('right after loadHistory just fetched, refreshHead makes 0 requests (head is <60s fresh)', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());
    let nextId = 100;
    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(nextId, REF_NOW.toISOString())] }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    await loadHistory({ period: '24h', now: REF_NOW });
    fetchMock.mockClear();

    const head = await refreshHead({ period: '24h', now: REF_NOW });

    expect(head.requests).toBe(0);
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('a cache older than 60s gets a bounded (<=2 requests) top-up from page 1 with the new run merged in', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());
    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(1, REF_NOW.toISOString())] }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);
    await loadHistory({ period: '24h', now: REF_NOW });
    fetchMock.mockClear();

    // A new run (id 2) shows up on page 1 more than 60s later.
    const later = new Date(REF_NOW.getTime() + 90 * 1000);
    fetchMock.mockImplementation(
      makeFetchMock([
        settingsRoute(50),
        {
          match: (u) => path(u) === '/orgs/acme/actions/runs',
          handler: () => ({
            total_count: 2,
            workflow_runs: [mkRun(2, later.toISOString()), mkRun(1, REF_NOW.toISOString())],
          }),
        },
      ]).getMockImplementation()!
    );

    const head = await refreshHead({ period: '24h', now: later });

    expect(head.requests).toBeGreaterThan(0);
    expect(head.requests).toBeLessThanOrEqual(2);
    expect(head.runs.map((r) => r.id).sort()).toEqual([1, 2]);
    const runRequests = fetchMock.mock.calls.filter(([u]) => path(new URL(String(u))) === '/orgs/acme/actions/runs');
    expect(runRequests.length).toBeLessThanOrEqual(2);
  });

  it('a page reload with a 3-min-old (still within the 5-min loadHistory TTL) cache still fetches the head', async () => {
    const inst = instance();
    await setUp(inst, settingsWith());
    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(1, REF_NOW.toISOString())] }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);
    await loadHistory({ period: '24h', now: REF_NOW });

    const threeMinLater = new Date(REF_NOW.getTime() + 3 * 60 * 1000);
    // loadHistory itself makes 0 requests (within its 5-min TTL) -- a plain
    // reload of the page alone would otherwise never see anything newer.
    fetchMock.mockClear();
    const reload = await loadHistory({ period: '24h', now: threeMinLater });
    expect(reload.requests).toBe(0);

    fetchMock.mockClear();
    const head = await refreshHead({ period: '24h', now: threeMinLater });
    expect(head.requests).toBeGreaterThan(0);
  });

  it('request budget per refreshHead call stays within 2 requests per source', async () => {
    const inst = instance({ capabilities: { actions: 'org', notifications: true, orgs: ['acme', 'other'], missingScopes: [] } });
    await setUp(inst, settingsWith());
    const routes: Route[] = [
      settingsRoute(50),
      {
        match: (u) => path(u) === '/orgs/acme/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(1, REF_NOW.toISOString())] }),
      },
      {
        match: (u) => path(u) === '/orgs/other/actions/runs',
        handler: () => ({ total_count: 1, workflow_runs: [mkRun(2, REF_NOW.toISOString())] }),
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);
    await loadHistory({ period: '24h', now: REF_NOW });

    const later = new Date(REF_NOW.getTime() + 90 * 1000);
    fetchMock.mockClear();
    const head = await refreshHead({ period: '24h', now: later });

    // 2 sources * up to 2 requests each.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(head.requests).toBeLessThanOrEqual(4);
  });
});
