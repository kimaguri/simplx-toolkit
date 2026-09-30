// Contract: docs/specs/002-fullpage-dashboard/data-model.md "RunHistoryFilter",
// "RunStats"; research.md R5/R6; spec.md US4 (FR-111, FR-112).
import { describe, expect, it } from 'vitest';
import {
  branchFacetValue,
  buildPrIndex,
  coversPeriod,
  classifyRun,
  prLinkUrl,
  runBranchDisplay,
  runsOfKind,
  filterRuns,
  mergeRunPages,
  periodStart,
  runInPeriod,
  runStats,
  sortRuns,
} from '../../src/domain/history';
import { toRun, type RunContext } from '../../src/domain/runs';
import type { PullRequest, Run } from '../../src/domain/types';
import type { RunHistoryFilter } from '../../src/domain/route';
import type { ApiActionWorkflowRun } from '../../src/api/types';

import runsRecentFixture from '../fixtures/runs-recent.json';
import runsActiveFixture from '../fixtures/runs-active.json';

const NOW = '2026-09-26T10:00:00Z';

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    me: 'me',
    myOpenPrs: new Map(),
    pinned: new Set(),
    workflowNames: new Map(),
    ...overrides,
  };
}

const recentRuns: Run[] = (
  runsRecentFixture.workflow_runs as unknown as ApiActionWorkflowRun[]
).map((r) => toRun(r, ctx()));
// recentRuns (by id): 4101 acme/platform ci.yml push main success me;
// 4102 acme/core ci.yml push develop failure bob; 4103 umbrella/web ci.yml
// push main cancelled alice; 4104 acme/platform lint.yml push main skipped
// me; 4105 acme/platform nightly.yml schedule main success me; 4106
// acme/platform release.yml push (tag, no branch) success me; 4107 acme/core
// ci.yml push main "completed" w/o conclusion -> cancelled, bob.

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
    workflow: 'ci.yml',
    state: 'success',
    startedAt: '2026-09-26T09:00:00Z',
    completedAt: '2026-09-26T09:05:00Z',
    mine: true,
    group: 'mine',
    ...overrides,
  };
}

function baseFilter(overrides: Partial<RunHistoryFilter> = {}): RunHistoryFilter {
  return {
    period: '7d',
    repo: [],
    wf: [],
    branch: [],
    event: [],
    result: [],
    mine: false,
    kind: 'all',
    sort: { column: 'started', direction: 'desc' },
    ...overrides,
  };
}

