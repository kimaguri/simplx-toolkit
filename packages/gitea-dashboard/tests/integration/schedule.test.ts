// Contract: docs/specs/001-gitea-dashboard/research.md R10, spec.md FR-041,
// contracts/extension-surface.md "Alarms" (`poll-fast`, 0.5 min, only while
// `mode==='fast'`) + "popup-heartbeat" (`{ fastSec }`, fast cycles every
// 15-20s while the popup is open, stopping ~10s after the last heartbeat).
//
// Mirrors tests/integration/settings-apply.test.ts's approach: the
// `background.ts` message/alarm router itself isn't exported, so this
// drives the same building blocks (`schedule.ts`'s `updateFastAlarm` /
// `createHeartbeatLoop` + `poller.runCycle`) in the same order the router
// would, using fakeBrowser + fake timers. No real HTTP is made.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createPoller } from '../../src/background/poller';
import { prsSection } from '../../src/background/poller/prs';
import { runsSection } from '../../src/background/poller/runs';
import {
  POLL_ALARM_NAME,
  POLL_FAST_ALARM_NAME,
  createHeartbeatLoop,
  ensurePollAlarm,
  reschedule,
  updateFastAlarm,
} from '../../src/background/schedule';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';

function instance(): Instance {
  return {
    id: 'i_scheduletest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: false, orgs: ['acme'], missingScopes: [] },
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

/** Routes covering both prsSection and runsSection for a single org 'acme'. */
function baseRoutes(activeRun: unknown[]): Route[] {
  return [
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('review_requested') === 'true',
      handler: () => [],
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('created') === 'true',
      handler: () => [],
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') !== null,
      handler: () => [],
    },
    {
      match: (u) => path(u) === '/orgs/acme/actions/runs' && u.searchParams.getAll('status').length > 0,
      handler: () => runsResponse(activeRun),
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
      handler: () => runsResponse(activeRun),
    },
    { match: (u) => /\/actions\/workflows$/.test(path(u)), handler: () => ({ total_count: 0, workflows: [] }) },
  ];
}

/** Only runsSection's endpoints -- used to prove `prs` does NOT run in fast mode. */
function fastOnlyRunsRoutes(activeRun: unknown[]): Route[] {
  return [
    {
      match: (u) => path(u) === '/orgs/acme/actions/runs' && u.searchParams.getAll('status').length > 0,
      handler: () => runsResponse(activeRun),
    },
    {
      match: (u) => path(u) === '/orgs/acme/actions/runs' && u.searchParams.get('actor') !== null,
      handler: () => runsResponse(activeRun),
    },
    { match: (u) => /\/actions\/workflows$/.test(path(u)), handler: () => ({ total_count: 0, workflows: [] }) },
  ];
}

async function setUp(settings: Settings): Promise<void> {
  const inst = instance();
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(settings);
}

describe('schedule integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('T044a: a cycle leaving activeMine>0 lets updateFastAlarm create poll-fast at 0.5 min', async () => {
    await setUp(settingsWith());
    fetchMock.mockImplementation(makeFetchMock(baseRoutes([mkRun(1, 'acme/platform')])).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(instance().id);
    expect(snapshot!.counts.activeMine).toBe(1);

    await updateFastAlarm(snapshot!.counts.activeMine);
    const alarm = await browser.alarms.get(POLL_FAST_ALARM_NAME);
    expect(alarm).toMatchObject({ periodInMinutes: 0.5 });
  });

  it('T044b: activeMine==0 clears an existing poll-fast alarm', async () => {
    await updateFastAlarm(2);
    expect(await browser.alarms.get(POLL_FAST_ALARM_NAME)).toBeDefined();

    await updateFastAlarm(0);
    expect(await browser.alarms.get(POLL_FAST_ALARM_NAME)).toBeUndefined();
  });

  it("T044c: a 'poll-fast' cycle (mode 'fast') does not run the prs section", async () => {
    await setUp(settingsWith());
    fetchMock.mockImplementation(makeFetchMock(fastOnlyRunsRoutes([mkRun(2, 'acme/platform')])).getMockImplementation()!);

    const poller = createPoller({
      sections: [prsSection, runsSection],
      clientFactory: createClient,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    // No route for `/repos/issues/search` (prs section's A5/A6) is
    // registered above -- if prsSection ran, the fetch mock would throw
    // "unexpected request" inside the client and the cycle would record a
    // `sectionErrors.prs`; if it's skipped, there's no such error at all.
    await poller.runCycle('fast');

    const snapshot = await storage.getSnapshot(instance().id);
    expect(snapshot!.sectionErrors?.prs).toBeUndefined();
    expect(snapshot!.runs.some((r) => r.id === 2)).toBe(true);
    const calls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(String(u)));
    expect(calls.some((u) => path(u) === '/repos/issues/search')).toBe(false);
  });

  it('T044d: settings-changed reschedules the poll alarm with the new period', async () => {
    const alarmsCreateSpy = vi.spyOn(browser.alarms, 'create').mockResolvedValue(undefined);
    await reschedule(60);
    expect(alarmsCreateSpy).toHaveBeenLastCalledWith(POLL_ALARM_NAME, { periodInMinutes: 1 });

    await reschedule(1800);
    expect(alarmsCreateSpy).toHaveBeenLastCalledWith(POLL_ALARM_NAME, { periodInMinutes: 30 });
    // Restore so later tests' `browser.alarms.create` calls actually persist
    // alarms in fakeBrowser (this mock replaced the implementation).
    alarmsCreateSpy.mockRestore();
  });

  it('T070a: ensurePollAlarm does not recreate an alarm with the same period (scheduledTime untouched)', async () => {
    await reschedule(1800); // periodInMinutes: 30
    const before = await browser.alarms.get(POLL_ALARM_NAME);
    expect(before).toMatchObject({ periodInMinutes: 30 });

    const alarmsCreateSpy = vi.spyOn(browser.alarms, 'create');
    await ensurePollAlarm(1800);
    expect(alarmsCreateSpy).not.toHaveBeenCalled();

    const after = await browser.alarms.get(POLL_ALARM_NAME);
    expect(after!.scheduledTime).toBe(before!.scheduledTime);
  });

  it('T070b: ensurePollAlarm creates the alarm when missing', async () => {
    await browser.alarms.clear(POLL_ALARM_NAME);
    expect(await browser.alarms.get(POLL_ALARM_NAME)).toBeUndefined();

    await ensurePollAlarm(1800);
    const alarm = await browser.alarms.get(POLL_ALARM_NAME);
    expect(alarm).toMatchObject({ periodInMinutes: 30 });
  });

  it('T070c: ensurePollAlarm recreates the alarm when the period differs', async () => {
    await reschedule(60); // periodInMinutes: 1
    const before = await browser.alarms.get(POLL_ALARM_NAME);
    expect(before).toMatchObject({ periodInMinutes: 1 });

    const alarmsCreateSpy = vi.spyOn(browser.alarms, 'create');
    await ensurePollAlarm(1800); // periodInMinutes: 30
    expect(alarmsCreateSpy).toHaveBeenCalledWith(POLL_ALARM_NAME, { periodInMinutes: 30 });

    const after = await browser.alarms.get(POLL_ALARM_NAME);
    expect(after).toMatchObject({ periodInMinutes: 30 });
  });

  it('T070d: reschedule always recreates the alarm even with the same period', async () => {
    await reschedule(1800);
    const alarmsCreateSpy = vi.spyOn(browser.alarms, 'create').mockResolvedValue(undefined);
    await reschedule(1800);
    expect(alarmsCreateSpy).toHaveBeenCalledWith(POLL_ALARM_NAME, { periodInMinutes: 30 });
  });
});

