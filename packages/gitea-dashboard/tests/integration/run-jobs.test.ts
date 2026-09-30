// Contract: docs/specs/002-fullpage-dashboard/research.md R9, tasks.md T033
// (Phase 9, US6).
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL
// pathname+query (like tests/integration/history-fetch.test.ts). No real
// HTTP is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import type { ApiWorkflowJob } from '../../src/api/types';
import { createRunJobsLoader, currentStage } from '../../src/features/builds/run-jobs';
import type { Instance, Run } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

import runJobsFixture from '../fixtures/run-jobs.json';

const BASE_URL = 'https://git.example.test';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_runjobstest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'org', notifications: true, orgs: ['acme'], missingScopes: [] },
    ...overrides,
  };
}

async function setUp(inst: Instance): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
}

function mkRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'sha1',
    htmlUrl: 'https://git.example.test/acme/platform/actions/runs/1',
    title: 'push #1',
    workflow: 'ci.yml',
    state: 'running',
    startedAt: '2026-09-28T09:00:00Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

type Handler = (url: URL) => unknown | Promise<unknown>;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function makeFetchMock(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = routes.find((r) => r.match(url));
    if (!route) {
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    const body = await route.handler(url);
    return jsonResponse(body, route.status ?? 200);
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

const JOBS_PATH_RE = /^\/repos\/acme\/platform\/actions\/runs\/(\d+)\/jobs$/;

function jobsRoute(handler: (runId: number, url: URL) => unknown, status?: number): Route {
  return {
    match: (u) => JOBS_PATH_RE.test(path(u)),
    handler: (u) => {
      const match = JOBS_PATH_RE.exec(path(u))!;
      return handler(Number(match[1]), u);
    },
    status,
  };
}

describe('run-jobs loader (T033)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('load(): fetches at most 10 active runs, prioritizing mine, then newest', async () => {
    const inst = instance();
    await setUp(inst);

    const requestedIds: number[] = [];
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute((runId) => {
          requestedIds.push(runId);
          return runJobsFixture;
        }),
      ]).getMockImplementation()!
    );

    // 4 "mine" runs (ids 1-4) + 8 "others" runs (ids 5-12, newest = highest id).
    const mine = [1, 2, 3, 4].map((id) =>
      mkRun({ id, mine: true, group: 'mine', startedAt: `2026-09-28T08:0${id}:00Z` })
    );
    const others = [5, 6, 7, 8, 9, 10, 11, 12].map((id) =>
      mkRun({ id, mine: false, group: 'others', startedAt: `2026-09-28T09:${String(id).padStart(2, '0')}:00Z` })
    );

    const loader = createRunJobsLoader();
    const result = await loader.load([...mine, ...others], 'me');

    expect(requestedIds).toHaveLength(10);
    // All 4 "mine" runs are fetched, plus the 6 newest "others" (12..7),
    // excluding the 2 oldest "others" (5, 6).
    expect([...requestedIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
    expect(result.size).toBe(10);
    expect(result.get('1:1')).toEqual({ jobs: runJobsFixture.jobs });
  });

  it('load(): skips non-active runs (not running/waiting/blocked)', async () => {
    const inst = instance();
    await setUp(inst);

    const requestedIds: number[] = [];
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute((runId) => {
          requestedIds.push(runId);
          return runJobsFixture;
        }),
      ]).getMockImplementation()!
    );

    const runs = [
      mkRun({ id: 1, state: 'running' }),
      mkRun({ id: 2, state: 'waiting' }),
      mkRun({ id: 3, state: 'blocked' }),
      mkRun({ id: 4, state: 'success' }),
      mkRun({ id: 5, state: 'failure' }),
      mkRun({ id: 6, state: 'cancelled' }),
    ];

    const loader = createRunJobsLoader();
    const result = await loader.load(runs, 'me');

    expect([...requestedIds].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.has('4:1')).toBe(false);
    expect(result.has('5:1')).toBe(false);
    expect(result.has('6:1')).toBe(false);
  });

  it('load(): re-fetches active runs on every call (no freshness cache)', async () => {
    const inst = instance();
    await setUp(inst);

    let calls = 0;
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute(() => {
          calls += 1;
          return runJobsFixture;
        }),
      ]).getMockImplementation()!
    );

    const loader = createRunJobsLoader();
    const run = mkRun({ id: 100, state: 'running' });

    await loader.load([run], 'me');
    await loader.load([run], 'me');

    expect(calls).toBe(2);
  });

  it('loadOne(): fetches a completed run once and caches it forever (no refetch)', async () => {
    const inst = instance();
    await setUp(inst);

    let calls = 0;
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute(() => {
          calls += 1;
          return runJobsFixture;
        }),
      ]).getMockImplementation()!
    );

    const loader = createRunJobsLoader();
    const run = mkRun({ id: 200, attempt: 1, state: 'success' });

    const first = await loader.loadOne(run);
    const second = await loader.loadOne(run);

    expect(calls).toBe(1);
    expect(first).toEqual({ jobs: runJobsFixture.jobs });
    expect(second).toEqual({ jobs: runJobsFixture.jobs });
    expect(loader.get('200:1')).toEqual({ jobs: runJobsFixture.jobs });
  });

  it('load(): a per-run error (5xx) is isolated to that run — sets unavailable, other runs still load', async () => {
    const inst = instance();
    await setUp(inst);

    fetchMock.mockImplementation(
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const match = JOBS_PATH_RE.exec(path(url));
        if (!match) throw new Error(`unexpected request: ${path(url)}`);
        const runId = Number(match[1]);
        if (runId === 1) return jsonResponse({}, 500);
        return jsonResponse(runJobsFixture, 200);
      })
    );

    const loader = createRunJobsLoader();
    const runs = [mkRun({ id: 1, state: 'running' }), mkRun({ id: 2, state: 'running' })];

    const result = await loader.load(runs, 'me');

    expect(result.get('1:1')).toEqual({ unavailable: true });
    expect(result.get('2:1')).toEqual({ jobs: runJobsFixture.jobs });
  });

  it('load(): a 401 throws an auth ApiError', async () => {
    const inst = instance();
    await setUp(inst);

    fetchMock.mockImplementation(
      vi.fn(async () => jsonResponse({}, 401))
    );

    const loader = createRunJobsLoader();
    const runs = [mkRun({ id: 1, state: 'running' })];

    await expect(loader.load(runs, 'me')).rejects.toMatchObject({ name: 'ApiError', kind: 'auth' });
    void ApiError;
  });

  it('load(): all jobs completed → finished, derived finalState, permanently cached (no refetch)', async () => {
    const inst = instance();
    await setUp(inst);

    const allCompleted = {
      jobs: [
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success', steps: [] },
        { id: 2, name: 'build', status: 'completed', conclusion: 'failure', steps: [] },
      ],
    };

    let calls = 0;
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute(() => {
          calls += 1;
          return allCompleted;
        }),
      ]).getMockImplementation()!
    );

    const loader = createRunJobsLoader();
    // `run.state` still says 'running' (the runs list hasn't caught up yet)
    // even though the jobs endpoint already shows everything completed.
    const run = mkRun({ id: 300, state: 'running' });

    const first = await loader.load([run], 'me');
    expect(first.get('300:1')).toEqual({ jobs: allCompleted.jobs, finalState: 'failure' });

    const second = await loader.load([run], 'me');
    expect(second.get('300:1')).toEqual({ jobs: allCompleted.jobs, finalState: 'failure' });
    expect(calls).toBe(1); // never refetched once finished

    expect(loader.get('300:1')).toEqual({ jobs: allCompleted.jobs, finalState: 'failure' });
  });

  it('load(): prioritizes "mine" runs but an empty `me` never matches an empty actor', async () => {
    const inst = instance();
    await setUp(inst);

    const requestedIds: number[] = [];
    fetchMock.mockImplementation(
      makeFetchMock([
        jobsRoute((runId) => {
          requestedIds.push(runId);
          return runJobsFixture;
        }),
      ]).getMockImplementation()!
    );

    const runs = [
      mkRun({ id: 1, mine: false, actor: '', startedAt: '2026-09-28T08:00:00Z' }),
      mkRun({ id: 2, mine: false, actor: 'bob', startedAt: '2026-09-28T09:00:00Z' }),
    ];

    const loader = createRunJobsLoader();
    await loader.load(runs, '');

    // Newest-first (id 2), NOT id 1 promoted by a false `'' === ''` match.
    expect(requestedIds).toEqual([2, 1]);
  });

  describe('currentStage (pure)', () => {
    function job(overrides: Partial<ApiWorkflowJob>): ApiWorkflowJob {
      return {
        id: 1,
        name: 'job',
        status: 'completed',
        conclusion: 'success',
        steps: [],
        ...overrides,
      };
    }

    it('returns the first in_progress job/step', () => {
      const jobs: ApiWorkflowJob[] = [
        job({
          name: 'lint',
          status: 'completed',
          steps: [
            { number: 1, name: 'Checkout', status: 'completed' },
            { number: 2, name: 'Lint', status: 'completed' },
          ],
        }),
        job({
          name: 'build',
          status: 'in_progress',
          steps: [
            { number: 1, name: 'Checkout', status: 'completed' },
            { number: 2, name: 'Install', status: 'completed' },
            { number: 3, name: 'Compile', status: 'in_progress' },
            { number: 4, name: 'Test', status: 'queued' },
          ],
        }),
      ];

      expect(currentStage(jobs)).toEqual({ jobName: 'build', stepName: 'Compile', index: 3, total: 4 });
    });

    it('falls back to the first queued/waiting step when nothing is in_progress', () => {
      const jobs: ApiWorkflowJob[] = [
        job({
          name: 'build',
          status: 'queued',
          steps: [
            { number: 1, name: 'Checkout', status: 'queued' },
            { number: 2, name: 'Compile', status: 'queued' },
          ],
        }),
      ];

      expect(currentStage(jobs)).toEqual({ jobName: 'build', stepName: 'Checkout', index: 1, total: 2 });
    });

    it('returns undefined when every job/step is completed', () => {
      const jobs: ApiWorkflowJob[] = [
        job({
          name: 'lint',
          status: 'completed',
          steps: [
            { number: 1, name: 'Checkout', status: 'completed' },
            { number: 2, name: 'Lint', status: 'completed' },
          ],
        }),
      ];

      expect(currentStage(jobs)).toBeUndefined();
    });

    it('returns undefined for an empty job list', () => {
      expect(currentStage([])).toBeUndefined();
    });

    it('matches the fixture: "build" job in_progress with step 3 in_progress', () => {
      expect(currentStage(runJobsFixture.jobs as ApiWorkflowJob[])).toEqual({
        jobName: 'build',
        stepName: 'Compile',
        index: 3,
        total: 7,
      });
    });
  });
});
