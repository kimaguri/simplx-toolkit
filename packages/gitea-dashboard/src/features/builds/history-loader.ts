// "Сборки" section, "история" view (US4, FR-111/FR-112). Loads paged Gitea
// Actions run history directly — the documented plan.md exception to the
// usual poller/snapshot flow (same shape as src/features/repos/ReposSection.tsx),
// using the active instance's token/baseUrl from src/lib/storage.ts.
//
// Source of truth: docs/specs/002-fullpage-dashboard/research.md R5,
// data-model.md "RunHistoryCache", contracts/page-surface.md "Запросы к
// Gitea", spec.md FR-111/FR-112.
//
// Algorithm (R5): for each history source (one per organization in
// `capabilities.orgs` + one per repo outside them, derived via
// `src/domain/scope.ts`'s `runSources` in `'base'` mode — the fast/base
// distinction doesn't apply to a page the user opened explicitly), fetch
// pages newest-to-oldest at `limit = max_response_items` (`GET
// /settings/api`, cached 24h) until either the oldest run on a page is at
// or before the requested period's start, or the page budget for this call
// runs out. `loadHistory`'s first-call budget is 20 requests total
// (including a possible uncached `apiSettings()` call); `loadMore` adds 5
// more page requests, continuing each source's own `nextPage` cursor.
//
// Per-source results are cached in `storage.local`
// (`runsHistory:<instanceId>:<sourceKey>`, `src/lib/storage.ts`) with a 5
// minute freshness window: a `loadHistory` call for the same period/filters
// within 5 minutes of the last fetch reuses the cached pages for every
// source that's still fresh, making 0 new requests (R5 "повторное открытие
// периода в TTL — ноль запросов"); a *different* (e.g. wider) period right
// after still reuses whatever pages are already cached instead of
// restarting from page 1 (R5 "периоды пересекаются — 30 дн переиспользует
// страницы 7 дн").
//
// Errors: a 401 (`ApiError.kind === 'auth'`) on *any* request aborts the
// whole call immediately (rethrown) — same auth-pause semantics as
// `src/background/poller/runs.ts`. Any other failure (404/403/5xx) on one
// source is caught, recorded in the returned `sourceErrors` (keyed by that
// source's base key, e.g. `org:acme`), and that source is simply skipped
// for the rest of this call (its previous cache, if any, is left
// untouched) — the other sources still contribute their runs (T067-style
// "one bad source doesn't sink the whole load").
//
// T022/T023 seam fix (orchestrator decision (a)): this loader now reuses
// `src/domain/history.ts`'s `mergeRunPages` (dedup by id keeping the
// highest attempt, sorted `startedAt` desc) instead of the private
// `mergeRuns` copy that used to live here — same behavior, one
// implementation.

import { ApiError, createClient } from '../../api/client';
import { createEndpoints, type Endpoints } from '../../api/endpoints';
import { mergeRunPages, periodStart } from '../../domain/history';
import type { RunHistoryPeriod } from '../../domain/route';
import { toRun, type RunContext } from '../../domain/runs';
import { runSources, type RunSource } from '../../domain/scope';
import type { ApiErrorKind, Run } from '../../domain/types';
import * as storage from '../../lib/storage';

const API_SETTINGS_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_HISTORY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_ITEMS = 50;

const FIRST_LOAD_BUDGET = 20;
const LOAD_MORE_BUDGET = 5;
// T058: `refreshHead` tops up the head (page 1..) of every source, ignoring
// the 5-min `loadHistory` TTL, but only for a source whose cache is itself
// older than this — a source refreshed (by `loadHistory` or a previous
// `refreshHead`) less than 60s ago is skipped entirely (0 requests). The
// overall budget is generous; what actually bounds each call is the
// per-source cap below (<=2 requests/source/cycle, BuildsHistory.tsx's own
// 60s cadence keeps going deeper on the next tick if still not caught up).
const HEAD_REFRESH_TTL_MS = 60 * 1000;
const HEAD_REFRESH_BUDGET = 100;
const HEAD_REFRESH_PER_SOURCE_CAP = 2;