describe('createHeartbeatLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T044e: runs the fast cycle every 20s while heartbeats keep arriving (<10s apart)', async () => {
    const runFast = vi.fn();
    const loop = createHeartbeatLoop({ runFast });

    loop.beat();
    // Heartbeats every 5s (as tabs.Builds.tsx's every-5s heartbeat would),
    // for a total of 45s -- well past two 20s fast-cycle ticks.
    for (let i = 0; i < 9; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      loop.beat();
    }

    expect(runFast.mock.calls.length).toBeGreaterThanOrEqual(2);
    const callsAtTick = runFast.mock.calls.length;

    // Stop sending heartbeats: after 10s of silence the loop must stop, so
    // no further tick fires even once another 20s elapses.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runFast.mock.calls.length).toBe(callsAtTick);
  });

  it('T044f: repeated beat() calls do not stack timers (single fast-cycle timer)', () => {
    const runFast = vi.fn();
    const loop = createHeartbeatLoop({ runFast });

    loop.beat();
    const countAfterFirstBeat = vi.getTimerCount();
    loop.beat();
    loop.beat();
    loop.beat();
    expect(vi.getTimerCount()).toBe(countAfterFirstBeat);
  });

  it('T044g: stop() clears pending timers', () => {
    const runFast = vi.fn();
    const loop = createHeartbeatLoop({ runFast });
    loop.beat();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
