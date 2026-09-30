// Background message/alarm/lifecycle router (review T071: M4+L1+L4).
// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// ("Сообщения окно/настройки → фон", "Alarms").
//
// This module owns ALL wiring between `browser.runtime.onMessage`,
// `browser.alarms.onAlarm`, `browser.runtime.onStartup` and
// `browser.notifications.onClicked` on one side, and the poller/notifier/
// schedule building blocks on the other. `src/entrypoints/background.ts`
// only builds the concrete deps and registers these four handlers; every
// test that used to hand-roll this wiring drives it through `createRouter`
// instead (`tests/integration/router.test.ts`,
// `tests/integration/settings-apply.test.ts`).
//
// Error-handling contract (M4): every handler catches its own errors.
// - `onMessage`: `sendResponse` is ALWAYS called, exactly once, even when a
//   dependency throws (e.g. `poller.runCycle` rejecting with a plain
//   `TypeError` — not just `ApiError`). On failure it responds
//   `{ ok: false, error: 'internal' }` — never partial data, never a token.
//   Handlers that trigger a poll cycle always run `afterCycle` in a
//   `finally`, so the badge/fast-alarm stay in sync even when the cycle
//   itself failed.
// - `onAlarm`/`onStartup`/`onNotificationClicked` can't reply to anyone; they
//   just must never produce an unhandled promise rejection.
//
// L1: `settings-changed` and service-worker startup used to only reschedule
// the alarm/reapply the badge from the *existing* snapshot — a settings
// change (e.g. narrowing `scope`) could leave stale data visible until the
// next alarm fired. Both now trigger an immediate `runCycle('base')`:
// `settings-changed` always (the user just asked to apply new settings);
// `onStartup` only when the active instance's snapshot is missing or older
// than the configured poll interval (a fresh snapshot from just before a
// service-worker restart shouldn't trigger a redundant fetch).

import type { ConnectionReport, Instance, Settings, Snapshot } from '../domain/types';
import { isBackgroundMessage } from './messages';
import type { Notifier } from './notifier';
import type { PollMode, Poller } from './poller';
import { HEARTBEAT_FAST_SEC, POLL_ALARM_NAME, POLL_FAST_ALARM_NAME, type HeartbeatLoop } from './schedule';

/** Matches `checkConnection`'s signature (src/background/connection.ts) without importing it directly, so tests can inject a fake. */
export type CheckConnectionFn = (
  baseUrl: string,
  token: string,
  options?: { persist?: boolean }
) => Promise<ConnectionReport>;