export type Period = RunHistoryPeriod;

export interface ServerFilter {
  branch?: string;
  event?: string;
  actor?: string;
}

export interface LoadHistoryOptions {
  period: Period;
  serverFilter?: ServerFilter;
  now: Date;
}

export interface LoadHistoryResult {
  runs: Run[];
  /** ISO timestamp: history is complete from `now` back to this point. */
  coveredUntil: string;
  /** `true` when `coveredUntil` is more recent than the requested period's start. */
  hasMore: boolean;
  /** Actual network requests made by this call (0 when every source was reused from cache). */
  requests: number;
  /** Base source key (`org:<org>` | `repo:<owner>/<name>`) -> the error kind that skipped it. */
  sourceErrors?: Record<string, ApiErrorKind>;
  /** T055: per-source numbers of this call for the «Диагностика» panel. */
  diagnostics?: HistoryDiagnostics;
}

/** T055: what one source did in one `loadHistory`/`loadMore` call. */
export interface SourceDiagnostics {
  /** Cache key (`org:<org>` | `repo:<owner>/<name>`, plus server filters). */
  key: string;
  /** Requests made to this source in this call. */
  requests: number;
  /** Pages walked so far from the head (the cursor: next page to fetch - 1). */
  pages: number;
  /** Runs held for this source (cache + this call). */
  cachedRuns: number;
  /** Server-side `total_count` from the last page fetched in this call. */
  totalCount?: number;
  oldestStartedAt?: string;
  exhausted: boolean;
  /** Whether the cache was within its 5 min TTL at the start of the call. */
  fresh: boolean;
  error?: ApiErrorKind | 'cacheWrite';
}

export interface HistoryDiagnostics {
  period: Period;
  periodStart: string;
  /** Page size used (`max_response_items`). */
  limit: number;
  sources: SourceDiagnostics[];
}

// ---------------------------------------------------------------------------
// History sources: org + repo sources from scope.ts, collapsed to one entry
// per org/repo (R5 ignores the active/recent/mine split `runSources` makes
// for the live poller).
// ---------------------------------------------------------------------------

type HistorySource = { kind: 'org'; org: string } | { kind: 'repo'; owner: string; repo: string };

/** Caches written by older builds may lack string fields; make every text field a string. */
function normalizeCachedRun(run: Run): Run {
  return {
    ...run,
    branch: run.branch ?? '',
    event: run.event ?? '',
    workflow: run.workflow ?? '',
    actor: run.actor ?? '',
    title: run.title ?? '',
  };
}

function baseSourceKey(source: HistorySource): string {
  return source.kind === 'org' ? `org:${source.org}` : `repo:${source.owner}/${source.repo}`;
}

function sourceKeyWithFilter(source: HistorySource, filter: ServerFilter | undefined): string {
  const base = baseSourceKey(source);
  if (!filter) return base;
  const parts: string[] = [];
  if (filter.branch) parts.push(`branch=${filter.branch}`);
  if (filter.event) parts.push(`event=${filter.event}`);
  if (filter.actor) parts.push(`actor=${filter.actor}`);
  return parts.length === 0 ? base : `${base}:${parts.join(':')}`;
}

function dedupeHistorySources(sources: RunSource[]): HistorySource[] {
  const seen = new Set<string>();
  const result: HistorySource[] = [];
  for (const s of sources) {
    const historySource: HistorySource =
      s.kind === 'repo' ? { kind: 'repo', owner: s.owner, repo: s.repo } : { kind: 'org', org: s.org };
    const key = baseSourceKey(historySource);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(historySource);
  }
  return result;
}

// ---------------------------------------------------------------------------
// apiSettings (24h cache)
// ---------------------------------------------------------------------------

