// T043 (spec.md Clarifications rev.3): adaptive 5s "page-fast" live refresh.
// While the dashboard PAGE is visible (it sends `popup-heartbeat` with
// `page: true` every 5s) and I have active builds, the background runs a
// light `page-fast` cycle: only `orgActiveRuns` (1 request per org). The 20s
// heartbeat loop keeps doing the regular fast cycle. Drives the REAL router,
// poller, runs section and heartbeat loop with a fetch stub and fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createRouter, type Router } from '../../src/background/router';
import { createPoller, type Poller } from '../../src/background/poller';
import { runsSection } from '../../src/background/poller/runs';
import { createHeartbeatLoop } from '../../src/background/schedule';
import { DEFAULT_SETTINGS, type Instance } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';
import runsActiveFixture from '../fixtures/runs-active.json';
import runsMineFixture from '../fixtures/runs-mine.json';
import workflowsFixture from '../fixtures/workflows.json';

const BASE_URL = 'https://git.example.test';
const ORGS = ['acme', 'beta', 'gamma'];

function instance(): Instance {
  return {
    id: 'i_pagefast1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: false, orgs: ORGS, missingScopes: [] },
  };
}

function json(body: unknown): Response {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(activeRuns: unknown[]): void {
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\/api\/v1/, '');
    if (/\/actions\/workflows$/.test(p)) return json(workflowsFixture);
    if (/^\/orgs\/[^/]+\/actions\/runs$/.test(p)) {
      const isActive = url.searchParams.getAll('status').length > 0;
      const isMine = url.searchParams.get('actor') !== null;
      const list = isActive ? activeRuns : isMine ? runsMineFixture.workflow_runs : [];
      return json({ total_count: list.length, workflow_runs: list });
    }
    throw new Error(`unexpected request: ${p}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** An in-progress run started by me (=> counts.activeMine > 0), plus others' active runs. */
const MY_ACTIVE = {
  id: 9001,
  run_attempt: 1,
  run_number: 1,
  status: 'in_progress',
  conclusion: '',
  event: 'push',
  head_branch: 'main',
  head_sha: 'deadbeef',
  display_title: 'push: main',
  path: 'ci.yml@refs/heads/main',
  actor: { login: 'me' },
  trigger_actor: { login: 'me' },
  repository: { full_name: 'acme/platform' },
  html_url: 'https://git.example.test/acme/platform/actions/runs/9001',
  started_at: '2026-09-26T09:59:00Z',
  completed_at: null,
  pull_requests: [],
};
const WITH_MINE = [...runsActiveFixture.workflow_runs, MY_ACTIVE];

function requests(): URL[] {
  return (fetchMock.mock.calls as [string][]).map(([u]) => new URL(u));
}

function isOrgActive(u: URL): boolean {
  return /\/orgs\/[^/]+\/actions\/runs$/.test(u.pathname) && u.searchParams.getAll('status').length > 0;
}

function makeRouter(poller: Poller): Router {
  const heartbeat = createHeartbeatLoop({ runFast: () => poller.runCycle('fast') });
  return createRouter({
    poller,
    notifier: { handleCycle: vi.fn().mockResolvedValue(undefined), handleClick: vi.fn().mockResolvedValue(undefined) },
    afterCycle: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    ensurePollAlarm: vi.fn().mockResolvedValue(undefined),
    heartbeat,
    checkConnection: vi.fn(),
    getSettings: () => storage.getSettings(),
    getSnapshot: (id) => storage.getSnapshot(id),
    getInstances: () => storage.getInstances(),
  });
}

function beat(router: Router, page: boolean): void {
  router.onMessage(page ? { type: 'popup-heartbeat', page: true } : { type: 'popup-heartbeat' }, {}, () => {});
}

async function setUp(activeRuns: unknown[]): Promise<{ router: Router; poller: Poller; inst: Instance }> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
  const inst = instance();
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings({ ...DEFAULT_SETTINGS });
  await storage.setPins(inst.id, []);
  installFetch(activeRuns);
  vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
  vi.spyOn(browser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
  const poller = createPoller({ sections: [runsSection], clientFactory: createClient });
  // Seed: a base cycle so the snapshot knows my active builds.
  await poller.runCycle('base');
  fetchMock.mockClear();
  return { router: makeRouter(poller), poller, inst };
}

describe('T043 page-fast live refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seed sanity: active fixture yields my active builds', async () => {
    const { inst } = await setUp(WITH_MINE);
    expect((await storage.getSnapshot(inst.id))?.counts.activeMine).toBeGreaterThan(0);
  });

  it('page heartbeat with active builds requests ONLY orgActiveRuns, once per org', async () => {
    const { router } = await setUp(WITH_MINE);
    beat(router, true);
    await vi.advanceTimersByTimeAsync(100);
    const reqs = requests();
    expect(reqs).toHaveLength(ORGS.length);
    expect(reqs.every(isOrgActive)).toBe(true);
    expect(reqs.map((u) => u.pathname).sort()).toEqual(ORGS.map((o) => `/api/v1/orgs/${o}/actions/runs`).sort());
  });

  it('keeps completed runs and still-active runs that vanished from the active list untouched', async () => {
    const { router, inst } = await setUp(WITH_MINE);
    const before = (await storage.getSnapshot(inst.id))!.runs;
    installFetch([]); // active list now empty
    beat(router, true);
    await vi.advanceTimersByTimeAsync(100);
    const after = (await storage.getSnapshot(inst.id))!.runs;
    expect(after.map((r) => `${r.id}:${r.state}`).sort()).toEqual(before.map((r) => `${r.id}:${r.state}`).sort());
  });

  it('no fast loop when there are no active builds of mine', async () => {
    const { router } = await setUp([]);
    beat(router, true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(requests()).toHaveLength(0);
  });

  it('popup-only heartbeat (no page flag) never triggers page-fast', async () => {
    const { router } = await setUp(WITH_MINE);
    beat(router, false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(requests()).toHaveLength(0);
  });

  it('page heartbeats stop => no requests after the loop idles out (hidden tab sends none)', async () => {
    const { router } = await setUp(WITH_MINE);
    beat(router, true);
    await vi.advanceTimersByTimeAsync(100);
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000 + 20_000); // page hidden: no beats
    // Only the heartbeat loop's own tail (idle timeout 10s => at most 0 ticks at 20s).
    expect(requests().filter(isOrgActive).length).toBeLessThanOrEqual(0);
  });

  it('budget: 3 orgs, 60s of page heartbeats with active builds -> <= 75 requests', async () => {
    const { router } = await setUp(WITH_MINE);
    for (let t = 0; t < 60_000; t += 5000) {
      beat(router, true);
      await vi.advanceTimersByTimeAsync(5000);
    }
    const count = requests().length;
    // 12 page-fast cycles x 3 orgs (36) + 20s loop: 3 cycles x (active+mine) x 3 orgs (18)
    expect(count).toBeGreaterThanOrEqual(36);
    expect(count).toBeLessThanOrEqual(75);
  });
});