describe('mergeRunPages', () => {
  it('dedupes by id keeping the highest attempt and sorts startedAt desc', () => {
    const oldAttempt = run({ id: 1, attempt: 1, startedAt: '2026-09-26T08:00:00Z' });
    const retriedAttempt = run({ id: 1, attempt: 2, startedAt: '2026-09-26T09:00:00Z' });
    const other = run({ id: 2, attempt: 1, startedAt: '2026-09-26T09:30:00Z' });

    const merged = mergeRunPages([[oldAttempt, other], [retriedAttempt]]);

    expect(merged.map((r) => r.id)).toEqual([2, 1]);
    expect(merged.find((r) => r.id === 1)?.attempt).toBe(2);
    expect(merged.find((r) => r.id === 1)?.startedAt).toBe('2026-09-26T09:00:00Z');
  });

  it('sorts runs without startedAt last (treated as oldest)', () => {
    const withStart = run({ id: 1, startedAt: '2026-09-26T09:00:00Z' });
    const withoutStart = run({ id: 2, startedAt: undefined });

    const merged = mergeRunPages([[withoutStart, withStart]]);

    expect(merged.map((r) => r.id)).toEqual([1, 2]);
  });

  it('T057: a waiting/blocked run without startedAt sorts FIRST (it is current, not oldest)', () => {
    const finished = run({ id: 1, state: 'success', startedAt: '2026-09-26T09:00:00Z' });
    const waiting = run({ id: 2, state: 'waiting', startedAt: undefined });
    const blocked = run({ id: 3, state: 'blocked', startedAt: undefined });

    const merged = mergeRunPages([[finished, waiting, blocked]]);

    // Waiting/blocked (no time) first, ties broken by id desc (higher id = newer).
    expect(merged.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('returns an empty array for no pages', () => {
    expect(mergeRunPages([])).toEqual([]);
  });

  it('T055: on an equal attempt the copy from the later list wins (cached first, fetched last)', () => {
    const cached = run({ id: 7, attempt: 1, state: 'blocked', startedAt: undefined });
    const fetched = run({ id: 7, attempt: 1, state: 'success', startedAt: '2026-09-26T09:00:00Z' });

    const merged = mergeRunPages([[cached], [fetched]]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.state).toBe('success');
    expect(merged[0]?.startedAt).toBe('2026-09-26T09:00:00Z');
  });
});

describe('runInPeriod (T058)', () => {
  const PERIOD_START_MS = new Date('2026-09-26T00:00:00Z').getTime();

  it('a finished run inside the period passes', () => {
    const finished = run({ startedAt: '2026-09-26T05:00:00Z', state: 'success' });
    expect(runInPeriod(finished, PERIOD_START_MS)).toBe(true);
  });

  it('a finished run before the period fails', () => {
    const old = run({ startedAt: '2026-09-25T05:00:00Z', state: 'success' });
    expect(runInPeriod(old, PERIOD_START_MS)).toBe(false);
  });

  it('an active run (running/waiting/blocked) always passes, even started before the period', () => {
    const runningOld = run({ startedAt: '2026-09-20T05:00:00Z', state: 'running' });
    const waitingNoTime = run({ startedAt: undefined, completedAt: undefined, state: 'waiting' });
    expect(runInPeriod(runningOld, PERIOD_START_MS)).toBe(true);
    expect(runInPeriod(waitingNoTime, PERIOD_START_MS)).toBe(true);
  });

  it('a non-active run with no timestamp at all fails', () => {
    const noTime = run({ startedAt: undefined, completedAt: undefined, state: 'cancelled' });
    expect(runInPeriod(noTime, PERIOD_START_MS)).toBe(false);
  });
});

describe('periodStart', () => {
  it('computes the start of 24h/7d/30d windows before now', () => {
    expect(periodStart('24h', NOW)).toBe('2026-09-25T10:00:00.000Z');
    expect(periodStart('7d', NOW)).toBe('2026-09-19T10:00:00.000Z');
    expect(periodStart('30d', NOW)).toBe('2026-08-27T10:00:00.000Z');
  });
});

describe('periodStart today (midnight Almaty, UTC+5)', () => {
  it('at 23:59 Almaty (18:59Z) the day started at 00:00 Almaty the same day (19:00Z previous UTC day)', () => {
    expect(periodStart('today', '2026-09-26T18:59:00Z')).toBe('2026-09-25T19:00:00.000Z');
  });

  it('at 00:01 Almaty (19:01Z) the day just rolled over to the next Almaty date', () => {
    expect(periodStart('today', '2026-09-26T19:01:00Z')).toBe('2026-09-26T19:00:00.000Z');
  });

  it('exactly at midnight Almaty the boundary equals now', () => {
    expect(periodStart('today', '2026-09-26T19:00:00Z')).toBe('2026-09-26T19:00:00.000Z');
  });

  it('early UTC morning is still the same Almaty day that began on the previous UTC date', () => {
    expect(periodStart('today', '2026-09-26T02:00:00Z')).toBe('2026-09-25T19:00:00.000Z');
  });

  it('does not observe DST (fixed +05:00 in winter and summer)', () => {
    expect(periodStart('today', '2026-01-15T12:00:00Z')).toBe('2026-01-14T19:00:00.000Z');
    expect(periodStart('today', '2026-07-15T12:00:00Z')).toBe('2026-07-14T19:00:00.000Z');
  });

  it('coversPeriod works against a start that is not now-minus-constant', () => {
    const start = periodStart('today', '2026-09-26T10:00:00Z');
    const early = [{ ...RUN_AT('2026-09-25T18:00:00.000Z') }];
    expect(coversPeriod(early, start, false).covered).toBe(true);
    const late = [{ ...RUN_AT('2026-09-26T05:00:00.000Z') }];
    expect(coversPeriod(late, start, false).covered).toBe(false);
  });
});

function RUN_AT(startedAt: string): Run {
  return { startedAt } as Run;
}

describe('classifyRun (rev.5, FR-125)', () => {
  const c = (o: Partial<Run>) => classifyRun(run(o));
  it('push to test is a build', () => {
    expect(c({ branch: 'test', event: 'push', title: 'feat: x' })).toBe('build');
  });
  it('push of a version tag (branch = tag name) is a release', () => {
    expect(c({ branch: 'v1.42.5', event: 'push', title: 'Release 1.42.5' })).toBe('release');
  });
  it('tag ref with refs/tags/ prefix is a release', () => {
    expect(c({ branch: 'refs/tags/v1.2.3', event: 'push', title: 'x' })).toBe('release');
  });
  it('release published event is a release even on a plain branch', () => {
    expect(c({ branch: 'main', event: 'release', title: 'x' })).toBe('release');
  });
  it('real case: docker-build push of tag v1.45.1 with a merge-commit title is a release', () => {
    expect(
      c({
        branch: 'v1.45.1',
        event: 'push',
        workflow: 'docker-build',
        title: "Merge pull request 'fix(LAB-313): пересчёт' (#78) from feat/lab-313/koreana-demo-bugs into main",
      })
    ).toBe('release');
  });
  it('the title is ignored: a version in it does not make a release, "into main" does not make a build', () => {
    expect(c({ branch: 'feature/z', event: 'push', title: 'v2.0.1' })).toBe('check');
    expect(c({ branch: 'feature/z', event: 'push', title: 'Merge x into main' })).toBe('check');
  });
  it('pull_request is a check, even targeting main/test', () => {
    expect(c({ branch: 'main', event: 'pull_request' })).toBe('check');
    expect(c({ branch: 'feat/x', event: 'pull_request' })).toBe('check');
  });
  it('push to a feature branch is a check', () => {
    expect(c({ branch: 'feature/x', event: 'push', title: 'wip' })).toBe('check');
  });
  it('workflow_dispatch on main is a build', () => {
    expect(c({ branch: 'main', event: 'workflow_dispatch', title: 'manual' })).toBe('build');
  });
  it('release/* branch push is a build; bare "release" is not', () => {
    expect(c({ branch: 'release/2.1', event: 'push', title: 'x' })).toBe('build');
    expect(c({ branch: 'release', event: 'push', title: 'x' })).toBe('check');
  });
});

describe('runsOfKind', () => {
  const rs = [
    run({ id: 1, branch: 'v1.0.0', event: 'push' }),
    run({ id: 2, branch: 'test', event: 'push' }),
    run({ id: 3, branch: 'main', event: 'pull_request' }),
    run({ id: 4, branch: 'feature/a', event: 'push' }),
  ];
  it('builds = release + build', () => {
    expect(runsOfKind(rs, 'builds').map((r) => r.id)).toEqual([1, 2]);
  });
  it('all = everything', () => {
    expect(runsOfKind(rs, 'all').map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('coversPeriod', () => {
  const start7d = periodStart('7d', NOW);

  it('is covered when the oldest run is at/before the period start', () => {
    const runs = [run({ startedAt: start7d }), run({ id: 2, startedAt: NOW })];
    const result = coversPeriod(runs, start7d, false);
    expect(result.covered).toBe(true);
    expect(result.coveredUntil).toBe(start7d);
  });

  it('is not covered when the oldest fetched run is newer than the period start and more pages remain', () => {
    const runs = [run({ startedAt: '2026-09-24T00:00:00Z' })];
    const result = coversPeriod(runs, start7d, false);
    expect(result.covered).toBe(false);
    expect(result.coveredUntil).toBe('2026-09-24T00:00:00Z');
  });

  it('is covered when the source is exhausted, regardless of period start', () => {
    const runs = [run({ startedAt: '2026-09-24T00:00:00Z' })];
    const result = coversPeriod(runs, start7d, true);
    expect(result.covered).toBe(true);
  });

  it('is covered with no runs when exhausted (nothing in history)', () => {
    const result = coversPeriod([], start7d, true);
    expect(result.covered).toBe(true);
  });

  it('is not covered with no runs when not exhausted', () => {
    const result = coversPeriod([], start7d, false);
    expect(result.covered).toBe(false);
  });
});

describe('filterRuns', () => {
  it('filters by a single-value repo set', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ repo: ['acme/core'] }), 'me');
    expect(filtered.map((r) => r.id).sort()).toEqual([4102, 4107]);
  });

  it('filters by workflow set', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ wf: ['lint.yml', 'nightly.yml'] }), 'me');
    expect(filtered.map((r) => r.id).sort()).toEqual([4104, 4105]);
  });

  it('filters by branch set (runs without a branch, e.g. tag pushes, never match)', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ branch: ['develop'] }), 'me');
    expect(filtered.map((r) => r.id)).toEqual([4102]);
  });

  it('filters by event set', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ event: ['schedule'] }), 'me');
    expect(filtered.map((r) => r.id)).toEqual([4105]);
  });

  it('filters by result set (RunState)', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ result: ['cancelled'] }), 'me');
    expect(filtered.map((r) => r.id).sort()).toEqual([4103, 4107]);
  });

  it('filters by mine', () => {
    const filtered = filterRuns(recentRuns, baseFilter({ mine: true }), 'me');
    expect(filtered.map((r) => r.id).sort()).toEqual([4101, 4104, 4105, 4106]);
  });

  it('combines multiple filters (AND)', () => {
    const filtered = filterRuns(
      recentRuns,
      baseFilter({ repo: ['acme/platform'], result: ['success'] }),
      'me'
    );
    expect(filtered.map((r) => r.id).sort()).toEqual([4101, 4105, 4106]);
  });

  it('returns everything when the filter has no constraints', () => {
    expect(filterRuns(recentRuns, baseFilter(), 'me')).toHaveLength(recentRuns.length);
  });
});

