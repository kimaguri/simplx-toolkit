// "Сборки" — build stage (US6, rev.2). Loads per-run job/step detail for
// the currently visible, still-running runs so the page can show a
// "current stage" and an expandable job/step breakdown.
//
// Source of truth: docs/specs/002-fullpage-dashboard/research.md R9, tasks.md
// T033.
//
// Algorithm (R9): once per page heartbeat cycle, `load(runs, me)` fetches
// jobs for at most 10 of the currently visible *active* runs (state
// running|waiting|blocked), prioritizing the caller's own runs first, then
// newest-started first. Active runs are re-fetched every call (no
// freshness window — the caller controls the cadence via the heartbeat).
// A completed run's jobs, once explicitly requested for an expanded row
// via `loadOne(run)`, are cached forever (no refetch) since a finished
// run's jobs never change. The same permanent caching (plus a derived
// `finalState`) also kicks in the moment ANY fetch — from `load()` or
// `loadOne()` — comes back with every job `completed`, even if the
// caller's own `run.state` hasn't caught up to that yet (T042 M1).
//
// Errors: a 401 (`ApiError.kind === 'auth'`) aborts the whole `load`/
// `loadOne` call (rethrown), same auth-pause semantics used elsewhere in
// this extension. Any other failure for a single run is caught and
// recorded as `{ unavailable: true }` for that run only — the rest of the
// batch still loads.

import { ApiError, createClient, type ApiClient, type ClientOptions } from '../../api/client';
import { createEndpoints, type Endpoints } from '../../api/endpoints';
import type { ApiWorkflowJob } from '../../api/types';
import { ACTIVE_RUN_STATES, type Run } from '../../domain/types';
import * as storage from '../../lib/storage';

const MAX_RUNS_PER_LOAD = 10;

// ---------------------------------------------------------------------------
// StageInfo / currentStage
// ---------------------------------------------------------------------------

export interface StageInfoUnavailable {
  unavailable: true;
}

/** The run's overall outcome, derived from its jobs once every job/step is `completed` (M1). */
export type FinalRunState = 'success' | 'failure' | 'cancelled';

export interface StageInfoLoaded {
  unavailable?: false;
  jobs: ApiWorkflowJob[];
  /**
   * Set once every job in `jobs` has `status === 'completed'` — the run is
   * finished and this entry is cached forever (M1). `undefined` while the
   * run still has jobs in progress/queued.
   */
  finalState?: FinalRunState;
}

export type StageInfo = StageInfoUnavailable | StageInfoLoaded;

/** True once every job has `status === 'completed'` (a non-empty job list). */
function allJobsCompleted(jobs: ApiWorkflowJob[]): boolean {
  return jobs.length > 0 && jobs.every((job) => job.status === 'completed');
}

/**
 * Any job `conclusion === 'failure'` → 'failure'; else any 'cancelled' →
 * 'cancelled'; else 'success'. Only meaningful once `allJobsCompleted`.
 */
export function derivedFinalState(jobs: ApiWorkflowJob[]): FinalRunState {
  if (jobs.some((job) => job.conclusion === 'failure')) return 'failure';
  if (jobs.some((job) => job.conclusion === 'cancelled')) return 'cancelled';
  return 'success';
}

export interface CurrentStage {
  jobName: string;
  stepName: string;
  /** The step's own `number` (1-based, as returned by the API). */
  index: number;
  total: number;
}

function findStage(jobs: ApiWorkflowJob[], statuses: readonly string[]): CurrentStage | undefined {
  for (const job of jobs) {
    const steps = job.steps ?? [];
    const step = steps.find((s) => statuses.includes(s.status));
    if (step) {
      return { jobName: job.name, stepName: step.name, index: step.number, total: steps.length };
    }
  }
  return undefined;
}

/**
 * The run's current stage: the first in_progress job/step, else the first
 * queued/waiting job/step, else `undefined` (nothing left running/pending —
 * e.g. every job is completed).
 */