async function ensureMaxResponseItems(
  endpoints: Endpoints,
  instanceId: string,
  now: Date
): Promise<{ limit: number; requestsMade: number }> {
  const cache = await storage.getApiSettingsCache(instanceId);
  const fresh = !!cache && now.getTime() - new Date(cache.fetchedAt).getTime() < API_SETTINGS_TTL_MS;
  if (fresh) {
    return { limit: cache!.maxResponseItems, requestsMade: 0 };
  }
  try {
    const settings = await endpoints.apiSettings();
    const limit = settings.max_response_items > 0 ? settings.max_response_items : DEFAULT_MAX_RESPONSE_ITEMS;
    await storage.setApiSettingsCache(instanceId, { fetchedAt: now.toISOString(), maxResponseItems: limit });
    return { limit, requestsMade: 1 };
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'auth') {
      throw err;
    }
    // H2 (T028 review fix): a failing `/settings/api` (5xx/403/etc.) must
    // not sink the whole load — fall back to the documented default. The
    // failure is intentionally not cached, so the next call retries.
    return { limit: DEFAULT_MAX_RESPONSE_ITEMS, requestsMade: 1 };
  }
}

// ---------------------------------------------------------------------------
// Per-source paging state
// ---------------------------------------------------------------------------

interface SourceState {
  source: HistorySource;
  cacheKey: string;
  runs: Run[];
  nextPage: number;
  exhausted: boolean;
  oldestStartedAt?: string;
  fresh: boolean;
  errored: boolean;
  fetchedThisCall: boolean;
  /** T055 diagnostics: requests to this source in this call / last `total_count` seen. */
  requestsThisCall: number;
  totalCount?: number;
  cacheWriteFailed?: boolean;
  /** The widest period ever requested for this source while its cache was fresh (T028 M5). */
  lastRequestedPeriodStartMs?: number;
  /**
   * T028 H1: true when, at the start of this call, the cache was already
   * stale (TTL expired) *and* already fully covered the requested period.
   * Such a source gets a bounded top-up refresh from page 1 (instead of
   * continuing from its old `nextPage` cursor, which only pages *deeper*
   * into history) so runs created since the last fetch become visible.
   */
  refreshMode: boolean;
  refreshPage: number;
  refreshCollected: Run[];
  refreshDone: boolean;
  /** ids already present in the cache before this call (refreshMode only) — used to detect "caught up with the old data". */
  originalIds: Set<number>;
}

async function loadSourceState(
  instanceId: string,
  source: HistorySource,
  filter: ServerFilter | undefined,
  now: Date,
  periodStartMs: number,
  headRefresh = false
): Promise<SourceState> {
  const cacheKey = sourceKeyWithFilter(source, filter);
  const cache = await storage.getRunHistoryCache(instanceId, cacheKey);
  const fresh = !!cache && now.getTime() - new Date(cache.fetchedAt).getTime() < RUN_HISTORY_TTL_MS;
  const runs = (cache?.runs ?? []).map(normalizeCachedRun);
  const oldestStartedAt = cache?.oldestStartedAt;
  const covered = isCovered(oldestStartedAt, periodStartMs);
  const exhausted = cache?.exhausted ?? false;
  // T058: `refreshHead` ignores the usual "covered"/"exhausted" gate and the
  // 5-min TTL entirely — it only cares whether *this* source's cache was
  // itself refreshed in the last 60s (by `loadHistory` or a previous
  // `refreshHead`), which is what actually stops it from re-fetching the
  // same head over and over on every 60s tick.
  const freshHead = !!cache && now.getTime() - new Date(cache.fetchedAt).getTime() < HEAD_REFRESH_TTL_MS;
  // T055: a stale cache that is covered *or exhausted* gets the top-up from
  // page 1 — an exhausted source used to be skipped forever (isEligible's
  // first check), so a small org/repo never showed a new run again.
  const refreshMode = headRefresh ? !freshHead : !fresh && (covered || exhausted);
  return {
    source,
    cacheKey,
    runs,
    nextPage: cache?.nextPage ?? 1,
    exhausted,
    oldestStartedAt,
    fresh,
    errored: false,
    fetchedThisCall: false,
    requestsThisCall: 0,
    lastRequestedPeriodStartMs: cache?.requestedPeriodStartMs,
    refreshMode,
    refreshPage: 1,
    refreshCollected: [],
    refreshDone: false,
    originalIds: refreshMode ? new Set(runs.map((r) => r.id)) : new Set<number>(),
  };
}

