import { browser } from 'wxt/browser';
import { createClient } from '../api/client';
import { getInstances, getSettings, getSnapshot } from '../lib/storage';
import { checkConnection } from '../background/connection';
import { createNotifier } from '../background/notifier';
import { createPoller } from '../background/poller';
import { applyBadge } from '../background/poller/badge';
import { notesSection } from '../background/poller/notes';
import { prsSection } from '../background/poller/prs';
import { runsSection } from '../background/poller/runs';
import { registerOmnibox } from '../background/omnibox';
import { createRouter } from '../background/router';
import { createHeartbeatLoop, ensurePollAlarm, reschedule, updateFastAlarm } from '../background/schedule';

/**
 * Re-applies the toolbar badge from the active instance's current
 * settings/snapshot. `applyBadge` is not a poll `Section` (badge.ts), so it
 * must be called explicitly after every cycle and on `settings-changed`
 * (FR-050/FR-051).
 */
async function applyBadgeNow(): Promise<void> {
  const { instances, activeInstanceId } = await getInstances();
  const instance = instances.find((candidate) => candidate.id === activeInstanceId);
  if (!instance) return;
  const [settings, snapshot] = await Promise.all([getSettings(), getSnapshot(instance.id)]);
  await applyBadge(settings, snapshot ?? null, new Date());
}

/**
 * Creates/clears the `poll-fast` alarm from the active instance's current
 * snapshot (`counts.activeMine`, FR-041). Call after every cycle (base or
 * fast) and after `settings-changed` -- a cycle can flip `activeMine` in
 * either direction.
 */
async function syncFastAlarm(): Promise<void> {
  const { instances, activeInstanceId } = await getInstances();
  const instance = instances.find((candidate) => candidate.id === activeInstanceId);
  if (!instance) return;
  const snapshot = await getSnapshot(instance.id);
  await updateFastAlarm(snapshot?.counts.activeMine ?? 0);
}

export default defineBackground(() => {
  const notifier = createNotifier();

  const poller = createPoller({
    // Sections registered: T037 (prs), T043 (runs), T052 (notes). `prs` MUST
    // run before `runs`/`notes`: both read `ctx.merged.prs` (this cycle's
    // PRs) -- `runsSection` to build `myOpenPrs` and to merge
    // `activeMine`/`activeOthers`/`failedOthers` into the `reviews` count
    // `prs` just computed, `notesSection` to filter A14 threads down to my
    // open PRs -- falling back to `ctx.prev` when `prs` hasn't run/succeeded.
    // The poller is fully functional (mutex, backoff, auth-pause) regardless
    // of the registry's contents.
    sections: [prsSection, runsSection, notesSection],
    clientFactory: createClient,
    // T050: diff consecutive snapshots for notifications (US5, FR-061..063)
    // right when the poller has both `prev` and the just-written `next` --
    // reloading `prev` afterward would already see `next`.
    onCycleComplete: async (prev, next, instance) => {
      const settings = await getSettings();
      await notifier.handleCycle(prev, next, instance, settings);
    },
  });

  /** Common post-cycle bookkeeping: badge + `poll-fast` alarm state. */
  async function afterCycle(): Promise<void> {
    await applyBadgeNow();
    await syncFastAlarm();
  }

  // FR-041/research R10: while the popup is open it sends `popup-heartbeat`
  // every ~5s; as long as those keep arriving this runs the `fast` cycle
  // (builds only, `runsSection.fast`) every `HEARTBEAT_FAST_SEC`, faster
  // than the 30s `poll-fast` alarm floor allows. It stops itself ~10s after
  // the last heartbeat (popup closed).
  const heartbeat = createHeartbeatLoop({
    runFast: () => poller.runCycle('fast').then(() => afterCycle()),
  });

  // T071 (M4+L1+L4): all message/alarm/lifecycle wiring lives in
  // `createRouter` -- every handler catches its own errors, always calls
  // `sendResponse` for `onMessage`, and runs `afterCycle` in a `finally`.
  // This entrypoint only builds the concrete deps and registers the four
  // listeners synchronously (required at the top level of the service
  // worker for `browser.runtime.onMessage`/`onStartup` to fire reliably).
  const router = createRouter({
    poller,
    notifier,
    afterCycle,
    reschedule,
    ensurePollAlarm,
    heartbeat,
    checkConnection,
    getSettings,
    getSnapshot,
    getInstances,
  });

  browser.alarms.onAlarm.addListener(router.onAlarm);
  browser.runtime.onMessage.addListener(router.onMessage);
  browser.notifications.onClicked.addListener(router.onNotificationClicked);
  browser.runtime.onStartup.addListener(router.onStartup);

  // `onStartup` only fires on browser/profile startup, not on every
  // service-worker (re)load (extension install/update, SW eviction+wakeup) --
  // run the same "ensure alarm, catch up if stale" logic once eagerly here
  // too so a fresh install/update also gets a poll alarm without waiting for
  // the first `poll-fast`/heartbeat/message wakeup.
  router.onStartup();

  registerOmnibox();
});