export function currentStage(jobs: ApiWorkflowJob[]): CurrentStage | undefined {
  return findStage(jobs, ['in_progress']) ?? findStage(jobs, ['queued', 'waiting']);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface RunJobsLoaderDeps {
  clientFactory?: (args: ClientOptions) => ApiClient;
  now?: () => Date;
}

export interface RunJobsLoader {
  /**
   * Fetches jobs for up to `MAX_RUNS_PER_LOAD` of `runs` that are currently
   * active (running|waiting|blocked), prioritizing `run.mine` (or
   * `run.actor === me`), then newest `startedAt` first. Returns a snapshot
   * of the loader's whole in-memory cache (including runs from earlier
   * calls/`loadOne`), keyed by `${run.id}:${run.attempt}`.
   */
  load(runs: Run[], me: string): Promise<Map<string, StageInfo>>;
  /**
   * Fetches (once) and caches forever the jobs for a single run — meant for
   * a row the user explicitly expanded, typically a completed run that
   * `load()` never touches.
   */
  loadOne(run: Run): Promise<StageInfo>;
  /** Reads the loader's in-memory cache without triggering a fetch. */
  get(runKey: string): StageInfo | undefined;
}

function runKey(run: Run): string {
  return `${run.id}:${run.attempt}`;
}

function isActive(run: Run): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(run.state);
}

function priorityRank(run: Run, me: string): number {
  // LOW: an empty `me` (login not yet known) must never match an equally
  // empty `run.actor` as "mine".
  return run.mine || (me !== '' && run.actor === me) ? 1 : 0;
}

function startedAtMs(run: Run): number {
  return run.startedAt ? new Date(run.startedAt).getTime() : 0;
}

export function createRunJobsLoader(deps: RunJobsLoaderDeps = {}): RunJobsLoader {
  const clientFactory = deps.clientFactory ?? createClient;
  const cache = new Map<string, StageInfo>();
  const permanentKeys = new Set<string>();

  async function getEndpoints(): Promise<Endpoints | undefined> {
    const { instances, activeInstanceId } = await storage.getInstances();
    if (!activeInstanceId) return undefined;
    const instance = instances.find((i) => i.id === activeInstanceId);
    if (!instance) return undefined;
    const token = await storage.getToken(instance.id);
    if (!token) return undefined;
    const client = clientFactory({ baseUrl: instance.baseUrl, token });
    return createEndpoints(client);
  }

  async function fetchInto(endpoints: Endpoints, run: Run, key: string, forcePermanent: boolean): Promise<void> {
    try {
      const jobs = await endpoints.runJobs(run.repo.owner, run.repo.name, run.id);
      // M1: once every job is `completed`, the run is finished — cache it
      // forever and record its derived overall outcome, regardless of what
      // the caller's own `run.state` still says.
      const finished = allJobsCompleted(jobs);
      const info: StageInfoLoaded = finished ? { jobs, finalState: derivedFinalState(jobs) } : { jobs };
      cache.set(key, info);
      if (forcePermanent || finished) permanentKeys.add(key);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'auth') {
        throw err;
      }
      // A single run's failure (404/403/5xx) is isolated — record it as
      // unavailable and let the rest of the batch keep loading.
      cache.set(key, { unavailable: true });
    }
  }

  return {
    async load(runs, me) {
      // M1: a run whose jobs already all came back `completed` (finished,
      // permanently cached) is never refetched here even if the caller's
      // own `run.state` hasn't caught up yet.
      const active = runs.filter((run) => isActive(run) && !permanentKeys.has(runKey(run)));
      const prioritized = [...active].sort((a, b) => {
        const rankDiff = priorityRank(b, me) - priorityRank(a, me);
        if (rankDiff !== 0) return rankDiff;
        return startedAtMs(b) - startedAtMs(a);
      });
      const toFetch = prioritized.slice(0, MAX_RUNS_PER_LOAD);

      const endpoints = await getEndpoints();
      if (!endpoints) return new Map(cache);

      for (const run of toFetch) {
        await fetchInto(endpoints, run, runKey(run), false);
      }

      return new Map(cache);
    },

    async loadOne(run) {
      const key = runKey(run);
      if (permanentKeys.has(key)) {
        return cache.get(key)!;
      }

      const endpoints = await getEndpoints();
      if (!endpoints) {
        const info: StageInfo = { unavailable: true };
        cache.set(key, info);
        return info;
      }

      // M3: forced-permanent caching only applies to a non-active run (the
      // typical "expand a completed row" case) — an active run's `loadOne`
      // is only cached forever once its jobs actually come back completed
      // (handled by `fetchInto` itself via `finished`).
      await fetchInto(endpoints, run, key, !isActive(run));
      return cache.get(key)!;
    },

    get(key) {
      return cache.get(key);
    },
  };
}
