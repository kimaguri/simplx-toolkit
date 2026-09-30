// Design: docs/specs/001-gitea-dashboard/data-model.md "Бейдж" (§101-102), FR-050/FR-051.
// badgeFor(settings, snapshot|null, now) picks the number by settings.badgeMode from
// snapshot.counts, and colors it red while `now < redUntil`, else neutral.
// redUntilFrom(runs, redBadgeWindowMin, now) = the latest
// completedAt + windowMin among MY failed runs (ignores others' failures and runs
// without completedAt); undefined if none apply / all already expired.
import { describe, expect, it } from 'vitest';
import {
  BADGE_NEUTRAL,
  BADGE_RED,
  badgeFor,
  redUntilFrom,
} from '../../src/domain/badge';
import type { Run, Settings, Snapshot } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

const NOW = new Date('2026-09-26T12:00:00.000Z');

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function snapshotWith(
  counts: Partial<Snapshot['counts']>,
  overrides: Partial<Snapshot> = {}
): Snapshot {
  return {
    fetchedAt: NOW.toISOString(),
    prs: [],
    runs: [],
    counts: {
      reviews: 0,
      activeMine: 0,
      activeOthers: 0,
      failedOthers: 0,
      ...counts,
    },
    ...overrides,
  };
}

function run(overrides: Partial<Run>): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'widgets' },
    branch: 'main',
    event: 'push',
    actor: 'someone',
    headSha: 'abc123',
    htmlUrl: 'https://gitea.example.com/acme/widgets/actions/runs/1',
    title: 'CI',
    workflow: 'ci.yml',
    state: 'failure',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

describe('badgeFor', () => {
  it('returns empty text for a null snapshot regardless of mode', () => {
    expect(badgeFor(DEFAULT_SETTINGS, null, NOW)).toEqual({
      text: '',
      color: BADGE_NEUTRAL,
    });
  });

  it('mode reviews: 0 reviews yields empty text', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const snapshot = snapshotWith({ reviews: 0 });
    expect(badgeFor(settings, snapshot, NOW)).toEqual({
      text: '',
      color: BADGE_NEUTRAL,
    });
  });

  it('mode reviews: 12 reviews yields "12"', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const snapshot = snapshotWith({ reviews: 12 });
    expect(badgeFor(settings, snapshot, NOW)).toEqual({
      text: '12',
      color: BADGE_NEUTRAL,
    });
  });

  it('mode reviews: caps display at "99+" above 99', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const snapshot = snapshotWith({ reviews: 130 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('99+');
  });

  it('mode builds uses counts.activeMine', () => {
    const settings = settingsWith({ badgeMode: 'builds' });
    const snapshot = snapshotWith({ activeMine: 3, reviews: 10 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('3');
  });

  it('mode builds: 0 active yields empty text', () => {
    const settings = settingsWith({ badgeMode: 'builds' });
    const snapshot = snapshotWith({ activeMine: 0, reviews: 10 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('');
  });

  it('mode sum adds reviews and activeMine', () => {
    const settings = settingsWith({ badgeMode: 'sum' });
    const snapshot = snapshotWith({ reviews: 4, activeMine: 5 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('9');
  });

  it('mode sum: 0 total yields empty text', () => {
    const settings = settingsWith({ badgeMode: 'sum' });
    const snapshot = snapshotWith({ reviews: 0, activeMine: 0 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('');
  });

  it('mode sum: caps combined total at "99+"', () => {
    const settings = settingsWith({ badgeMode: 'sum' });
    const snapshot = snapshotWith({ reviews: 60, activeMine: 60 });
    expect(badgeFor(settings, snapshot, NOW).text).toBe('99+');
  });

  it('is red while now < redUntil', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const redUntil = new Date(NOW.getTime() + 60_000).toISOString();
    const snapshot = snapshotWith({ reviews: 1 }, { redUntil });
    expect(badgeFor(settings, snapshot, NOW).color).toBe(BADGE_RED);
  });

  it('is neutral once now reaches redUntil', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const redUntil = NOW.toISOString();
    const snapshot = snapshotWith({ reviews: 1 }, { redUntil });
    expect(badgeFor(settings, snapshot, NOW).color).toBe(BADGE_NEUTRAL);
  });

  it('is neutral when redUntil is absent', () => {
    const settings = settingsWith({ badgeMode: 'reviews' });
    const snapshot = snapshotWith({ reviews: 1 });
    expect(badgeFor(settings, snapshot, NOW).color).toBe(BADGE_NEUTRAL);
  });
});

describe('redUntilFrom', () => {
  const windowMin = 30;

  it('returns undefined when there are no runs', () => {
    expect(redUntilFrom([], windowMin, NOW)).toBeUndefined();
  });

  it('ignores failed runs belonging to other people', () => {
    const runs = [
      run({
        mine: false,
        state: 'failure',
        completedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      }),
    ];
    expect(redUntilFrom(runs, windowMin, NOW)).toBeUndefined();
  });

  it('ignores my failed runs without a completedAt', () => {
    const runs = [run({ mine: true, state: 'failure', completedAt: undefined })];
    expect(redUntilFrom(runs, windowMin, NOW)).toBeUndefined();
  });

  it('ignores my non-failure runs', () => {
    const runs = [
      run({
        mine: true,
        state: 'success',
        completedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      }),
    ];
    expect(redUntilFrom(runs, windowMin, NOW)).toBeUndefined();
  });

  it('computes completedAt + windowMin for my failed run', () => {
    const completedAt = new Date(NOW.getTime() - 5 * 60_000);
    const runs = [run({ mine: true, state: 'failure', completedAt: completedAt.toISOString() })];
    const result = redUntilFrom(runs, windowMin, NOW);
    expect(result).toBe(new Date(completedAt.getTime() + windowMin * 60_000).toISOString());
  });

  it('returns undefined once the window has already expired', () => {
    const completedAt = new Date(NOW.getTime() - 60 * 60_000);
    const runs = [run({ mine: true, state: 'failure', completedAt: completedAt.toISOString() })];
    expect(redUntilFrom(runs, windowMin, NOW)).toBeUndefined();
  });

  it('picks the max redUntil across multiple of my failed runs', () => {
    const older = new Date(NOW.getTime() - 20 * 60_000);
    const newer = new Date(NOW.getTime() - 5 * 60_000);
    const runs = [
      run({ id: 1, mine: true, state: 'failure', completedAt: older.toISOString() }),
      run({ id: 2, mine: true, state: 'failure', completedAt: newer.toISOString() }),
      run({ id: 3, mine: false, state: 'failure', completedAt: NOW.toISOString() }),
    ];
    const result = redUntilFrom(runs, windowMin, NOW);
    expect(result).toBe(new Date(newer.getTime() + windowMin * 60_000).toISOString());
  });
});
