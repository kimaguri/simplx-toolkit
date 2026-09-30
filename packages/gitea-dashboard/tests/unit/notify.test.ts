// Contract: docs/specs/001-gitea-dashboard/data-model.md "SeenEvents"/"Уведомление",
// spec.md US5, FR-060..063.
import { describe, expect, it } from 'vitest';
import { pickEvents, type NoteInput } from '../../src/domain/notify';
import {
  DEFAULT_SETTINGS,
  type CiStatus,
  type PullRequest,
  type Run,
  type SeenEvents,
  type Settings,
  type Snapshot,
} from '../../src/domain/types';

const NOW = '2026-09-26T10:00:00Z';

function fakeT(key: string, subs?: string | string[]): string {
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return [key, ...list].join(':');
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    notify: { ...DEFAULT_SETTINGS.notify, ...overrides.notify },
  };
}

const ci: CiStatus = { state: 'none', fetchedAt: NOW };

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'me',
    headSha: 'deadbeef',
    htmlUrl: 'https://git.example.test/acme/platform/actions/runs/1',
    title: 'push: main',
    workflow: 'CI',
    state: 'failure',
    startedAt: '2026-09-26T09:00:00Z',
    completedAt: '2026-09-26T09:05:00Z',
    mine: true,
    group: 'mine',
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 1,
    title: 'Add feature',
    author: 'alice',
    updatedAt: NOW,
    htmlUrl: 'https://git.example.test/acme/platform/pulls/1',
    draft: false,
    group: 'review',
    ci,
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: NOW,
    prs: [],
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    ...overrides,
  };
}

function emptySeen(): SeenEvents {
  return { initializedAt: '', keys: {} };
}

