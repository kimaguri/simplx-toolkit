// Design: docs/specs/001-gitea-dashboard/data-model.md "Бейдж" (§101-102), FR-050/FR-051.
// Pure functions only — no browser/chrome APIs here.
import type { Run, Settings, Snapshot } from './types';

export const BADGE_RED = '#d73a49';
export const BADGE_NEUTRAL = '#6a737d';

export interface Badge {
  text: string;
  color: typeof BADGE_RED | typeof BADGE_NEUTRAL;
}

const BADGE_CAP = 99;

function formatCount(n: number): string {
  if (n <= 0) return '';
  if (n > BADGE_CAP) return '99+';
  return String(n);
}

function countFor(mode: Settings['badgeMode'], counts: Snapshot['counts']): number {
  switch (mode) {
    case 'reviews':
      return counts.reviews;
    case 'builds':
      return counts.activeMine;
    case 'sum':
      return counts.reviews + counts.activeMine;
  }
}

/**
 * Picks the badge text by settings.badgeMode from snapshot.counts, and colors
 * it red while `now < snapshot.redUntil`, else neutral. A null snapshot (no
 * data fetched yet) always yields an empty, neutral badge.
 */
export function badgeFor(settings: Settings, snapshot: Snapshot | null, now: Date): Badge {
  if (snapshot === null) {
    return { text: '', color: BADGE_NEUTRAL };
  }

  const text = formatCount(countFor(settings.badgeMode, snapshot.counts));
  const isRed = snapshot.redUntil !== undefined && now.getTime() < new Date(snapshot.redUntil).getTime();

  return { text, color: isRed ? BADGE_RED : BADGE_NEUTRAL };
}

/**
 * Computes the new `redUntil` from the latest poll's runs: the max of
 * completedAt + redBadgeWindowMin over MY failed runs (others' failures and
 * runs without a completedAt are ignored). Returns undefined when no such
 * run exists or when the resulting window has already expired relative to
 * `now`. The badge only stays red as long as a still-valid failed run backs
 * it — there is no extension from a previous snapshot's `redUntil`.
 */
export function redUntilFrom(runs: Run[], redBadgeWindowMin: number, now: Date): string | undefined {
  let maxUntilMs: number | undefined;

  for (const run of runs) {
    if (!run.mine || run.state !== 'failure' || run.completedAt === undefined) {
      continue;
    }
    const untilMs = new Date(run.completedAt).getTime() + redBadgeWindowMin * 60_000;
    if (maxUntilMs === undefined || untilMs > maxUntilMs) {
      maxUntilMs = untilMs;
    }
  }

  if (maxUntilMs === undefined || maxUntilMs <= now.getTime()) {
    return undefined;
  }

  return new Date(maxUntilMs).toISOString();
}
