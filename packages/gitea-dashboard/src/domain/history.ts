// Build history for the "history" view of the Builds section (US4).
// Pure functions over domain Run/RunHistoryFilter — no browser APIs here.
// Source of truth: docs/specs/002-fullpage-dashboard/data-model.md
// "RunHistoryFilter", "RunHistoryCache", "RunStats"; research.md R5/R6.

import { ACTIVE_RUN_STATES, type PullRequest, type Run, type RunState } from './types';
import type { RunHistoryFilter, RunHistoryKind, RunHistoryPeriod, RunHistorySortColumn, PrSortDirection } from './route';

// ---------------------------------------------------------------------------
// buildPrIndex / runBranchDisplay / branchFacetValue / prLinkUrl (T056)
//
// Gitea's PR check runs (`event: pull_request`) have `head_branch: null` and
// carry the PR number in `path` (`pr.yml@refs/pull/81/head`) instead — the
// branch column looks up the PR's target branch (`base.ref`) from the active
// instance's PR snapshot via this index, and falls back to a plain "#81"
// link (contracts: run.htmlUrl minus its `/actions/...` suffix) when the PR
// isn't in the snapshot or predates T056 (no `baseRef` cached yet).
// ---------------------------------------------------------------------------

/** `owner/name#number` key shared by `buildPrIndex` and `runBranchDisplay`. */
function prIndexKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`;
}

/**
 * Indexes `prs` (typically the active instance's last snapshot) by
 * repo+number, keeping each PR's `baseRef` (possibly `undefined` for a PR
 * cached before T056 — tolerated as "unknown", same as a PR not found).
 */
export function buildPrIndex(prs: readonly PullRequest[]): Map<string, string | undefined> {
  const index = new Map<string, string | undefined>();
  for (const pr of prs) {
    index.set(prIndexKey(pr.repo.owner, pr.repo.name, pr.number), pr.baseRef);
  }
  return index;
}

/** The PR's target-branch URL, derived from a run's own `htmlUrl` (no extra request). */
export function prLinkUrl(run: Pick<Run, 'htmlUrl' | 'prNumber'>): string {
  const base = run.htmlUrl.replace(/\/actions\/.*$/, '');
  return `${base}/pulls/${run.prNumber}`;
}

export type RunBranchDisplay =
  | { kind: 'branch'; branch: string }
  | { kind: 'pr'; prNumber: number; baseRef: string | undefined; prUrl: string };

/**
 * What the branch column/facet should show for `run`: a plain branch tag for
 * non-PR runs, or (for a PR check run) its PR number plus — when known — the
 * target branch from `prIndex` (`buildPrIndex`).
 */
export function runBranchDisplay(
  run: Run,
  prIndex: ReadonlyMap<string, string | undefined>
): RunBranchDisplay {
  if (run.prNumber === undefined) {
    return { kind: 'branch', branch: run.branch };
  }
  const key = prIndexKey(run.repo.owner, run.repo.name, run.prNumber);
  return {
    kind: 'pr',
    prNumber: run.prNumber,
    // The run's own baseRef (straight from Gitea, works for closed PRs) wins
    // over the snapshot lookup, which only knows about currently-open PRs.
    baseRef: run.baseRef ?? prIndex.get(key),
    prUrl: prLinkUrl(run),
  };
}

/** Branch facet/filter value for `run`: the target branch for a known PR run, else the plain branch. */
export function branchFacetValue(run: Run, prIndex: ReadonlyMap<string, string | undefined>): string {
  const display = runBranchDisplay(run, prIndex);
  return display.kind === 'branch' ? display.branch : (display.baseRef ?? '');
}

// ---------------------------------------------------------------------------
// mergeRunPages
// ---------------------------------------------------------------------------

/** `waiting`/`blocked`/`running` with no `startedAt` (T057): a run that hasn't
 * started yet has no real timestamp to sort by, but it is *current* — the
 * opposite of "oldest". */
function isActiveNoTime(run: Run): boolean {
  return run.startedAt === undefined && (ACTIVE_RUN_STATES as readonly string[]).includes(run.state);
}

/**
 * A run's point in time for "started" sorting: its real `startedAt`, or
 * (T057) `+Infinity` for an active run with no time yet (waiting/blocked, or
 * running without a timestamp — it is current, sorts as the newest), or `0`
 * for anything else missing a time (e.g. a run cancelled before it started).
 */
function startedMs(run: Run): number {
  if (run.startedAt) return new Date(run.startedAt).getTime();
  return isActiveNoTime(run) ? Number.POSITIVE_INFINITY : 0;
}

/**
 * Merges paginated run lists (e.g. across multiple fetched pages/sources),
 * deduplicating by `id` and keeping the highest `attempt` (a retried run
 * appears more than once across pages; on an equal attempt the copy from the
 * later list wins), then sorts by `startedAt` desc — a waiting/blocked run
 * with no `startedAt` yet sorts FIRST (T057: it is current, not oldest;
 * otherwise it could be trimmed out of the cache by `RUN_HISTORY_MAX` and
 * never shown until it actually starts). Ties (equal timestamps, or several
 * waiting/blocked runs) break by `id` desc (higher id = newer). Runs with no
 * time and no longer active (e.g. cancelled before starting) still sort
 * last, treated as oldest.
 */
export function mergeRunPages(pages: Run[][]): Run[] {
  const byId = new Map<number, Run>();
  for (const page of pages) {
    for (const run of page) {
      const existing = byId.get(run.id);
      // T055: an equal attempt from a later list is a newer copy of the same
      // run (e.g. waiting -> started) — the later list wins; callers pass the
      // cached pages first and the freshly fetched ones last.
      if (!existing || run.attempt >= existing.attempt) {
        byId.set(run.id, run);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const av = startedMs(a);
    const bv = startedMs(b);
    return av === bv ? b.id - a.id : bv - av;
  });
}

// ---------------------------------------------------------------------------
// periodStart
// ---------------------------------------------------------------------------

const PERIOD_MS: Record<Exclude<RunHistoryPeriod, 'today'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Almaty is a fixed UTC+5 (no DST since 2024). */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * The ISO timestamp that starts the given period. `today` is midnight
 * Almaty (UTC+5) of the day containing `now`; the others count back from
 * `now`.
 */
export function periodStart(period: RunHistoryPeriod, now: string): string {
  const nowMs = new Date(now).getTime();
  if (period === 'today') {
    const shifted = nowMs + ALMATY_OFFSET_MS;
    return new Date(shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - ALMATY_OFFSET_MS).toISOString();
  }
  return new Date(nowMs - PERIOD_MS[period]).toISOString();
}

/**
 * T058: whether `run` belongs to the period starting at `periodStartMs`, for
 * merging live poller/snapshot runs into an already-loaded history page. An
 * active run (`waiting`/`blocked`/`running`) always passes regardless of its
 * own timestamp — it's current by definition, the same "always visible"
 * guarantee FR-109 gives the live poller — while any other run is judged by
 * its own `startedAt`/`completedAt`.
 */
export function runInPeriod(run: Run, periodStartMs: number): boolean {
  if ((ACTIVE_RUN_STATES as readonly string[]).includes(run.state)) return true;
  const at = run.startedAt ?? run.completedAt;
  if (!at) return false;
  return new Date(at).getTime() >= periodStartMs;
}

// ---------------------------------------------------------------------------
// classifyRun / runsOfKind (rev.5, FR-125)
// ---------------------------------------------------------------------------

export type RunKind = 'release' | 'build' | 'check';

const VERSION_RE = /^v?\d+\.\d+\.\d+/;
const BUILD_BRANCHES: readonly string[] = ['test', 'main', 'master'];

/** `refs/tags/v1.2.3` / `refs/heads/main` -> short name; other values unchanged. */
function shortRef(ref: string | null | undefined): string {
  return (ref ?? '').replace(/^refs\/(?:tags|heads)\//, '');
}

/**
 * Classifies a run from its own fields (no API calls): `release` = event
 * `release`, or the ref/branch (tag name) is a version `vX.Y.Z` (the title is
 * NOT used: it is the head commit message, e.g. "... into main");
 * `build` = not a pull_request and on test/main/master/release/*; the rest
 * (PR checks, feature-branch pushes, ...) is `check`.
 */
export function classifyRun(run: Run): RunKind {
  const branch = shortRef(run.branch);
  if (run.event === 'release' || VERSION_RE.test(branch)) {
    return 'release';
  }
  if (run.event === 'pull_request') return 'check';
  if (BUILD_BRANCHES.includes(branch) || branch.startsWith('release/')) return 'build';
  return 'check';
}

/** The "Сборки" tab = release + build; "Все запуски" = everything. */
export function runsOfKind(runs: Run[], kind: RunHistoryKind): Run[] {
  return kind === 'all' ? runs : runs.filter((r) => classifyRun(r) !== 'check');
}

// ---------------------------------------------------------------------------
// coversPeriod
// ---------------------------------------------------------------------------

export interface PeriodCoverage {
  /** Whether every run in `[periodStart, now]` has been fetched. */
  covered: boolean;
  /**
   * The oldest point in time we actually have data for (the oldest fetched
   * run's `startedAt`), i.e. "period covered until this timestamp" per
   * research.md R5's "показать ещё" / partial-coverage UI. `undefined` when
   * no runs have been fetched yet.
   */
  coveredUntil?: string;
}

/**
 * Whether the fetched `runs` cover the requested period. Covered when the
 * source is `exhausted` (no more pages exist, regardless of how far back
 * they reach) or when the oldest fetched run started at/before
 * `periodStart`.
 */
export function coversPeriod(runs: Run[], periodStart: string, exhausted: boolean): PeriodCoverage {
  const started = runs.map((r) => r.startedAt).filter((s): s is string => s !== undefined);
  started.sort();
  const oldest = started[0];

  if (exhausted) {
    return { covered: true, coveredUntil: oldest };
  }
  if (oldest !== undefined && oldest <= periodStart) {
    return { covered: true, coveredUntil: oldest };
  }
  return { covered: false, coveredUntil: oldest };
}

// ---------------------------------------------------------------------------
// filterRuns
// ---------------------------------------------------------------------------

function repoKey(run: Run): string {
  return `${run.repo.owner}/${run.repo.name}`;
}

/**
 * Filters runs by the repo/workflow/branch/event/result sets and the "only
 * mine" flag from a RunHistoryFilter (empty set = no constraint on that
 * facet, per data-model.md RunHistoryFilter). `me` is the signed-in login,
 * used as a fallback alongside the already-computed `run.mine` (research
 * R6: "Мои = правило mine из 001").
 */
const EMPTY_PR_INDEX: ReadonlyMap<string, string | undefined> = new Map();

/**
 * `prIndex` (T056, `buildPrIndex`) is optional: callers that don't have a PR
 * snapshot handy (or don't care about PR branch filtering) keep filtering
 * PR check runs by their (empty) `run.branch`, same as before T056.
 */
export function filterRuns(
  runs: Run[],
  filter: RunHistoryFilter,
  me: string,
  prIndex: ReadonlyMap<string, string | undefined> = EMPTY_PR_INDEX
): Run[] {
  const repoSet = filter.repo.length > 0 ? new Set(filter.repo) : undefined;
  const wfSet = filter.wf.length > 0 ? new Set(filter.wf) : undefined;
  const branchSet = filter.branch.length > 0 ? new Set(filter.branch) : undefined;
  const eventSet = filter.event.length > 0 ? new Set(filter.event) : undefined;
  const resultSet = filter.result.length > 0 ? new Set<RunState>(filter.result) : undefined;

  return runs.filter((run) => {
    if (repoSet && !repoSet.has(repoKey(run))) return false;
    if (wfSet && !wfSet.has(run.workflow)) return false;
    if (branchSet && !branchSet.has(branchFacetValue(run, prIndex))) return false;
    if (eventSet && !eventSet.has(run.event)) return false;
    if (resultSet && !resultSet.has(run.state)) return false;
    if (filter.mine && !(run.mine || run.actor === me)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// runStats
// ---------------------------------------------------------------------------

export interface RunStatsByWorkflow {
  workflow: string;
  total: number;
  failed: number;
  avgDurationSec?: number;
}

export interface RunStats {
  total: number;
  completed: number;
  failed: number;
  failureRate: number;
  avgDurationSec?: number;
  medianDurationSec?: number;
  byWorkflow: RunStatsByWorkflow[];
}

const COMPLETED_STATES: readonly RunState[] = ['success', 'failure', 'cancelled'];

function isCompleted(state: RunState): boolean {
  return (COMPLETED_STATES as readonly string[]).includes(state);
}

function isZeroTime(value: string): boolean {
  return value.startsWith('0001-01-01');
}

/**
 * Duration in seconds for a completed run, or `undefined` when the run has
 * no usable duration: missing `startedAt`/`completedAt`, Gitea's zero-time
 * sentinel (`0001-01-01...`), or a zero/negative span (research R6:
 * "отбрасывая пустые/нулевые времена").
 */
export function durationSec(run: Run): number | undefined {
  if (!run.startedAt || !run.completedAt) return undefined;
  if (isZeroTime(run.startedAt) || isZeroTime(run.completedAt)) return undefined;
  const startedAtMs = new Date(run.startedAt).getTime();
  const completedAtMs = new Date(run.completedAt).getTime();
  if (Number.isNaN(startedAtMs) || Number.isNaN(completedAtMs)) return undefined;
  const diffMs = completedAtMs - startedAtMs;
  if (diffMs <= 0) return undefined;
  return diffMs / 1000;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1] as number;
    const upper = sorted[mid] as number;
    return (lower + upper) / 2;
  }
  return sorted[mid] as number;
}

/**
 * Aggregate statistics over a set of runs (research R6): total (all runs,
 * any state), completed (success+failure+cancelled; skipped/active
 * excluded), failed count, failureRate over completed only, avg/median
 * duration over completed runs with a usable duration, and a per-workflow
 * breakdown sorted by total desc (ties broken by workflow name for a
 * deterministic order).
 */
export function runStats(runs: Run[]): RunStats {
  const byWorkflowMap = new Map<
    string,
    { total: number; failed: number; durations: number[] }
  >();

  let completed = 0;
  let failed = 0;
  const durations: number[] = [];

  for (const run of runs) {
    const entry = byWorkflowMap.get(run.workflow) ?? { total: 0, failed: 0, durations: [] };
    entry.total += 1;

    const completedRun = isCompleted(run.state);
    const failedRun = run.state === 'failure';
    if (completedRun) {
      completed += 1;
    }
    if (failedRun) {
      failed += 1;
      entry.failed += 1;
    }
    if (completedRun) {
      const duration = durationSec(run);
      if (duration !== undefined) {
        durations.push(duration);
        entry.durations.push(duration);
      }
    }

    byWorkflowMap.set(run.workflow, entry);
  }

  const byWorkflow = Array.from(byWorkflowMap.entries())
    .map(([workflow, entry]) => ({
      workflow,
      total: entry.total,
      failed: entry.failed,
      avgDurationSec: average(entry.durations),
    }))
    .sort((a, b) => b.total - a.total || (a.workflow ?? '').localeCompare(b.workflow ?? ''));

  return {
    total: runs.length,
    completed,
    failed,
    failureRate: completed === 0 ? 0 : failed / completed,
    avgDurationSec: average(durations),
    medianDurationSec: median(durations),
    byWorkflow,
  };
}

// ---------------------------------------------------------------------------
// sortRuns
// ---------------------------------------------------------------------------

/**
 * Sorts runs by `started` (startedAt; a waiting/blocked run with no time yet
 * sorts FIRST for `desc` and LAST for `asc` — T057: it is current, not
 * oldest; ties among such runs, or equal timestamps, always break by `id`
 * desc, higher id = newer) or `duration` (missing duration treated as
 * shortest/0), ascending or descending. Returns a new array; does not mutate
 * `runs`.
 */
export function sortRuns(
  runs: Run[],
  column: RunHistorySortColumn,
  direction: PrSortDirection
): Run[] {
  const sorted = [...runs];
  if (column === 'started') {
    sorted.sort((a, b) => {
      const av = startedMs(a);
      const bv = startedMs(b);
      if (av === bv) return b.id - a.id;
      return direction === 'asc' ? av - bv : bv - av;
    });
    return sorted;
  }
  const value = (run: Run): number => durationSec(run) ?? -1;
  sorted.sort((a, b) => (direction === 'asc' ? value(a) - value(b) : value(b) - value(a)));
  return sorted;
}
