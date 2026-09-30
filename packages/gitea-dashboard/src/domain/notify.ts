// Notification event selection — pure, no browser APIs here.
// Source of truth: docs/specs/001-gitea-dashboard/data-model.md "SeenEvents" /
// "Уведомление", spec.md US5, FR-060..063.
//
// Dedup keys (data-model.md "SeenEvents"): fail:<runId>:<attempt>,
// ok:<runId>:<attempt>, review:<prId>, note:<threadId>:<updatedAt>.
// A key is written to `seen` as soon as its event is picked (or seeded) —
// callers must persist the returned `seen` *before* actually showing a
// `notifications.create` (FR-061), which is why this function itself never
// calls any browser API and only returns data.

import type { PullRequest, Run, SeenEvents, Settings, Snapshot } from './types';

const MAX_SEEN_KEYS = 500;

export type NotifyKind = 'fail' | 'ok' | 'review' | 'note';

export interface NotifyEvent {
  key: string;
  kind: NotifyKind;
  title: string;
  message: string;
  url: string;
}

/** A single comment thread on one of my PRs (built by the notes poller, T052). */
export interface NoteInput {
  threadId: string;
  prId: number;
  /** Displayed as the notification title. */
  title: string;
  url: string;
  updatedAt: string;
}

export interface PickEventsInput {
  /** Previous cycle's snapshot; used to detect "newly" entered PR groups. */
  prevSnapshot?: Snapshot;
  snapshot: Snapshot;
  seen: SeenEvents;
  settings: Settings;
  /** The signed-in user's login. */
  me: string;
  now: string;
  /** Comment threads on my PRs (empty/omitted when notify.comments is off upstream). */
  notes?: NoteInput[];
  t: (key: string, subs?: string | string[]) => string;
}

export interface PickEventsResult {
  events: NotifyEvent[];
  seen: SeenEvents;
}