export interface RouterDeps {
  poller: Poller;
  notifier: Notifier;
  /** Common post-cycle bookkeeping (badge + `poll-fast` alarm state). */
  afterCycle(): Promise<void>;
  reschedule(pollIntervalSec: number): Promise<void>;
  ensurePollAlarm(pollIntervalSec: number): Promise<void>;
  heartbeat: HeartbeatLoop;
  checkConnection: CheckConnectionFn;
  getSettings(): Promise<Settings>;
  getSnapshot(instanceId: string): Promise<Snapshot | null | undefined>;
  getInstances(): Promise<{ instances: Instance[]; activeInstanceId?: string }>;
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface Router {
  /** Registered on `browser.runtime.onMessage`. Returns `true` for every
   * recognized message type (all responses are async). */
  onMessage(message: unknown, sender: unknown, sendResponse: (response?: unknown) => void): boolean | undefined;
  /** Registered on `browser.alarms.onAlarm`. */
  onAlarm(alarm: { name: string }): void;
  /** Registered on `browser.runtime.onStartup` (and called once eagerly from
   * `defineBackground` to cover the "extension just loaded" case, which
   * `onStartup` alone doesn't fire for). */
  onStartup(): void;
  /** Registered on `browser.notifications.onClicked`. */
  onNotificationClicked(notificationId: string): void;
}

/** Page heartbeats come every 5s; ignore anything closer than this. */
const PAGE_FAST_MIN_GAP_MS = 4000;

const INTERNAL_ERROR_RESPONSE = { ok: false, error: 'internal' } as const;

export function createRouter(deps: RouterDeps): Router {
  const nowFn = deps.now ?? (() => new Date());

  async function runCycleAndAfter(mode: PollMode): Promise<void> {
    try {
      await deps.poller.runCycle(mode);
    } finally {
      await deps.afterCycle();
    }
  }

  /** `onAlarm`'s two branches: never rethrows, never lets `afterCycle` be
   * skipped by a cycle failure. */
  async function runCycleSafely(mode: PollMode): Promise<void> {
    try {
      await runCycleAndAfter(mode);
    } catch {
      // Alarms have no listener to report back to — swallow (already
      // recorded in the snapshot/PollState by the poller itself when it's
      // an ApiError; a non-ApiError throw here would otherwise be an
      // unhandled rejection).
    }
  }

  /**
   * T043: light 5s cycle for the visible dashboard page. Only when the
   * active instance's snapshot says I have active builds; the poller shares
   * an in-flight cycle, and `PAGE_FAST_MIN_GAP_MS` keeps two open pages (or a
   * page + a retry) from stacking requests.
   */
  let lastPageFastAt = Number.NEGATIVE_INFINITY;
  async function runPageFast(): Promise<void> {
    const startedAt = nowFn().getTime();
    if (startedAt - lastPageFastAt < PAGE_FAST_MIN_GAP_MS) return;
    const { instances, activeInstanceId } = await deps.getInstances();
    const instance = instances.find((candidate) => candidate.id === activeInstanceId);
    if (!instance) return;
    const snapshot = await deps.getSnapshot(instance.id);
    if ((snapshot?.counts.activeMine ?? 0) <= 0) return;
    lastPageFastAt = startedAt;
    await runCycleSafely('page-fast');
  }

  function onAlarm(alarm: { name: string }): void {
    if (alarm.name === POLL_ALARM_NAME) {
      void runCycleSafely('base');
    } else if (alarm.name === POLL_FAST_ALARM_NAME) {
      void runCycleSafely('fast');
    }
  }

  function onStartup(): void {
    void (async () => {
      try {
        const settings = await deps.getSettings();
        await deps.ensurePollAlarm(settings.pollIntervalSec);

        const { instances, activeInstanceId } = await deps.getInstances();
        const instance = instances.find((candidate) => candidate.id === activeInstanceId);

        let stale = true;
        if (instance) {
          const snapshot = await deps.getSnapshot(instance.id);
          if (snapshot?.fetchedAt) {
            const ageMs = nowFn().getTime() - new Date(snapshot.fetchedAt).getTime();
            stale = ageMs >= settings.pollIntervalSec * 1000;
          }
        }

        if (stale) {
          await runCycleAndAfter('base');
        }
      } catch {
        // Startup has no listener to report back to either.
      }
    })();
  }

  function onNotificationClicked(notificationId: string): void {
    void deps.notifier.handleClick(notificationId).catch(() => {
      // Never let a notifier bug surface as an unhandled rejection here.
    });
  }

  function onMessage(
    message: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void
  ): boolean | undefined {
    if (!isBackgroundMessage(message)) {
      return undefined;
    }

    switch (message.type) {
      case 'refresh': {
        void (async () => {
          try {
            await runCycleAndAfter('base');
            sendResponse({ ok: true });
          } catch {
            sendResponse(INTERNAL_ERROR_RESPONSE);
          }
        })();
        return true;
      }
      case 'settings-changed': {
        void (async () => {
          try {
            await deps.poller.resume();
            const settings = await deps.getSettings();
            await deps.reschedule(settings.pollIntervalSec);
            try {
              await deps.poller.runCycle('base');
            } finally {
              await deps.afterCycle();
            }
            sendResponse({ ok: true });
          } catch {
            sendResponse(INTERNAL_ERROR_RESPONSE);
          }
        })();
        return true;
      }
      case 'check-connection': {
        void deps
          .checkConnection(message.baseUrl, message.token, { persist: message.persist ?? true })
          .then((report) => sendResponse(report))
          .catch(() => sendResponse(INTERNAL_ERROR_RESPONSE));
        return true;
      }
      case 'popup-heartbeat': {
        try {
          deps.heartbeat.beat();
          if (message.page === true) {
            void runPageFast().catch(() => {});
          }
          sendResponse({ fastSec: HEARTBEAT_FAST_SEC });
        } catch {
          sendResponse(INTERNAL_ERROR_RESPONSE);
        }
        return true;
      }
      default:
        return undefined;
    }
  }

  return { onMessage, onAlarm, onStartup, onNotificationClicked };
}
