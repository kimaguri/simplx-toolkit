// Notification dedup + URL-on-click plumbing (US5, FR-061..063).
// Design: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// "Уведомления" (`notificationId` = event key; URL in `notifUrl:<id>`, TTL
// 24h; `notifications.onClicked` -> tabs.create + clear).
//
// `pickEvents` (src/domain/notify.ts) is the pure decision function; this
// module is the thin browser-API shell around it: load `seen`, call
// `pickEvents`, persist the *new* `seen` before calling
// `browser.notifications.create` for each event (FR-061 — a crash between
// the two must never leave an event un-deduped on the next cycle), then
// remember each event's URL for `handleClick`.

import { browser } from 'wxt/browser';
import { pickEvents, type NotifyEvent } from '../domain/notify';
import { t as defaultT } from '../lib/i18n';
import { getInstances, getNotifUrls, getSeen, setNotifUrls, setSeen } from '../lib/storage';
import type { Instance, SeenEvents, Settings, Snapshot } from '../domain/types';

const NOTIF_URL_TTL_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_ICON_URL = 'icon/128.png';

const EMPTY_SEEN: SeenEvents = { initializedAt: '', keys: {} };

export interface CreateNotifierOptions {
  /** Injectable i18n lookup for tests; defaults to `src/lib/i18n.ts`'s `t`. */
  t?: (key: string, subs?: string | string[]) => string;
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface Notifier {
  /** Called by the poller's `onCycleComplete` hook after every cycle. */
  handleCycle(
    prev: Snapshot | null,
    next: Snapshot,
    instance: Instance,
    settings: Settings
  ): Promise<void>;
  /** Called from `browser.notifications.onClicked`. */
  handleClick(notificationId: string): Promise<void>;
}

async function showNotification(event: NotifyEvent): Promise<void> {
  await browser.notifications.create(event.key, {
    type: 'basic',
    iconUrl: NOTIFICATION_ICON_URL,
    title: event.title,
    message: event.message,
  });
}

export function createNotifier(options: CreateNotifierOptions = {}): Notifier {
  const t = options.t ?? defaultT;
  const nowFn = options.now ?? (() => new Date());

  async function handleCycle(
    prev: Snapshot | null,
    next: Snapshot,
    instance: Instance,
    settings: Settings
  ): Promise<void> {
    if (!instance.login) {
      // No signed-in user identity yet (shouldn't normally happen once an
      // instance is active) — nothing to dedup/notify against.
      return;
    }

    const seen = (await getSeen(instance.id)) ?? EMPTY_SEEN;
    const now = nowFn().toISOString();

    const { events, seen: nextSeen } = pickEvents({
      prevSnapshot: prev ?? undefined,
      snapshot: next,
      seen,
      settings,
      me: instance.login,
      now,
      notes: next.notes,
      t,
    });

    // Persist `seen` BEFORE showing any notification (FR-061): if the
    // service worker dies right after this write, the next cycle still
    // treats these events as already-seen instead of re-firing them.
    await setSeen(instance.id, nextSeen);

    if (events.length === 0) {
      return;
    }

    const urls = await getNotifUrls(instance.id);
    const expiresAt = nowFn().getTime() + NOTIF_URL_TTL_MS;
    for (const event of events) {
      urls[event.key] = { url: event.url, expiresAt };
    }
    await setNotifUrls(instance.id, urls);

    for (const event of events) {
      await showNotification(event);
    }
  }

  async function handleClick(notificationId: string): Promise<void> {
    const { instances, activeInstanceId } = await getInstances();
    const instance = instances.find((candidate) => candidate.id === activeInstanceId);

    try {
      if (instance) {
        const urls = await getNotifUrls(instance.id);
        const entry = urls[notificationId];
        if (entry && entry.expiresAt > nowFn().getTime()) {
          await browser.tabs.create({ url: entry.url });
        }
      }
    } finally {
      await browser.notifications.clear(notificationId);
    }
  }

  return { handleCycle, handleClick };
}