function repoFullName(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * `Run` carries a single `mine` flag covering both "my own push" and "a
 * build on my PR" (data-model.md "Run"). Since it does not carry the
 * triggering PR numbers, the two are told apart here from `actor` alone:
 * myPush = I am the actor (my own push/manual run triggered it); myPr =
 * `mine` but the actor is someone/something else (e.g. CI re-running a
 * check on my open PR). This mirrors research R6's "mine" derivation.
 */
function isMyPush(run: Run, me: string): boolean {
  return run.actor === me;
}

function isMyPr(run: Run, me: string): boolean {
  return run.mine && run.actor !== me;
}

function buildFailedMatches(run: Run, me: string, scope: Settings['notify']['buildFailed']): boolean {
  switch (scope) {
    case 'off':
      return false;
    case 'myPrs':
      return isMyPr(run, me);
    case 'myPushes':
      return isMyPush(run, me);
    case 'mine':
      return run.mine;
    case 'all':
      return true;
  }
}

function epochOf(iso: string | undefined, fallbackMs: number): number {
  if (!iso) {
    return fallbackMs;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? fallbackMs : ms;
}

function inWindow(atMs: number, nowMs: number, initializedAtMs: number, windowMs: number): boolean {
  return atMs >= initializedAtMs && nowMs - atMs <= windowMs;
}

function wasInReviewGroup(prevSnapshot: Snapshot | undefined, prId: number): boolean {
  return prevSnapshot?.prs.some((p) => p.id === prId && p.group === 'review') ?? false;
}

function evictOldest(keys: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(keys);
  if (entries.length <= max) {
    return keys;
  }
  entries.sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(entries.slice(entries.length - max));
}

/**
 * Picks the notification events for one poll cycle and returns the updated
 * `SeenEvents`. The very first cycle after a fresh install/connection
 * (`seen.initializedAt` empty) never emits events — it only seeds `seen`
 * with every key currently present, so pre-existing failures/reviews/notes
 * don't cause a notification avalanche on first run (FR-062).
 */
export function pickEvents(input: PickEventsInput): PickEventsResult {
  const { prevSnapshot, snapshot, settings, me, now, notes = [], t } = input;
  const nowMs = Date.parse(now);
  const windowMs = settings.recentWindowHours * 60 * 60 * 1000;

  if (!input.seen.initializedAt) {
    const keys: Record<string, number> = {};
    for (const run of snapshot.runs) {
      if (run.state === 'failure') {
        keys[`fail:${run.id}:${run.attempt}`] = epochOf(run.completedAt, nowMs);
      } else if (run.state === 'success') {
        keys[`ok:${run.id}:${run.attempt}`] = epochOf(run.completedAt, nowMs);
      }
    }
    for (const pr of snapshot.prs) {
      if (pr.group === 'review') {
        keys[`review:${pr.id}`] = epochOf(pr.updatedAt, nowMs);
      }
    }
    for (const note of notes) {
      keys[`note:${note.threadId}:${note.updatedAt}`] = epochOf(note.updatedAt, nowMs);
    }
    return {
      events: [],
      seen: { initializedAt: now, keys: evictOldest(keys, MAX_SEEN_KEYS) },
    };
  }

  const initializedAtMs = Date.parse(input.seen.initializedAt);
  const keys: Record<string, number> = { ...input.seen.keys };
  const events: NotifyEvent[] = [];

  function addEvent(event: NotifyEvent, at: number): void {
    events.push(event);
    keys[event.key] = at;
  }

  for (const run of snapshot.runs) {
    if (run.state !== 'failure' && run.state !== 'success') {
      continue;
    }
    const atMs = epochOf(run.completedAt, nowMs);
    if (!inWindow(atMs, nowMs, initializedAtMs, windowMs)) {
      continue;
    }

    if (run.state === 'failure') {
      const key = `fail:${run.id}:${run.attempt}`;
      if (key in keys) {
        continue;
      }
      if (!buildFailedMatches(run, me, settings.notify.buildFailed)) {
        continue;
      }
      addEvent(
        {
          key,
          kind: 'fail',
          title: t('notifyBuildFailedTitle', [run.workflow]),
          message: t('notifyBuildFailedMessage', [repoFullName(run.repo), run.branch]),
          url: run.htmlUrl,
        },
        atMs
      );
    } else {
      const key = `ok:${run.id}:${run.attempt}`;
      if (key in keys) {
        continue;
      }
      if (!settings.notify.buildSucceededMyPr || !isMyPr(run, me)) {
        continue;
      }
      addEvent(
        {
          key,
          kind: 'ok',
          title: t('notifyBuildSucceededTitle', [run.workflow]),
          message: t('notifyBuildSucceededMessage', [repoFullName(run.repo), run.branch]),
          url: run.htmlUrl,
        },
        atMs
      );
    }
  }

  if (settings.notify.reviewRequested) {
    for (const pr of snapshot.prs as PullRequest[]) {
      if (pr.group !== 'review') {
        continue;
      }
      const key = `review:${pr.id}`;
      if (key in keys) {
        continue;
      }
      const atMs = epochOf(pr.updatedAt, nowMs);
      if (!inWindow(atMs, nowMs, initializedAtMs, windowMs)) {
        continue;
      }
      if (wasInReviewGroup(prevSnapshot, pr.id)) {
        continue;
      }
      addEvent(
        {
          key,
          kind: 'review',
          title: t('notifyReviewRequestedTitle', [pr.title]),
          message: t('notifyReviewRequestedMessage', [repoFullName(pr.repo), String(pr.number)]),
          url: pr.htmlUrl,
        },
        atMs
      );
    }
  }

  if (settings.notify.comments) {
    for (const note of notes) {
      const key = `note:${note.threadId}:${note.updatedAt}`;
      if (key in keys) {
        continue;
      }
      const atMs = epochOf(note.updatedAt, nowMs);
      if (!inWindow(atMs, nowMs, initializedAtMs, windowMs)) {
        continue;
      }
      addEvent(
        {
          key,
          kind: 'note',
          title: t('notifyNoteTitle', [note.title]),
          message: t('notifyNoteMessage', [note.title]),
          url: note.url,
        },
        atMs
      );
    }
  }

  return {
    events,
    seen: { initializedAt: input.seen.initializedAt, keys: evictOldest(keys, MAX_SEEN_KEYS) },
  };
}
