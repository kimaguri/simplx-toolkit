// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// ("Сообщения окно/настройки → фон", "Alarms"). Review T071 (M4+L1+L4).
//
// Exercises `createRouter` with fully fake deps (no fakeBrowser, no real
// poller/schedule/storage) so every branch -- including a dependency
// throwing a *non*-ApiError error -- is cheap to force.

import { describe, expect, it, vi } from 'vitest';
import { createRouter, type RouterDeps } from '../../src/background/router';
import { POLL_ALARM_NAME, POLL_FAST_ALARM_NAME, HEARTBEAT_FAST_SEC } from '../../src/background/schedule';
import type { ConnectionReport, Instance, Settings, Snapshot } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i1',
    baseUrl: 'https://git.example.test',
    login: 'me',
    capabilities: { actions: 'org', notifications: false, orgs: [], missingScopes: [] },
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function snapshotAt(fetchedAt: string): Snapshot {
  return {
    fetchedAt,
    prs: [],
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

interface FakeDeps extends RouterDeps {
  runCycle: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  afterCycleSpy: ReturnType<typeof vi.fn>;
  rescheduleSpy: ReturnType<typeof vi.fn>;
  ensurePollAlarmSpy: ReturnType<typeof vi.fn>;
  handleClickSpy: ReturnType<typeof vi.fn>;
  beatSpy: ReturnType<typeof vi.fn>;
  checkConnectionSpy: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<RouterDeps> = {}): FakeDeps {
  const runCycle = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  const afterCycleSpy = vi.fn().mockResolvedValue(undefined);
  const rescheduleSpy = vi.fn().mockResolvedValue(undefined);
  const ensurePollAlarmSpy = vi.fn().mockResolvedValue(undefined);
  const handleClickSpy = vi.fn().mockResolvedValue(undefined);
  const beatSpy = vi.fn();
  const checkConnectionSpy = vi.fn().mockResolvedValue({
    ok: true,
    actions: 'org',
    missingScopes: [],
    messageKey: 'diag_ok',
  } satisfies ConnectionReport);

  const deps: FakeDeps = {
    poller: { runCycle, resume, isRunning: () => false },
    notifier: { handleCycle: vi.fn().mockResolvedValue(undefined), handleClick: handleClickSpy },
    afterCycle: afterCycleSpy,
    reschedule: rescheduleSpy,
    ensurePollAlarm: ensurePollAlarmSpy,
    heartbeat: { beat: beatSpy, stop: vi.fn() },
    checkConnection: checkConnectionSpy,
    getSettings: vi.fn().mockResolvedValue(settings()),
    getSnapshot: vi.fn().mockResolvedValue(null),
    getInstances: vi.fn().mockResolvedValue({ instances: [instance()], activeInstanceId: 'i1' }),
    now: () => new Date('2026-09-28T10:00:00Z'),
    runCycle,
    resume,
    afterCycleSpy,
    rescheduleSpy,
    ensurePollAlarmSpy,
    handleClickSpy,
    beatSpy,
    checkConnectionSpy,
    ...overrides,
  };
  return deps;
}

/** Drives `router.onMessage` and resolves with whatever `sendResponse` receives. */
function send(router: ReturnType<typeof createRouter>, message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const returned = router.onMessage(message, {}, resolve);
    expect(returned).toBe(true);
  });
}

