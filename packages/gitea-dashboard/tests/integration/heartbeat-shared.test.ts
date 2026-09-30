// Contract: docs/specs/002-fullpage-dashboard/research.md R7, spec.md SC-104
// ("При открытых окне и странице одновременно число запросов к Gitea за 5
// минут не больше, чем при открытом одном окне, более чем на 10%").
//
// T013: popup and dashboard page both send `popup-heartbeat` every ~5s while
// visible. The background side must run a single shared fast-cycle timer
// (`createHeartbeatLoop`, wired through `createRouter`'s 'popup-heartbeat'
// handler) regardless of how many senders are pinging it -- two senders must
// not double the number of `poll('fast')` cycles, and must never leave more
// than one pending fast-cycle timer running at once.
//
// This drives the REAL `createRouter` (src/background/router.ts) and the
// REAL `createHeartbeatLoop` (src/background/schedule.ts) with fake timers
// and a spy `poller.runCycle`; no fakeBrowser/storage/network involved (the
// 'popup-heartbeat' branch only touches `deps.heartbeat`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter, type Router, type RouterDeps } from '../../src/background/router';
import { createHeartbeatLoop, HEARTBEAT_IDLE_TIMEOUT_MS } from '../../src/background/schedule';
import type { ConnectionReport } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

/** Builds a router wired to a real `createHeartbeatLoop`, backed by a spy
 * `runCycle('fast')` so tests can count fast cycles directly. Everything
 * else is an inert stub -- only the 'popup-heartbeat' message path is
 * exercised here. */
function makeRouter(): { router: Router; runCycle: ReturnType<typeof vi.fn> } {
  const runCycle = vi.fn().mockResolvedValue(undefined);
  const afterCycle = vi.fn().mockResolvedValue(undefined);
  const heartbeat = createHeartbeatLoop({
    runFast: () => runCycle('fast').then(() => afterCycle()),
  });

  const deps: RouterDeps = {
    poller: { runCycle: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined), isRunning: () => false },
    notifier: { handleCycle: vi.fn().mockResolvedValue(undefined), handleClick: vi.fn().mockResolvedValue(undefined) },
    afterCycle: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    ensurePollAlarm: vi.fn().mockResolvedValue(undefined),
    heartbeat,
    checkConnection: vi.fn().mockResolvedValue({ ok: true, actions: 'org', missingScopes: [], messageKey: 'diag_ok' } satisfies ConnectionReport),
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    getSnapshot: vi.fn().mockResolvedValue(null),
    getInstances: vi.fn().mockResolvedValue({ instances: [], activeInstanceId: undefined }),
  };

  return { router: createRouter(deps), runCycle };
}

function sendHeartbeat(router: Router): void {
  const returned = router.onMessage({ type: 'popup-heartbeat' }, {}, () => {});
  expect(returned).toBe(true);
}

/** Sends a `popup-heartbeat` at each absolute millisecond offset in
 * `events` (must be sorted ascending), advancing fake timers between them,
 * then advances to `totalMs`. Calls `onTick(atMs)` after every heartbeat and
 * after the final advance so callers can sample `vi.getTimerCount()`. */
async function driveHeartbeats(
  router: Router,
  events: number[],
  totalMs: number,
  onTick: (atMs: number) => void
): Promise<void> {
  let now = 0;
  for (const t of events) {
    if (t > totalMs) break;
    if (t > now) {
      await vi.advanceTimersByTimeAsync(t - now);
      now = t;
    }
    sendHeartbeat(router);
    onTick(now);
  }
  if (now < totalMs) {
    await vi.advanceTimersByTimeAsync(totalMs - now);
    now = totalMs;
  }
  onTick(now);
}

/** Popup-only heartbeats every 5s for 60s: t=0,5,...,55. */
function singleSenderEvents(): number[] {
  const events: number[] = [];
  for (let t = 0; t < 60_000; t += 5000) events.push(t);
  return events;
}

/** Popup (t=0,5,...,55) interleaved with the dashboard page (t=2,7,...,57),
 * both every 5s, offset by 2s -- worst case for accidental double timers. */
function dualSenderEvents(): number[] {
  const popup = singleSenderEvents();
  const page: number[] = [];
  for (let t = 2000; t < 60_000; t += 5000) page.push(t);
  return [...popup, ...page].sort((a, b) => a - b);
}

describe('T013 heartbeat shared between popup and dashboard page (SC-104)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two concurrent senders produce (approximately) the same number of fast cycles as one sender over 60s, with at most one pending timer at a time', async () => {
    // Baseline: a single sender (as if only the popup were open).
    const single = makeRouter();
    let singleMaxTimers = 0;
    await driveHeartbeats(single.router, singleSenderEvents(), 60_000, () => {
      singleMaxTimers = Math.max(singleMaxTimers, vi.getTimerCount());
    });
    const singleFastCycles = single.runCycle.mock.calls.length;
    expect(singleFastCycles).toBeGreaterThan(0);

    // `single`'s loop is still alive (its idle timeout hasn't elapsed yet at
    // t=60s) -- clear its leftover timers before starting the next scenario
    // so they can't leak into the next measurement on this shared fake clock.
    vi.clearAllTimers();

    // Two senders (popup + dashboard page) interleaved, same 60s window.
    const dual = makeRouter();
    let dualMaxTimers = 0;
    await driveHeartbeats(dual.router, dualSenderEvents(), 60_000, () => {
      dualMaxTimers = Math.max(dualMaxTimers, vi.getTimerCount());
    });
    const dualFastCycles = dual.runCycle.mock.calls.length;

    // SC-104: not (meaningfully) more requests with both open than with one.
    expect(Math.abs(dualFastCycles - singleFastCycles)).toBeLessThanOrEqual(1);

    // At most one pending fast-cycle timer at any sampled point: the shared
    // heartbeat loop keeps at most a tick timer + an idle timer pending
    // (never more, regardless of the number of senders beating it) -- the
    // dual-sender run must not need more concurrent timers than the
    // single-sender baseline.
    expect(dualMaxTimers).toBeLessThanOrEqual(singleMaxTimers);
    expect(dualMaxTimers).toBeLessThanOrEqual(2);
  });

  it('fast cycles stop within 10s after both senders stop sending heartbeats', async () => {
    const { router, runCycle } = makeRouter();

    await driveHeartbeats(router, dualSenderEvents(), 60_000, () => {});
    const lastBeatAt = 57_000; // last dashboard-page heartbeat in dualSenderEvents()
    const cyclesAtLastBeat = runCycle.mock.calls.length;

    // Nobody sends another heartbeat after t=60_000. Advance past the idle
    // timeout (10s after the LAST heartbeat, i.e. t=67_000) with margin.
    await vi.advanceTimersByTimeAsync(lastBeatAt + HEARTBEAT_IDLE_TIMEOUT_MS + 3000 - 60_000);
    expect(vi.getTimerCount()).toBe(0);
    const cyclesAfterIdle = runCycle.mock.calls.length;

    // Confirm the loop is truly stopped: a further full fast-cycle period
    // elapses with no more heartbeats and no new fast cycles fire.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runCycle.mock.calls.length).toBe(cyclesAfterIdle);
    expect(runCycle.mock.calls.length).toBeGreaterThanOrEqual(cyclesAtLastBeat);
  });
});