function oldestStartedAtOf(runs: Run[]): string | undefined {
  let oldest: string | undefined;
  for (const run of runs) {
    if (!run.startedAt) continue;
    if (!oldest || new Date(run.startedAt).getTime() < new Date(oldest).getTime()) {
      oldest = run.startedAt;
    }
  }
  return oldest;
}

function isCovered(oldestStartedAt: string | undefined, periodStartMs: number): boolean {
  if (!oldestStartedAt) return false;
  return new Date(oldestStartedAt).getTime() <= periodStartMs;
}

/**
 * Whether this call should attempt another page for `state`.
 *
 * - `loadMore` (forceContinue=true) pages any source that doesn't already
 *   cover the requested period, ignoring freshness — the user explicitly
 *   asked to keep going, but a source already covering the period has
 *   nothing left to contribute (T028 M6: don't burn budget on it).
 * - `loadHistory`, source still fresh (within the 5 min TTL): skip only
 *   when this exact source has already been asked about a period at least
 *   this wide while fresh (repeat of the same/narrower period -> 0
 *   requests); a genuinely wider period gets a real attempt even within
 *   the TTL (T028 M5).
 * - `loadHistory`, source stale (TTL expired) and not yet covering the
 *   period: keep paging deeper from the cursor, same as before.
 * - `loadHistory`, source stale *and* already covering the period: do a
 *   bounded top-up refresh from page 1 instead of freezing forever (T028
 *   H1), until `refreshDone`.
 */
function isEligible(
  state: SourceState,
  periodStartMs: number,
  forceContinue: boolean,
  headRefresh = false
): boolean {
  if (state.errored) return false;
  // T058: a head refresh only ever touches a source flagged `refreshMode`
  // (i.e. not fresh within the last 60s, see `loadSourceState`) and never
  // more than `HEAD_REFRESH_PER_SOURCE_CAP` times per call — "covered"/
  // "exhausted" don't apply here, the whole point is checking the *head*
  // again regardless of how deep this source has already paged.
  if (headRefresh) {
    if (!state.refreshMode || state.refreshDone) return false;
    return state.requestsThisCall < HEAD_REFRESH_PER_SOURCE_CAP;
  }
  // Only a source that started this call stale-and-(covered|exhausted) gets
  // the bounded top-up refresh (T028 H1, T055); a source that merely
  // *became* covered during this same call has nothing more to do.
  if (state.refreshMode && !state.refreshDone) return true;
  if (state.exhausted) return false;

  if (forceContinue) {
    return !isCovered(state.oldestStartedAt, periodStartMs);
  }

  if (state.fresh) {
    if (
      state.lastRequestedPeriodStartMs !== undefined &&
      periodStartMs >= state.lastRequestedPeriodStartMs
    ) {
      return false;
    }
  }
  return !isCovered(state.oldestStartedAt, periodStartMs);
}

async function fetchPage(
  endpoints: Endpoints,
  source: HistorySource,
  page: number,
  limit: number,
  filter: ServerFilter | undefined
): Promise<{ runs: import('../../api/types').ApiActionWorkflowRun[]; totalCount?: number }> {
  if (source.kind === 'org') {
    const res = await endpoints.orgRuns(source.org, {
      page,
      limit,
      branch: filter?.branch,
      event: filter?.event,
      actor: filter?.actor,
    });
    return { runs: res.workflow_runs ?? [], totalCount: res.total_count };
  }
  const res = await endpoints.repoRuns(source.owner, source.repo, limit, {
    page,
    branch: filter?.branch,
    event: filter?.event,
    actor: filter?.actor,
  });
  return { runs: res.workflow_runs ?? [], totalCount: res.total_count };
}

