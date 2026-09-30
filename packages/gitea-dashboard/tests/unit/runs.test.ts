// Contract: docs/specs/001-gitea-dashboard/data-model.md "Run"/"RunState",
// research.md R4-R6, spec.md FR-030..032.
import { describe, expect, it } from 'vitest';
import {
  buildRunList,
  runCounts,
  toRun,
  toRunState,
  type RunContext,
} from '../../src/domain/runs';
import type { ApiActionWorkflowRun } from '../../src/api/types';

import runsActiveFixture from '../fixtures/runs-active.json';
import runsRecentFixture from '../fixtures/runs-recent.json';
import runsFloodFixture from '../fixtures/runs-flood.json';
import runsMineFixture from '../fixtures/runs-mine.json';

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

function run(overrides: Partial<ApiActionWorkflowRun> = {}): ApiActionWorkflowRun {
  return {
    id: 1,
    run_attempt: 1,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: 'deadbeef',
    display_title: 'push: main',
    path: 'ci.yml@refs/heads/main',
    actor: { login: 'alice' },
    trigger_actor: { login: 'alice' },
    repository: { full_name: 'acme/platform' },
    html_url: 'https://git.example.test/acme/platform/actions/runs/1',
    started_at: '2026-09-26T09:00:00Z',
    completed_at: '2026-09-26T09:05:00Z',
    pull_requests: [],
    ...overrides,
  };
}

describe('toRunState', () => {
  it('maps queued -> waiting', () => {
    expect(toRunState('queued')).toBe('waiting');
  });
  it('maps waiting -> blocked', () => {
    expect(toRunState('waiting')).toBe('blocked');
  });
  it('maps in_progress -> running', () => {
    expect(toRunState('in_progress')).toBe('running');
  });
  it('maps completed+success -> success', () => {
    expect(toRunState('completed', 'success')).toBe('success');
  });
  it('maps completed+failure -> failure', () => {
    expect(toRunState('completed', 'failure')).toBe('failure');
  });
  it('maps completed+cancelled -> cancelled', () => {
    expect(toRunState('completed', 'cancelled')).toBe('cancelled');
  });
  it('maps completed+skipped -> skipped', () => {
    expect(toRunState('completed', 'skipped')).toBe('skipped');
  });
  it('maps completed without conclusion -> cancelled (R4 edge case)', () => {
    expect(toRunState('completed')).toBe('cancelled');
    expect(toRunState('completed', undefined)).toBe('cancelled');
  });
});