describe('runStats', () => {
  it('counts total/completed/failed and computes failureRate over completed only (skipped excluded)', () => {
    const stats = runStats(recentRuns);
    // completed = success(4101,4105,4106) + failure(4102) + cancelled(4103,4107) = 6;
    // skipped(4104) excluded from completed/failureRate but counted in total.
    expect(stats.total).toBe(7);
    expect(stats.completed).toBe(6);
    expect(stats.failed).toBe(1);
    expect(stats.failureRate).toBeCloseTo(1 / 6, 10);
  });

  it('reports 0 failureRate and no durations when there are no completed runs', () => {
    const stats = runStats([run({ state: 'running', startedAt: NOW, completedAt: undefined })]);
    expect(stats.total).toBe(1);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.failureRate).toBe(0);
    expect(stats.avgDurationSec).toBeUndefined();
    expect(stats.medianDurationSec).toBeUndefined();
  });

  it('excludes missing/zero/negative/zero-time durations, keeps valid ones', () => {
    const runs = [
      run({ id: 1, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:01:00Z' }), // 60s
      run({ id: 2, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:03:00Z' }), // 180s
      run({ id: 3, startedAt: undefined, completedAt: '2026-09-26T09:01:00Z' }), // missing started
      run({ id: 4, startedAt: '2026-09-26T09:00:00Z', completedAt: undefined }), // missing completed
      run({ id: 5, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:00:00Z' }), // zero
      run({ id: 6, startedAt: '2026-09-26T09:05:00Z', completedAt: '2026-09-26T09:00:00Z' }), // negative
      run({ id: 7, startedAt: '0001-01-01T00:00:00Z', completedAt: '2026-09-26T09:01:00Z' }), // zero-time start
      run({ id: 8, startedAt: '2026-09-26T09:00:00Z', completedAt: '0001-01-01T00:00:00Z' }), // zero-time end
    ];

    const stats = runStats(runs);

    expect(stats.avgDurationSec).toBe(120); // (60 + 180) / 2
    expect(stats.medianDurationSec).toBe(120); // even count: (60 + 180) / 2
  });

  it('computes the median correctly for an odd number of durations', () => {
    const runs = [
      run({ id: 1, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:01:00Z' }), // 60s
      run({ id: 2, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:02:00Z' }), // 120s
      run({ id: 3, startedAt: '2026-09-26T09:00:00Z', completedAt: '2026-09-26T09:10:00Z' }), // 600s
    ];

    const stats = runStats(runs);

    expect(stats.medianDurationSec).toBe(120);
    expect(stats.avgDurationSec).toBe((60 + 120 + 600) / 3);
  });

  it('breaks down by workflow, sorted by total desc', () => {
    const stats = runStats(recentRuns);
    expect(stats.byWorkflow.map((w) => w.workflow)).toEqual([
      'ci.yml',
      'lint.yml',
      'nightly.yml',
      'release.yml',
    ]);
    const ci = stats.byWorkflow.find((w) => w.workflow === 'ci.yml');
    expect(ci?.total).toBe(4); // 4101, 4102, 4103, 4107
    expect(ci?.failed).toBe(1); // 4102
  });
});

describe('sortRuns', () => {
  it('sorts by started desc/asc', () => {
    const a = run({ id: 1, startedAt: '2026-09-26T08:00:00Z' });
    const b = run({ id: 2, startedAt: '2026-09-26T09:00:00Z' });

    expect(sortRuns([a, b], 'started', 'desc').map((r) => r.id)).toEqual([2, 1]);
    expect(sortRuns([a, b], 'started', 'asc').map((r) => r.id)).toEqual([1, 2]);
  });

  it('sorts by duration desc/asc, treating missing duration as shortest', () => {
    const short = run({
      id: 1,
      startedAt: '2026-09-26T09:00:00Z',
      completedAt: '2026-09-26T09:01:00Z',
    });
    const long = run({
      id: 2,
      startedAt: '2026-09-26T09:00:00Z',
      completedAt: '2026-09-26T09:10:00Z',
    });
    const missing = run({ id: 3, startedAt: NOW, completedAt: undefined, state: 'running' });

    expect(sortRuns([short, long, missing], 'duration', 'desc').map((r) => r.id)).toEqual([
      2, 1, 3,
    ]);
    expect(sortRuns([short, long, missing], 'duration', 'asc').map((r) => r.id)).toEqual([
      3, 1, 2,
    ]);
  });

  it('T057: waiting/blocked runs without startedAt sort first for desc, last for asc, ties by id desc', () => {
    const started = run({ id: 1, state: 'success', startedAt: '2026-09-26T08:00:00Z' });
    const waiting = run({ id: 2, state: 'waiting', startedAt: undefined });
    const blocked = run({ id: 3, state: 'blocked', startedAt: undefined });

    expect(sortRuns([started, waiting, blocked], 'started', 'desc').map((r) => r.id)).toEqual([
      3, 2, 1,
    ]);
    expect(sortRuns([started, waiting, blocked], 'started', 'asc').map((r) => r.id)).toEqual([
      1, 3, 2,
    ]);
  });

  it('does not mutate the input array', () => {
    const runs = [run({ id: 1, startedAt: '2026-09-26T08:00:00Z' }), run({ id: 2 })];
    const copy = [...runs];
    sortRuns(runs, 'started', 'asc');
    expect(runs).toEqual(copy);
  });
});

describe('fixtures sanity (active runs have no completedAt yet)', () => {
  it('toRun keeps startedAt but leaves completedAt undefined for in-flight runs', () => {
    const activeRuns: Run[] = (
      runsActiveFixture.workflow_runs as unknown as ApiActionWorkflowRun[]
    ).map((r) => toRun(r, ctx()));
    expect(activeRuns.every((r) => r.completedAt === undefined)).toBe(true);
    const stats = runStats(activeRuns);
    expect(stats.completed).toBe(0);
  });
});

describe('classifyRun tolerates dirty data (T054)', () => {
  it('a run with no branch/event at all classifies as check without throwing', () => {
    const dirty = { ...run({}), branch: undefined, event: undefined } as unknown as Run;
    expect(classifyRun(dirty)).toBe('check');
    expect(runsOfKind([dirty], 'builds' as never)).toEqual([]);
  });

  it('null branch classifies as check', () => {
    expect(classifyRun({ ...run({}), branch: null } as unknown as Run)).toBe('check');
  });
});

// ---------------------------------------------------------------------------
// T056: PR check runs — branch column/facet show "#N -> baseRef"
// ---------------------------------------------------------------------------

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 81,
    title: 'Add caching layer',
    author: 'alice',
    updatedAt: '2026-09-26T09:00:00Z',
    htmlUrl: 'https://git.example.test/acme/platform/pulls/81',
    draft: false,
    group: 'other',
    ci: { state: 'none', fetchedAt: '' },
    ...overrides,
  };
}

describe('buildPrIndex / runBranchDisplay / branchFacetValue / prLinkUrl (T056)', () => {
  it('finds a PR by repo+number and exposes its baseRef', () => {
    const index = buildPrIndex([pr({ number: 81, baseRef: 'test' })]);
    const prRun = run({ event: 'pull_request', branch: '', prNumber: 81 });
    const display = runBranchDisplay(prRun, index);
    expect(display).toEqual({
      kind: 'pr',
      prNumber: 81,
      baseRef: 'test',
      prUrl: 'https://git.example.test/acme/platform/pulls/81',
    });
  });

  it('a non-PR run keeps its plain branch', () => {
    const index = buildPrIndex([]);
    expect(runBranchDisplay(run({ branch: 'main' }), index)).toEqual({
      kind: 'branch',
      branch: 'main',
    });
  });

  it('PR not found in the snapshot (closed/other repo) -> baseRef undefined', () => {
    const index = buildPrIndex([pr({ repo: { owner: 'other', name: 'repo' }, number: 81 })]);
    const prRun = run({ event: 'pull_request', branch: '', prNumber: 81 });
    const display = runBranchDisplay(prRun, index);
    expect(display.kind === 'pr' && display.baseRef).toBeUndefined();
  });

  it('a PR mapped before this change (no baseRef) is tolerated as unknown', () => {
    const index = buildPrIndex([pr({ number: 81, baseRef: undefined })]);
    const prRun = run({ event: 'pull_request', branch: '', prNumber: 81 });
    const display = runBranchDisplay(prRun, index);
    expect(display.kind === 'pr' && display.baseRef).toBeUndefined();
  });

  it('branchFacetValue uses baseRef for PR runs when known, else the plain branch', () => {
    const index = buildPrIndex([pr({ number: 81, baseRef: 'test' })]);
    expect(branchFacetValue(run({ event: 'pull_request', branch: '', prNumber: 81 }), index)).toBe('test');
    expect(branchFacetValue(run({ branch: 'main' }), index)).toBe('main');
  });

  it('T056: prefers run.baseRef (straight from the run, works for closed PRs) over the snapshot index', () => {
    const index = buildPrIndex([pr({ number: 81, baseRef: 'stale-from-snapshot' })]);
    const prRun = run({ event: 'pull_request', branch: '', prNumber: 81, baseRef: 'test' });
    const display = runBranchDisplay(prRun, index);
    expect(display.kind === 'pr' && display.baseRef).toBe('test');
  });

  it('T056: falls back to the snapshot index when the run has no baseRef of its own', () => {
    const index = buildPrIndex([pr({ number: 81, baseRef: 'test' })]);
    const prRun = run({ event: 'pull_request', branch: '', prNumber: 81 });
    const display = runBranchDisplay(prRun, index);
    expect(display.kind === 'pr' && display.baseRef).toBe('test');
  });

  it('prLinkUrl derives the PR URL from the run htmlUrl', () => {
    expect(
      prLinkUrl(run({ htmlUrl: 'https://git.example.test/acme/platform/actions/runs/123', prNumber: 81 }))
    ).toBe('https://git.example.test/acme/platform/pulls/81');
  });
});