describe('createRouter: onMessage', () => {
  it('refresh: sendResponse({ok:true}) and afterCycle after a successful cycle', async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    const response = await send(router, { type: 'refresh', reason: 'manual' });
    expect(deps.runCycle).toHaveBeenCalledWith('base');
    expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true });
  });

  it('refresh: runCycle rejecting with a plain TypeError still calls afterCycle and sendResponse (no unhandled rejection, no thrown error, never hangs)', async () => {
    const deps = makeDeps({
      poller: {
        runCycle: vi.fn().mockRejectedValue(new TypeError('boom')),
        resume: vi.fn().mockResolvedValue(undefined),
        isRunning: () => false,
      },
    });
    const router = createRouter(deps);
    const response = await send(router, { type: 'refresh', reason: 'manual' });
    expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: false, error: 'internal' });
  });

  it('refresh: afterCycle itself rejecting still calls sendResponse with a failure, never leaves the popup hanging', async () => {
    const deps = makeDeps({ afterCycle: vi.fn().mockRejectedValue(new Error('badge failed')) });
    const router = createRouter(deps);
    const response = await send(router, { type: 'refresh', reason: 'manual' });
    expect(response).toEqual({ ok: false, error: 'internal' });
  });

  it('settings-changed: resume -> reschedule -> runCycle(base) -> afterCycle, in order, then sendResponse({ok:true})', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.resume.mockImplementation(async () => {
      order.push('resume');
    });
    deps.rescheduleSpy.mockImplementation(async () => {
      order.push('reschedule');
    });
    deps.runCycle.mockImplementation(async () => {
      order.push('runCycle');
    });
    deps.afterCycleSpy.mockImplementation(async () => {
      order.push('afterCycle');
    });
    const router = createRouter(deps);
    const response = await send(router, { type: 'settings-changed' });
    expect(order).toEqual(['resume', 'reschedule', 'runCycle', 'afterCycle']);
    expect(deps.runCycle).toHaveBeenCalledWith('base');
    expect(response).toEqual({ ok: true });
  });

  it('settings-changed: a rejecting dependency still runs afterCycle and responds with a failure', async () => {
    const deps = makeDeps({
      poller: {
        runCycle: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockRejectedValue(new Error('resume failed')),
        isRunning: () => false,
      },
    });
    const router = createRouter(deps);
    const response = await send(router, { type: 'settings-changed' });
    expect(response).toEqual({ ok: false, error: 'internal' });
  });

  it('check-connection: passes persist through and resolves with the report, never a token', async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    const response = await send(router, {
      type: 'check-connection',
      baseUrl: 'https://git.example.test',
      token: 'test-token',
      persist: false,
    });
    expect(deps.checkConnectionSpy).toHaveBeenCalledWith('https://git.example.test', 'test-token', {
      persist: false,
    });
    expect(response).toMatchObject({ ok: true });
    expect(JSON.stringify(response)).not.toContain('test-token');
  });

  it('check-connection: defaults persist to true when omitted', async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    await send(router, { type: 'check-connection', baseUrl: 'https://git.example.test', token: 'test-token' });
    expect(deps.checkConnectionSpy).toHaveBeenCalledWith('https://git.example.test', 'test-token', {
      persist: true,
    });
  });

  it('check-connection: a rejecting checkConnection responds with a failure instead of hanging or throwing', async () => {
    const deps = makeDeps({ checkConnection: vi.fn().mockRejectedValue(new Error('network down')) });
    const router = createRouter(deps);
    const response = await send(router, {
      type: 'check-connection',
      baseUrl: 'https://git.example.test',
      token: 'test-token',
    });
    expect(response).toEqual({ ok: false, error: 'internal' });
  });

  it('popup-heartbeat: beats the heartbeat loop and responds with {fastSec}', async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    const response = await send(router, { type: 'popup-heartbeat' });
    expect(deps.beatSpy).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ fastSec: HEARTBEAT_FAST_SEC });
  });

  it('unrecognized message: returns undefined and never calls sendResponse', () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    const sendResponse = vi.fn();
    const returned = router.onMessage({ type: 'not-a-real-message' }, {}, sendResponse);
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('createRouter: onAlarm', () => {
  it("'poll' alarm runs a base cycle then afterCycle", async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    router.onAlarm({ name: POLL_ALARM_NAME });
    await vi.waitFor(() => {
      expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    });
    expect(deps.runCycle).toHaveBeenCalledWith('base');
  });

  it("'poll-fast' alarm runs a fast cycle then afterCycle", async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    router.onAlarm({ name: POLL_FAST_ALARM_NAME });
    await vi.waitFor(() => {
      expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    });
    expect(deps.runCycle).toHaveBeenCalledWith('fast');
  });

  it('a rejecting cycle on an alarm still runs afterCycle and never throws/unhandled-rejects', async () => {
    const deps = makeDeps({
      poller: {
        runCycle: vi.fn().mockRejectedValue(new TypeError('boom')),
        resume: vi.fn().mockResolvedValue(undefined),
        isRunning: () => false,
      },
    });
    const router = createRouter(deps);
    expect(() => router.onAlarm({ name: POLL_ALARM_NAME })).not.toThrow();
    await vi.waitFor(() => {
      expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('an unrelated alarm name is a no-op', () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    router.onAlarm({ name: 'something-else' });
    expect(deps.runCycle).not.toHaveBeenCalled();
  });
});

describe('createRouter: onStartup', () => {
  it('a fresh snapshot (younger than the poll interval) only ensures the alarm, no cycle', async () => {
    const deps = makeDeps({
      getSettings: vi.fn().mockResolvedValue(settings({ pollIntervalSec: 300 })),
      getSnapshot: vi.fn().mockResolvedValue(snapshotAt('2026-09-28T09:58:00Z')), // 2 min old, interval 5 min
      now: () => new Date('2026-09-28T10:00:00Z'),
    });
    const router = createRouter(deps);
    router.onStartup();
    await vi.waitFor(() => {
      expect(deps.ensurePollAlarmSpy).toHaveBeenCalledWith(300);
    });
    expect(deps.runCycle).not.toHaveBeenCalled();
    expect(deps.afterCycleSpy).not.toHaveBeenCalled();
  });

  it('a stale snapshot (older than the poll interval) ensures the alarm AND runs a cycle', async () => {
    const deps = makeDeps({
      getSettings: vi.fn().mockResolvedValue(settings({ pollIntervalSec: 300 })),
      getSnapshot: vi.fn().mockResolvedValue(snapshotAt('2026-09-28T09:00:00Z')), // 60 min old
      now: () => new Date('2026-09-28T10:00:00Z'),
    });
    const router = createRouter(deps);
    router.onStartup();
    await vi.waitFor(() => {
      expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    });
    expect(deps.ensurePollAlarmSpy).toHaveBeenCalledWith(300);
    expect(deps.runCycle).toHaveBeenCalledWith('base');
  });

  it('a missing snapshot ensures the alarm AND runs a cycle', async () => {
    const deps = makeDeps({
      getSettings: vi.fn().mockResolvedValue(settings({ pollIntervalSec: 300 })),
      getSnapshot: vi.fn().mockResolvedValue(null),
    });
    const router = createRouter(deps);
    router.onStartup();
    await vi.waitFor(() => {
      expect(deps.afterCycleSpy).toHaveBeenCalledTimes(1);
    });
    expect(deps.runCycle).toHaveBeenCalledWith('base');
  });

  it('a rejecting dependency never throws or unhandled-rejects', async () => {
    const deps = makeDeps({ getSettings: vi.fn().mockRejectedValue(new Error('storage down')) });
    const router = createRouter(deps);
    expect(() => router.onStartup()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.runCycle).not.toHaveBeenCalled();
  });
});

describe('createRouter: onNotificationClicked', () => {
  it('delegates to notifier.handleClick', async () => {
    const deps = makeDeps();
    const router = createRouter(deps);
    router.onNotificationClicked('evt-1');
    await vi.waitFor(() => {
      expect(deps.handleClickSpy).toHaveBeenCalledWith('evt-1');
    });
  });

  it('a rejecting handleClick never throws or unhandled-rejects', async () => {
    const deps = makeDeps({ notifier: { handleCycle: vi.fn(), handleClick: vi.fn().mockRejectedValue(new Error('x')) } });
    const router = createRouter(deps);
    expect(() => router.onNotificationClicked('evt-1')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