describe('toRun', () => {
  it('resolves workflow name from cache when present', () => {
    const workflowNames = new Map([
      ['acme/platform', new Map([['ci.yml', 'CI']])],
    ]);
    const result = toRun(
      run({ path: 'ci.yml@refs/heads/main' }),
      ctx({ workflowNames })
    );
    expect(result.workflow).toBe('CI');
  });

  it('falls back to the file name before "@" when no cache entry', () => {
    const result = toRun(run({ path: 'ci.yml@refs/pull/12/head' }), ctx());
    expect(result.workflow).toBe('ci.yml');
  });

  it('derives the branch from the path ref when head_branch is empty (scheduled)', () => {
    const result = toRun(
      run({ head_branch: '', path: 'nightly.yml@refs/heads/main' }),
      ctx()
    );
    expect(result.branch).toBe('main');
    expect(result.workflow).toBe('nightly.yml');
  });

  it('reads a tag run', () => {
    const result = toRun(
      run({ head_branch: '', path: 'release.yml@refs/tags/v1.0.0' }),
      ctx()
    );
    expect(result.workflow).toBe('release.yml');
    expect(result.branch).toBe('v1.0.0');
  });

  it('keeps head_branch when present, and leaves pull refs empty', () => {
    expect(toRun(run({ head_branch: 'test', path: 'ci.yml@refs/heads/test' }), ctx()).branch).toBe('test');
    expect(toRun(run({ head_branch: '', path: 'ci.yml@refs/pull/12/head' }), ctx()).branch).toBe('');
  });

  it('is mine when actor matches me', () => {
    const result = toRun(run({ actor: { login: 'me' } }), ctx({ me: 'me' }));
    expect(result.mine).toBe(true);
    expect(result.group).toBe('mine');
  });

  it('is mine when trigger_actor matches me', () => {
    const result = toRun(
      run({ actor: { login: 'bot' }, trigger_actor: { login: 'me' } }),
      ctx({ me: 'me' })
    );
    expect(result.mine).toBe(true);
  });

  it('is mine when the run belongs to one of my open PRs', () => {
    const myOpenPrs = new Map([['acme/platform', new Set([12])]]);
    const result = toRun(
      run({
        actor: { login: 'alice' },
        trigger_actor: { login: 'alice' },
        pull_requests: [{ number: 12 }],
      }),
      ctx({ me: 'me', myOpenPrs })
    );
    expect(result.mine).toBe(true);
  });

  it('T056: parses prNumber from a refs/pull/N/head path (PR check run)', () => {
    const result = toRun(
      run({ event: 'pull_request', head_branch: '', path: 'pr.yml@refs/pull/81/head' }),
      ctx()
    );
    expect(result.prNumber).toBe(81);
    expect(result.branch).toBe('');
  });

  it('T056: parses prNumber from a refs/pull/N/merge path', () => {
    const result = toRun(
      run({ event: 'pull_request', head_branch: '', path: 'pr.yml@refs/pull/81/merge' }),
      ctx()
    );
    expect(result.prNumber).toBe(81);
  });

  it('T056: leaves prNumber undefined for a pr-cleanup run (path has no PR number)', () => {
    const result = toRun(
      run({
        event: 'pull_request',
        head_branch: '',
        path: 'pr-cleanup.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      ctx()
    );
    expect(result.prNumber).toBeUndefined();
  });

  it('T056: leaves prNumber undefined for a normal branch push', () => {
    const result = toRun(run({ event: 'push', path: 'ci.yml@refs/heads/main' }), ctx());
    expect(result.prNumber).toBeUndefined();
  });

  it('T056: prefers pull_requests[].base.ref (straight from the run, works for closed PRs) over the snapshot', () => {
    const result = toRun(
      run({
        event: 'pull_request',
        head_branch: '',
        path: 'pr.yml@refs/pull/81/head',
        pull_requests: [{ number: 81, base: { ref: 'test' } }],
      }),
      ctx()
    );
    expect(result.prNumber).toBe(81);
    expect(result.baseRef).toBe('test');
  });

  it('T056: falls back to the path-parsed prNumber with no baseRef when pull_requests is empty (older Gitea/event)', () => {
    const result = toRun(
      run({ event: 'pull_request', head_branch: '', path: 'pr.yml@refs/pull/81/head', pull_requests: [] }),
      ctx()
    );
    expect(result.prNumber).toBe(81);
    expect(result.baseRef).toBeUndefined();
  });

  it('is not mine when the PR number is not in my open PRs', () => {
    const myOpenPrs = new Map([['acme/platform', new Set([99])]]);
    const result = toRun(
      run({
        actor: { login: 'alice' },
        trigger_actor: { login: 'alice' },
        pull_requests: [{ number: 12 }],
      }),
      ctx({ me: 'me', myOpenPrs })
    );
    expect(result.mine).toBe(false);
    expect(result.group).toBe('others');
  });

  it('groups a pinned repo as mine even when not actually mine', () => {
    const result = toRun(
      run({ actor: { login: 'alice' }, trigger_actor: { login: 'alice' } }),
      ctx({ me: 'me', pinned: new Set(['acme/platform']) })
    );
    expect(result.mine).toBe(false);
    expect(result.group).toBe('mine');
  });

  it('groups a non-mine, non-pinned run as others', () => {
    const result = toRun(
      run({ actor: { login: 'alice' }, trigger_actor: { login: 'alice' } }),
      ctx({ me: 'me' })
    );
    expect(result.group).toBe('others');
  });
});

describe('buildRunList', () => {
  const activeRuns = runsActiveFixture.workflow_runs as unknown as ApiActionWorkflowRun[];
  const recentRuns = runsRecentFixture.workflow_runs as unknown as ApiActionWorkflowRun[];
  const floodRuns = runsFloodFixture.workflow_runs as unknown as ApiActionWorkflowRun[];
  const mineRuns = runsMineFixture.workflow_runs as unknown as ApiActionWorkflowRun[];

  it('dedupes by id, keeping the highest attempt', () => {
    const base = run({ id: 42, run_attempt: 1, conclusion: 'failure' });
    const retried = run({ id: 42, run_attempt: 2, conclusion: 'success' });
    const result = buildRunList([[base], [retried]], ctx(), NOW, 24);
    expect(result).toHaveLength(1);
    expect(result[0]?.attempt).toBe(2);
    expect(result[0]?.state).toBe('success');
  });

  it('drops completed runs older than the recent window', () => {
    const fresh = run({ id: 1, completed_at: '2026-09-26T09:00:00Z' });
    const stale = run({ id: 2, completed_at: '2026-09-24T09:00:00Z' });
    const result = buildRunList([[fresh, stale]], ctx(), NOW, 24);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('never drops active runs regardless of age', () => {
    const oldActive = run({
      id: 3,
      status: 'in_progress',
      conclusion: undefined,
      started_at: '2026-09-01T00:00:00Z',
      completed_at: '',
    });
    const result = buildRunList([[oldActive]], ctx(), NOW, 24);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('sorts active runs before completed, then by startedAt desc', () => {
    const older = run({
      id: 1,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-09-26T05:00:00Z',
      completed_at: '2026-09-26T05:05:00Z',
    });
    const newer = run({
      id: 2,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-09-26T08:00:00Z',
      completed_at: '2026-09-26T08:05:00Z',
    });
    const active = run({
      id: 3,
      status: 'in_progress',
      conclusion: undefined,
      started_at: '2026-09-26T01:00:00Z',
      completed_at: '',
    });
    const result = buildRunList([[older, newer, active]], ctx(), NOW, 24);
    expect(result.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('T057: a waiting/blocked run without started_at sorts at the top of the active group (ties by id desc)', () => {
    const runningWithTime = run({
      id: 1,
      status: 'in_progress',
      conclusion: undefined,
      started_at: '2026-09-26T01:00:00Z',
      completed_at: '',
    });
    const waitingNoTime = run({
      id: 2,
      status: 'queued',
      conclusion: undefined,
      started_at: '0001-01-01T00:00:00Z',
      completed_at: '',
    });
    const blockedNoTime = run({
      id: 3,
      status: 'waiting',
      conclusion: undefined,
      started_at: '0001-01-01T00:00:00Z',
      completed_at: '',
    });
    const completed = run({
      id: 4,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-09-26T08:00:00Z',
      completed_at: '2026-09-26T08:05:00Z',
    });
    const result = buildRunList([[runningWithTime, waitingNoTime, blockedNoTime, completed]], ctx(), NOW, 24);
    // Waiting/blocked without a real time come before an already-running run
    // with a real startedAt (they're current, not "oldest") — completed last.
    expect(result.map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });

  it('merges runs-active + runs-recent fixtures without throwing and reads every run', () => {
    const result = buildRunList([activeRuns, recentRuns], ctx(), NOW, 24);
    const ids = result.map((r) => r.id);
    for (const r of activeRuns) {
      expect(ids).toContain(r.id);
    }
  });

  it('keeps every "mine" run present when merged with a flood of others (research R4)', () => {
    const result = buildRunList([floodRuns, mineRuns], ctx({ me: 'me' }), NOW, 24);
    const ids = new Set(result.map((r) => r.id));
    for (const r of mineRuns) {
      expect(ids.has(r.id)).toBe(true);
    }
  });
});

describe('runCounts', () => {
  it('counts active mine, active others and failed others', () => {
    const runs = [
      toRun(run({ id: 1, status: 'in_progress', conclusion: undefined, actor: { login: 'me' } }), ctx({ me: 'me' })),
      toRun(run({ id: 2, status: 'in_progress', conclusion: undefined, actor: { login: 'alice' } }), ctx({ me: 'me' })),
      toRun(run({ id: 3, status: 'completed', conclusion: 'failure', actor: { login: 'alice' } }), ctx({ me: 'me' })),
      toRun(run({ id: 4, status: 'completed', conclusion: 'success', actor: { login: 'alice' } }), ctx({ me: 'me' })),
    ];
    expect(runCounts(runs)).toEqual({
      activeMine: 1,
      activeOthers: 1,
      failedOthers: 1,
    });
  });

  it('returns zeros for an empty list', () => {
    expect(runCounts([])).toEqual({
      activeMine: 0,
      activeOthers: 0,
      failedOthers: 0,
    });
  });
});

describe('toRun dirty data (T054)', () => {
  it('no head_branch and no path -> branch is an empty string, other strings default to empty', () => {
    const raw = {
      ...run({}),
      head_branch: undefined,
      path: undefined,
      event: undefined,
      display_title: undefined,
    } as unknown as ApiActionWorkflowRun;
    const r = toRun(raw, ctx());
    expect(r.branch).toBe('');
    expect(r.event).toBe('');
    expect(r.title).toBe('');
    expect(typeof r.workflow).toBe('string');
  });
});

describe('toRun zero timestamps (T055)', () => {
  it('a never-started run (Gitea epoch started_at/completed_at) has no startedAt/completedAt', () => {
    const r = toRun(
      run({ status: 'waiting', conclusion: '', started_at: '1970-01-01T05:00:00+05:00', completed_at: '1970-01-01T05:00:00+05:00' }),
      ctx()
    );
    expect(r.startedAt).toBeUndefined();
    expect(r.completedAt).toBeUndefined();
  });

  it('Go zero time 0001-01-01 is dropped too; a cancelled-before-start run keeps its real completed_at', () => {
    const r = toRun(
      run({ conclusion: 'cancelled', started_at: '0001-01-01T00:00:00Z', completed_at: '2026-09-26T09:05:00Z' }),
      ctx()
    );
    expect(r.startedAt).toBeUndefined();
    expect(r.completedAt).toBe('2026-09-26T09:05:00Z');
  });
});
