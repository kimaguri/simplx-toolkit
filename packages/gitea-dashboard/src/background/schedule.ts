// Alarm scheduling. Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// "Alarms" — `poll` fires every `pollIntervalSec/60` minutes (minimum 0.5,
// i.e. Chrome's alarms floor); `poll-fast` fires every 0.5 min while there
// are active "mine" builds (FR-041, research R10), running only the `runs`
// section (see `Section.fast` in `src/background/poller/index.ts`).
//
// The popup-open case (FR-041: 15-20s while the popup is open) can't use
// `chrome.alarms` at all — its floor is 30s — so it's a plain `setTimeout`
// loop kept alive by the popup's `popup-heartbeat` messages
// (`createHeartbeatLoop`), independent of the `poll-fast` alarm.

import { browser } from 'wxt/browser';

export const POLL_ALARM_NAME = 'poll';
export const POLL_FAST_ALARM_NAME = 'poll-fast';

const MIN_PERIOD_MINUTES = 0.5;
const FAST_ALARM_PERIOD_MINUTES = 0.5;

/** `fastSec` returned to the popup for `popup-heartbeat` (contract: 15-20s). */
export const HEARTBEAT_FAST_SEC = 20;
/** Stop the heartbeat loop this long after the last `beat()` (no more heartbeats). */
export const HEARTBEAT_IDLE_TIMEOUT_MS = 10_000;

/** `periodInMinutes` for the `poll` alarm, given `Settings.pollIntervalSec`. */
export function periodMinutesFor(pollIntervalSec: number): number {
  return Math.max(MIN_PERIOD_MINUTES, pollIntervalSec / 60);
}

/**
 * (Re)creates the `poll` alarm with a period derived from `pollIntervalSec`.
 * Safe to call whenever settings change (FR-040) — `alarms.create` with an
 * existing name replaces it.
 */
export async function reschedule(pollIntervalSec: number): Promise<void> {
  await browser.alarms.create(POLL_ALARM_NAME, {
    periodInMinutes: periodMinutesFor(pollIntervalSec),
  });
}

/**
 * Ensures the `poll` alarm exists with the period derived from
 * `pollIntervalSec`, without unconditionally recreating it. Recreating an
 * existing alarm (`alarms.create`) resets its `scheduledTime`, so calling
 * this on every service-worker start (frequent wakeups: `poll-fast` every
 * 30s, omnibox, clicks) would keep pushing a long-interval base poll back
 * indefinitely, and it might never fire (review M3). Only creates the alarm
 * when it's missing or its period differs from the target; otherwise it's a
 * no-op that leaves the existing `scheduledTime` untouched.
 */
export async function ensurePollAlarm(pollIntervalSec: number): Promise<void> {
  const targetPeriod = periodMinutesFor(pollIntervalSec);
  const existing = await browser.alarms.get(POLL_ALARM_NAME);
  if (existing && existing.periodInMinutes === targetPeriod) {
    return;
  }
  await browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: targetPeriod });
}

/**
 * Creates or clears the `poll-fast` alarm depending on whether there are
 * active "mine" builds (`Snapshot.counts.activeMine`, FR-041). Call after
 * every cycle (base or fast) and after `settings-changed`.
 */
export async function updateFastAlarm(activeMine: number): Promise<void> {
  if (activeMine > 0) {
    await browser.alarms.create(POLL_FAST_ALARM_NAME, {
      periodInMinutes: FAST_ALARM_PERIOD_MINUTES,
    });
  } else {
    await browser.alarms.clear(POLL_FAST_ALARM_NAME);
  }
}

export interface HeartbeatLoop {
  /** Called on every `popup-heartbeat` message. */
  beat(): void;
  /** Stops the loop immediately (e.g. on extension unload in tests). */
  stop(): void;
}

export interface HeartbeatLoopDeps {
  /** Runs one fast cycle (`poller.runCycle('fast')` + badge/alarm refresh). */
  runFast(): void | Promise<void>;
}

/**
 * While the popup is open it sends `popup-heartbeat` roughly every 5s
 * (contracts/extension-surface.md); as long as heartbeats keep arriving,
 * this runs `runFast` every `HEARTBEAT_FAST_SEC` seconds. If no heartbeat
 * arrives for `HEARTBEAT_IDLE_TIMEOUT_MS` (the popup closed), the loop stops
 * itself — no timers keep running in the background past that point.
 *
 * `beat()` is idempotent w.r.t. the tick timer: repeated calls (one per
 * heartbeat) never create more than one pending tick timer.
 */
export function createHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoop {
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleTick(): void {
    tickTimer = setTimeout(() => {
      tickTimer = null;
      void deps.runFast();
      scheduleTick();
    }, HEARTBEAT_FAST_SEC * 1000);
  }

  function stop(): void {
    if (tickTimer !== null) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function beat(): void {
    if (tickTimer === null) {
      scheduleTick();
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(stop, HEARTBEAT_IDLE_TIMEOUT_MS);
  }

  return { beat, stop };
}