describe('pickEvents — first run seeding (no avalanche, FR-062)', () => {
  it('emits zero events and seeds every current key when seen.initializedAt is empty', () => {
    const snap = snapshot({
      runs: [run({ id: 1, attempt: 1, state: 'failure' }), run({ id: 2, attempt: 1, state: 'success' })],
      prs: [pr({ id: 10, group: 'review' })],
    });
    const result = pickEvents({
      snapshot: snap,
      seen: emptySeen(),
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toEqual([]);
    expect(result.seen.initializedAt).toBe(NOW);
    expect(Object.keys(result.seen.keys).sort()).toEqual(
      ['fail:1:1', 'ok:2:1', 'review:10'].sort()
    );
  });
});

describe('pickEvents — build failures', () => {
  it('emits fail:<id>:<attempt> for a first failing attempt', () => {
    const seen: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys: {} };
    const snap = snapshot({ runs: [run({ id: 5, attempt: 1, state: 'failure' })] });
    const result = pickEvents({
      snapshot: snap,
      seen,
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.key).toBe('fail:5:1');
    expect(result.events[0]?.kind).toBe('fail');
    expect(result.events[0]?.url).toBe(
      'https://git.example.test/acme/platform/actions/runs/1'
    );
    expect(result.seen.keys['fail:5:1']).toBeDefined();
  });

  it('emits a new event fail:<id>:<attempt+1> for a rerun of a failed run', () => {
    const seen: SeenEvents = {
      initializedAt: '2026-09-26T08:00:00Z',
      keys: { 'fail:5:1': Date.parse('2026-09-26T09:00:00Z') },
    };
    const snap = snapshot({ runs: [run({ id: 5, attempt: 2, state: 'failure' })] });
    const result = pickEvents({
      snapshot: snap,
      seen,
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.key).toBe('fail:5:2');
  });

  it('emits nothing when the same cycle repeats (key already seen)', () => {
    const seen: SeenEvents = {
      initializedAt: '2026-09-26T08:00:00Z',
      keys: { 'fail:5:1': Date.parse('2026-09-26T09:05:00Z') },
    };
    const snap = snapshot({ runs: [run({ id: 5, attempt: 1, state: 'failure' })] });
    const result = pickEvents({
      snapshot: snap,
      seen,
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toEqual([]);
  });

  it('ignores an event completed before seen.initializedAt', () => {
    const seen: SeenEvents = { initializedAt: '2026-09-26T09:30:00Z', keys: {} };
    const snap = snapshot({
      runs: [run({ id: 6, attempt: 1, state: 'failure', completedAt: '2026-09-26T09:00:00Z' })],
    });
    const result = pickEvents({
      snapshot: snap,
      seen,
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toEqual([]);
  });

  it('ignores an event older than recentWindowHours', () => {
    const seen: SeenEvents = { initializedAt: '2026-09-01T00:00:00Z', keys: {} };
    const snap = snapshot({
      runs: [run({ id: 7, attempt: 1, state: 'failure', completedAt: '2026-09-20T09:00:00Z' })],
    });
    const result = pickEvents({
      snapshot: snap,
      seen,
      settings: settings({ recentWindowHours: 24 }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    expect(result.events).toEqual([]);
  });

  const seenBase: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys: {} };

  it('buildFailed=off never fires', () => {
    const snap = snapshot({ runs: [run({ id: 8, state: 'failure', actor: 'me', mine: true })] });
    const result = pickEvents({
      snapshot: snap,
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildFailed: 'off' } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });

  it('buildFailed=myPushes fires for my own push, not for my PR built by someone/something else', () => {
    const myPush = run({ id: 9, state: 'failure', actor: 'me', mine: true });
    const myPr = run({ id: 10, state: 'failure', actor: 'bot', mine: true });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPush, myPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildFailed: 'myPushes' } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['fail:9:1']);
  });

  it('buildFailed=myPrs fires for my PR built by another actor, not for my own push', () => {
    const myPush = run({ id: 11, state: 'failure', actor: 'me', mine: true });
    const myPr = run({ id: 12, state: 'failure', actor: 'bot', mine: true });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPush, myPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildFailed: 'myPrs' } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['fail:12:1']);
  });

  it('buildFailed=mine fires for both my push and my PR, not for others', () => {
    const myPush = run({ id: 13, state: 'failure', actor: 'me', mine: true });
    const myPr = run({ id: 14, state: 'failure', actor: 'bot', mine: true });
    const other = run({ id: 15, state: 'failure', actor: 'alice', mine: false, group: 'others' });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPush, myPr, other] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildFailed: 'mine' } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key).sort()).toEqual(['fail:13:1', 'fail:14:1']);
  });

  it('buildFailed=all fires for every failure, including others', () => {
    const other = run({ id: 16, state: 'failure', actor: 'alice', mine: false, group: 'others' });
    const result = pickEvents({
      snapshot: snapshot({ runs: [other] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildFailed: 'all' } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['fail:16:1']);
  });
});

describe('pickEvents — build success (buildSucceededMyPr)', () => {
  const seenBase: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys: {} };

  it('emits ok:<id>:<attempt> only for a my-PR success when enabled', () => {
    const myPr = run({ id: 20, state: 'success', actor: 'bot', mine: true });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildSucceededMyPr: true } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['ok:20:1']);
    expect(result.events[0]?.kind).toBe('ok');
  });

  it('does not emit ok events when disabled', () => {
    const myPr = run({ id: 21, state: 'success', actor: 'bot', mine: true });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildSucceededMyPr: false } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });

  it('does not emit ok for my own push success (only my-PR success counts)', () => {
    const myPush = run({ id: 22, state: 'success', actor: 'me', mine: true });
    const result = pickEvents({
      snapshot: snapshot({ runs: [myPush] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, buildSucceededMyPr: true } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });
});

describe('pickEvents — review requests', () => {
  const seenBase: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys: {} };

  it('emits review:<prId> for a PR newly in the review group when enabled', () => {
    const theirPr = pr({ id: 30, group: 'review', updatedAt: '2026-09-26T09:00:00Z' });
    const result = pickEvents({
      prevSnapshot: snapshot({ prs: [pr({ id: 30, group: 'other' })] }),
      snapshot: snapshot({ prs: [theirPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, reviewRequested: true } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['review:30']);
    expect(result.events[0]?.kind).toBe('review');
  });

  it('does not emit when reviewRequested is disabled', () => {
    const theirPr = pr({ id: 31, group: 'review', updatedAt: '2026-09-26T09:00:00Z' });
    const result = pickEvents({
      prevSnapshot: snapshot({ prs: [] }),
      snapshot: snapshot({ prs: [theirPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, reviewRequested: false } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });

  it('does not re-emit for a PR that was already in the review group', () => {
    const theirPr = pr({ id: 32, group: 'review', updatedAt: '2026-09-26T09:00:00Z' });
    const result = pickEvents({
      prevSnapshot: snapshot({ prs: [pr({ id: 32, group: 'review' })] }),
      snapshot: snapshot({ prs: [theirPr] }),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, reviewRequested: true } }),
      me: 'me',
      now: NOW,
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });
});

describe('pickEvents — comment notifications (notes)', () => {
  const seenBase: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys: {} };

  function note(overrides: Partial<NoteInput> = {}): NoteInput {
    return {
      threadId: 't1',
      prId: 40,
      title: 'New comment on Add feature',
      url: 'https://git.example.test/acme/platform/pulls/1',
      updatedAt: '2026-09-26T09:30:00Z',
      ...overrides,
    };
  }

  it('emits note:<threadId>:<updatedAt> from the notes list when comments are enabled', () => {
    const result = pickEvents({
      snapshot: snapshot(),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, comments: true } }),
      me: 'me',
      now: NOW,
      notes: [note()],
      t: fakeT,
    });
    expect(result.events.map((e) => e.key)).toEqual(['note:t1:2026-09-26T09:30:00Z']);
    expect(result.events[0]?.kind).toBe('note');
  });

  it('does not emit note events when comments are disabled', () => {
    const result = pickEvents({
      snapshot: snapshot(),
      seen: seenBase,
      settings: settings({ notify: { ...DEFAULT_SETTINGS.notify, comments: false } }),
      me: 'me',
      now: NOW,
      notes: [note()],
      t: fakeT,
    });
    expect(result.events).toEqual([]);
  });
});

describe('pickEvents — seen eviction', () => {
  it('keeps at most 500 keys, evicting the oldest first', () => {
    const keys: Record<string, number> = {};
    for (let i = 0; i < 500; i += 1) {
      keys[`fail:${i}:1`] = i; // ascending timestamps, 0 = oldest
    }
    const seen: SeenEvents = { initializedAt: '2026-09-26T08:00:00Z', keys };
    const newFailure = run({ id: 999, attempt: 1, state: 'failure' });
    const result = pickEvents({
      snapshot: snapshot({ runs: [newFailure] }),
      seen,
      settings: settings(),
      me: 'me',
      now: NOW,
      t: fakeT,
    });

    const resultKeys = Object.keys(result.seen.keys);
    expect(resultKeys).toHaveLength(500);
    expect(resultKeys).not.toContain('fail:0:1');
    expect(resultKeys).toContain('fail:999:1');
    expect(resultKeys).toContain('fail:499:1');
  });
});