/**
 * T055: a page ends the source when it is empty, or when it is short
 * (fewer than `limit`) — unless the server's `total_count` says more runs
 * exist past it (a server capping `limit` below ours would otherwise end
 * paging after page 1). A full page never ends the source.
 */
function isLastPage(page: number, limit: number, got: number, totalCount: number | undefined): boolean {
  if (got === 0) return true;
  if (got >= limit) return false;
  if (typeof totalCount === 'number' && totalCount > (page - 1) * limit + got) return false;
  return true;
}

/** A run's own point in time: start, else finish (cancelled before it started). */
function runTimeMs(run: Run): number | undefined {
  const at = run.startedAt ?? run.completedAt;
  return at ? new Date(at).getTime() : undefined;
}

const ACTIVE_STATES: ReadonlySet<string> = new Set(['waiting', 'blocked', 'running']);

// ---------------------------------------------------------------------------
// Core loop, shared by loadHistory/loadMore
// ---------------------------------------------------------------------------

const EMPTY_RESULT = (now: Date): LoadHistoryResult => ({
  runs: [],
  coveredUntil: now.toISOString(),
  hasMore: false,
  requests: 0,
});

async function run(
  opts: LoadHistoryOptions,
  totalBudget: number,
  forceContinue: boolean,
  headRefresh = false
): Promise<LoadHistoryResult> {
  const { instances, activeInstanceId } = await storage.getInstances();
  if (!activeInstanceId) return EMPTY_RESULT(opts.now);
  const instance = instances.find((i) => i.id === activeInstanceId);
  if (!instance) return EMPTY_RESULT(opts.now);
  const token = await storage.getToken(activeInstanceId);
  if (!token) return EMPTY_RESULT(opts.now);

  const client = createClient({ baseUrl: instance.baseUrl, token });
  const endpoints = createEndpoints(client);

  const settings = await storage.getSettings();
  const pins = await storage.getPins(instance.id);
  const ownReposCache = await storage.getOwnReposCache(instance.id);

  const sourcesResult = runSources({
    caps: instance.capabilities,
    settings,
    orgs: instance.capabilities.orgs,
    pins,
    ownRepos: ownReposCache?.repos ?? [],
    // No PR context here (plan.md exception, same as ReposSection.tsx) —
    // repo-mode's fallback candidates are pins/includeRepos/ownRepos only.
    recentMine: [],
    mode: 'base',
  });
  const historySources = dedupeHistorySources(sourcesResult.sources);

  const periodStartMs = new Date(periodStart(opts.period, opts.now.toISOString())).getTime();

  let requests = 0;
  const { limit, requestsMade } = await ensureMaxResponseItems(endpoints, instance.id, opts.now);
  requests += requestsMade;
  let pageBudget = totalBudget - requests;

  const states = await Promise.all(
    historySources.map((s) =>
      loadSourceState(instance.id, s, opts.serverFilter, opts.now, periodStartMs, headRefresh)
    )
  );

  // T028 M4: `myOpenPrs` used to always be empty, so a run triggered by
  // someone else (e.g. CI bots, other contributors pushing to my PR branch)
  // on my own open PR was never grouped as "mine". Build it from the last
  // snapshot's `mine` PRs, same source of truth the popup/page use.
  const snapshot = await storage.getSnapshot(instance.id);
  const myOpenPrs = new Map<string, Set<number>>();
  if (snapshot) {
    for (const pr of snapshot.prs) {
      if (pr.group !== 'mine') continue;
      const key = `${pr.repo.owner}/${pr.repo.name}`;
      const set = myOpenPrs.get(key) ?? new Set<number>();
      set.add(pr.number);
      myOpenPrs.set(key, set);
    }
  }

  const runCtx: RunContext = {
    me: instance.login ?? '',
    myOpenPrs,
    pinned: new Set(pins.map((p) => `${p.owner}/${p.name}`)),
    workflowNames: new Map(),
  };

  const sourceErrors: Record<string, ApiErrorKind> = {};

  let progressed = true;
  while (pageBudget > 0 && progressed) {
    progressed = false;
    for (const state of states) {
      if (pageBudget <= 0) break;
      if (!isEligible(state, periodStartMs, forceContinue, headRefresh)) continue;
      progressed = true;
      // Counted whether the request succeeds or fails — a failing request
      // still spent one unit of this call's network budget.
      requests += 1;
      pageBudget -= 1;
      state.requestsThisCall += 1;

      const inRefresh = state.refreshMode && !state.refreshDone;
      const page = inRefresh ? state.refreshPage : state.nextPage;

      try {
        const fetched = await fetchPage(endpoints, state.source, page, limit, opts.serverFilter);
        const raw = fetched.runs;
        state.totalCount = fetched.totalCount;
        const mapped = raw.map((api) => toRun(api, runCtx));
        const pageExhausted = isLastPage(page, limit, raw.length, fetched.totalCount);

        if (inRefresh) {
          // H1 (T028): top up from page 1 instead of the old `nextPage`
          // cursor (which only pages *deeper*, never revisits the head).
          // Stop as soon as we reach a run we already had cached (no gap
          // left uncovered), the source itself runs out of pages, or this
          // page alone already reaches back to the period start — then
          // merge the newly-seen pages with the *entire* old cache (dedup
          // handles the overlap) and keep the old `nextPage`/`exhausted`
          // (the previously-fetched tail is still valid for deeper paging),
          // unless this refresh pass itself turned out to be exhaustive.
          state.refreshCollected = state.refreshCollected.concat(mapped);
          state.refreshPage += 1;
          const overlap = mapped.some((r) => state.originalIds.has(r.id));
          const pageCovered = mapped.some(
            (r) => r.startedAt !== undefined && new Date(r.startedAt).getTime() <= periodStartMs
          );
          if (overlap || pageExhausted || pageCovered) {
            state.runs = mergeRunPages([state.runs, state.refreshCollected]);
            state.refreshDone = true;
            if (pageExhausted && !overlap) {
              state.exhausted = true;
              state.nextPage = state.refreshPage;
            } else if (state.exhausted && typeof fetched.totalCount === 'number') {
              // T055: new runs pushed the old tail onto a further page — the
              // source is exhausted only while the cache holds the total.
              state.exhausted = state.runs.length >= fetched.totalCount;
            }
          }
        } else {
          state.runs = mergeRunPages([state.runs, mapped]);
          state.nextPage += 1;
          state.exhausted = pageExhausted;
        }

        state.oldestStartedAt = oldestStartedAtOf(state.runs);
        // NB: `fresh` is intentionally left as the pre-call cache check —
        // it only gates the "reuse without fetching at all" decision at the
        // top of this call, not whether *this* call keeps paging a source
        // it just fetched from.
        state.fetchedThisCall = true;
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'auth') {
          throw err;
        }
        state.errored = true;
        sourceErrors[baseSourceKey(state.source)] = err instanceof ApiError ? err.kind : 'server';
      }
    }
  }

  await Promise.all(
    states
      .filter((s) => s.fetchedThisCall)
      .map(async (s) => {
        // T055: the cache keeps the newest RUN_HISTORY_MAX runs; when it has
        // to cut, its cursor must describe what is kept (not the dropped
        // tail), or the dropped runs are never fetched again.
        const trimmed = s.runs.length > storage.RUN_HISTORY_MAX;
        const kept = trimmed ? s.runs.slice(0, storage.RUN_HISTORY_MAX) : s.runs;
        try {
          await storage.setRunHistoryCache(instance.id, s.cacheKey, {
            fetchedAt: opts.now.toISOString(),
            runs: kept,
            nextPage: trimmed ? Math.floor(kept.length / limit) + 1 : s.nextPage,
            exhausted: trimmed ? false : s.exhausted,
            oldestStartedAt: trimmed ? oldestStartedAtOf(kept) : s.oldestStartedAt,
            requestedPeriodStartMs: Math.min(periodStartMs, s.lastRequestedPeriodStartMs ?? periodStartMs),
          });
        } catch (err) {
          // A full storage.local must not sink the load: the runs are still
          // returned, only the reuse on the next call is lost.
          void err;
          s.cacheWriteFailed = true;
        }
      })
  );

  // The overall result is only reliably complete back to the *most recent*
  // (largest) boundary among sources that aren't fully exhausted — a source
  // with no data yet (never fetched: budget ran out before its turn) is
  // the most restrictive case, bounded by `now` itself.
  let boundaryMs: number | undefined;
  for (const state of states) {
    if (state.exhausted) continue;
    const sourceBoundaryMs = state.oldestStartedAt
      ? new Date(state.oldestStartedAt).getTime()
      : opts.now.getTime();
    if (boundaryMs === undefined || sourceBoundaryMs > boundaryMs) {
      boundaryMs = sourceBoundaryMs;
    }
  }

  const coveredUntilMs = boundaryMs ?? periodStartMs;
  const hasMore = coveredUntilMs > periodStartMs;

  // T055: a run that never started has no `startedAt`; it belongs to the
  // period by its finish time (cancelled while queued), or — still waiting
  // for a runner — it is current by definition.
  const mergedRuns = mergeRunPages(states.map((s) => s.runs)).filter((r) => {
    const at = runTimeMs(r);
    return at === undefined ? ACTIVE_STATES.has(r.state) : at >= periodStartMs;
  });

  const diagnostics: HistoryDiagnostics = {
    period: opts.period,
    periodStart: new Date(periodStartMs).toISOString(),
    limit,
    sources: states.map((s) => {
      const error = sourceErrors[baseSourceKey(s.source)] ?? (s.cacheWriteFailed ? 'cacheWrite' : undefined);
      return {
        key: s.cacheKey,
        requests: s.requestsThisCall,
        pages: Math.max(0, s.nextPage - 1),
        cachedRuns: s.runs.length,
        ...(s.totalCount !== undefined ? { totalCount: s.totalCount } : {}),
        ...(s.oldestStartedAt ? { oldestStartedAt: s.oldestStartedAt } : {}),
        exhausted: s.exhausted,
        fresh: s.fresh,
        ...(error ? { error } : {}),
      };
    }),
  };

  return {
    runs: mergedRuns,
    coveredUntil: new Date(coveredUntilMs).toISOString(),
    hasMore,
    requests,
    ...(Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
    diagnostics,
  };
}

export async function loadHistory(opts: LoadHistoryOptions): Promise<LoadHistoryResult> {
  return run(opts, FIRST_LOAD_BUDGET, false);
}

export async function loadMore(opts: LoadHistoryOptions): Promise<LoadHistoryResult> {
  return run(opts, LOAD_MORE_BUDGET, true);
}

/**
 * T058: tops up the head (page 1..) of every history source for `opts`,
 * ignoring `loadHistory`'s 5-min freshness window, but making 0 requests for
 * a source whose cache was itself refreshed less than 60s ago (own TTL) —
 * at most `HEAD_REFRESH_PER_SOURCE_CAP` requests per source. Driven by
 * BuildsHistory.tsx every 60s while the tab is visible, once right after a
 * mount/filter-change `loadHistory` resolves (so a page reload picks up
 * anything newer than its own fresh-but-stale-relative-to-60s cache), and
 * immediately on regaining visibility.
 */
export async function refreshHead(opts: LoadHistoryOptions): Promise<LoadHistoryResult> {
  return run(opts, HEAD_REFRESH_BUDGET, false, true);
}
