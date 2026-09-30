// "Сборки" history view (US4, FR-111/FR-112). Loads paged run history via
// `history-loader.ts` (loadHistory/loadMore), keeps `RunHistoryFilter` state
// in the page hash (src/domain/route.ts), and derives the filtered/sorted
// rows + aggregate stats via pure `src/domain/history.ts` functions.
// Source of truth: spec.md US4 scenarios 1-7, research.md R5/R6,
// data-model.md "RunHistoryFilter"/"RunStats", contracts/page-surface.md.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { relative } from '../../lib/time';
import { cn } from '../../lib/utils';
import {
  getInstances,
  getSnapshot,
  getUiState,
  getWorkflowsCache,
  onSnapshotChanged,
  setUiState,
} from '../../lib/storage';
import { ApiError } from '../../api/client';
import {
  buildPrIndex,
  classifyRun,
  filterRuns,
  mergeRunPages,
  periodStart,
  runBranchDisplay,
  runInPeriod,
  runsOfKind,
  runStats,
  sortRuns,
} from '../../domain/history';
import type { RunHistoryFilter, RunHistoryKind, RunHistorySortColumn } from '../../domain/route';
import { parseRoute, runHistoryFilterFromParams, runHistoryFilterToParams, serializeRoute } from '../../domain/route';
import type { Run } from '../../domain/types';
import { TablePagination, usePageSize } from '../TablePagination';
import { loadHistory, loadMore, refreshHead, type LoadHistoryResult, type Period, type ServerFilter } from './history-loader';
import { HistoryFilters } from './HistoryFilters';
import { HistoryStats } from './HistoryStats';
import { HistoryDiagnostics } from './HistoryDiagnostics';
import { StatusIcon } from '../../ui/StatusIcon';
import { ErrorState } from '../../ui/ErrorState';
import { formatDurationSec } from './HistoryStats';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Alert, AlertTitle } from '../../components/ui/alert';
import { Skeleton } from '../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { RepoTag, BranchTag, NumberTag } from '../../ui/Tags';
import { isActiveRun, stageTextFor, useRunStages } from './use-run-stages';
import { RunStageDetail } from './RunStageDetail';
import type { StatusIconState } from '../../ui/StatusIcon';

/** `${run.id}:${run.attempt}` — matches `run-jobs.ts`'s own cache key. */
function runRowKey(run: Run): string {
  return `${run.id}:${run.attempt}`;
}

/** Non-auth failures loading history / "show more" — rendered as a destructive Alert with a retry action. */
type HistoryErrorKind = 'auth' | 'other';

function historyErrorKindOf(err: unknown): HistoryErrorKind {
  return err instanceof ApiError && err.kind === 'auth' ? 'auth' : 'other';
}

/** True when two filters serialize to the same route params (order-insensitive to key construction). */
function sameFilter(a: RunHistoryFilter, b: RunHistoryFilter): boolean {
  return runHistoryFilterToParams(a).toString() === runHistoryFilterToParams(b).toString();
}

// T058: how often the head of history is topped up while the tab is
// visible (also fired once right after a mount/filter load, and immediately
// on regaining visibility) — matches `refreshHead`'s own per-source 60s
// freshness window in history-loader.ts, so a mount right after a fresh
// `loadHistory` makes 0 extra requests.
const HEAD_REFRESH_MS = 60_000;

const PERIODS: readonly Period[] = ['today', '24h', '7d', '30d'];
const PERIOD_LABEL_KEYS: Record<Period, string> = {
  today: 'historyPeriodToday',
  '24h': 'historyPeriod24h',
  '7d': 'historyPeriod7d',
  '30d': 'historyPeriod30d',
};

function readFilterFromHash(): RunHistoryFilter {
  const route = parseRoute(window.location.hash, 'builds');
  return runHistoryFilterFromParams(route.params);
}

function writeFilterToHash(filter: RunHistoryFilter): void {
  const params = runHistoryFilterToParams(filter);
  params.set('view', 'history');
  window.location.hash = serializeRoute({ section: 'builds', view: 'history', params });
}

/** A `ServerFilter` is only sent when exactly one branch/event is selected (contracts/page-surface.md). */
function serverFilterFrom(filter: RunHistoryFilter): { branch?: string; event?: string } | undefined {
  const branch = filter.branch.length === 1 ? filter.branch[0] : undefined;
  const event = filter.event.length === 1 ? filter.event[0] : undefined;
  if (branch === undefined && event === undefined) return undefined;
  return { branch, event };
}

/**
 * T058: `base` (the currently displayed runs) with `snapshotRuns` merged in —
 * only those belonging to `period` (`runInPeriod`: an active run always
 * qualifies) — via the same `mergeRunPages` dedup the loader itself uses (by
 * id, higher attempt wins; the snapshot copy, passed last, wins on a tie).
 */
function mergedWithSnapshot(base: Run[], snapshotRuns: Run[], period: Period, now: Date): Run[] {
  if (snapshotRuns.length === 0) return base;
  const periodStartMs = new Date(periodStart(period, now.toISOString())).getTime();
  const relevant = snapshotRuns.filter((r) => runInPeriod(r, periodStartMs));
  if (relevant.length === 0) return base;
  return mergeRunPages([base, relevant]);
}

function formatDdMm(iso: string): string {
  const date = new Date(iso);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

export function BuildsHistory(): JSX.Element {
  const [filter, setFilter] = useState<RunHistoryFilter>(() => readFilterFromHash());
  const [result, setResult] = useState<LoadHistoryResult | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<HistoryErrorKind | undefined>(undefined);
  const [loadMoreError, setLoadMoreError] = useState<HistoryErrorKind | undefined>(undefined);
  const [workflowNames, setWorkflowNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState('');
  // T056: PR check runs (`event: pull_request`) have no head_branch — the
  // branch column looks up the PR's target branch from the active
  // instance's last PR snapshot via this index (no extra request).
  const [prIndex, setPrIndex] = useState<Map<string, string | undefined>>(() => new Map());
  // Bumped on every new `loadHistory` call (period/server-filter change or
  // retry) so a `loadHistory`/`loadMore` response that resolves after a
  // newer request has started (L1: stale "показать ещё" racing a filter
  // change) is ignored instead of clobbering the newer result.
  const requestIdRef = useRef(0);
  // Bumped by the "retry" action to force the load effect below to re-run
  // even though `filter`/`serverFilter` haven't changed.
  const [reloadToken, setReloadToken] = useState(0);
  // T035 (US6): the one expanded row's key (`${id}:${attempt}`), or
  // `undefined` when none is expanded — only one row is ever expanded at a
  // time.
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
  // LOW: rows whose expanded detail must show "loading" rather than a stale
  // in-progress `stages.get(run)` snapshot left over from when the run was
  // still active, until the row's own `loadOne` answers.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  // T042 (owner decision): the stats panel (cards + "По workflow") is
  // collapsed by default and its open state persists across sessions.
  const [historyStatsOpen, setHistoryStatsOpen] = useState(false);
  // T058: the active instance id, once known, drives the `onSnapshotChanged`
  // subscription below (a poller/background snapshot update merges its runs
  // into the table immediately, no reload needed).
  const [subscribedInstanceId, setSubscribedInstanceId] = useState<string | undefined>(undefined);
  // T058: the latest known snapshot runs (from the one-time mount fetch and
  // every `onSnapshotChanged` update) — kept outside React state so a
  // `loadHistory`/`refreshHead` completion can always merge the freshest
  // copy in without an extra render race.
  const snapshotRunsRef = useRef<Run[]>([]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const headRefreshInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getUiState().then((ui) => {
      if (!cancelled) setHistoryStatsOpen(!!ui.historyStatsOpen);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleHistoryStats(open: boolean): void {
    setHistoryStatsOpen(open);
    void setUiState({ historyStatsOpen: open });
  }

  // Read-only lookup of the `workflows:<instanceId>` cache (T021/R5) to map
  // a run's workflow file to its human name, and of the active instance's
  // login (M4: `filterRuns`'s "только мои" needs the real login, not '') —
  // no new requests here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { instances, activeInstanceId } = await getInstances();
      if (!activeInstanceId || cancelled) return;
      const instance = instances.find((i) => i.id === activeInstanceId);
      if (!cancelled) setMe(instance?.login ?? '');
      if (!cancelled) setSubscribedInstanceId(activeInstanceId);
      const cache = await getWorkflowsCache(activeInstanceId);
      if (!cancelled && cache) {
        setWorkflowNames(cache.names);
      }
      const snapshot = await getSnapshot(activeInstanceId);
      if (cancelled) return;
      setPrIndex(buildPrIndex(snapshot?.prs ?? []));
      // T058: merge whatever the snapshot already knows about right away —
      // don't wait for the next `onSnapshotChanged` event to show a build
      // that started before this page was even opened.
      snapshotRunsRef.current = snapshot?.runs ?? [];
      if (snapshotRunsRef.current.length > 0) {
        setResult((prev) =>
          prev
            ? { ...prev, runs: mergedWithSnapshot(prev.runs, snapshotRunsRef.current, filterRef.current.period, new Date()) }
            : prev
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const serverFilter = serverFilterFrom(filter);
  const serverFilterKey = JSON.stringify(serverFilter ?? null);
  const serverFilterRef = useRef(serverFilter);
  serverFilterRef.current = serverFilter;

  // T058: a single in-flight head-refresh at a time — `refreshHead` tops up
  // the head (page 1..) of every source, ignoring `loadHistory`'s 5-min TTL
  // but making 0 requests for a source it (or the last `loadHistory`) itself
  // already touched in the last 60s (history-loader.ts). Any snapshot runs
  // known so far are re-merged on top, so a very-new run the server hasn't
  // indexed yet isn't dropped by this call's own (older) view.
  const doHeadRefresh = useCallback(async (): Promise<void> => {
    if (headRefreshInFlightRef.current || document.visibilityState !== 'visible') return;
    headRefreshInFlightRef.current = true;
    try {
      const headResult = await refreshHead({
        period: filterRef.current.period,
        serverFilter: serverFilterRef.current,
        now: new Date(),
      });
      setResult((prev) => {
        if (!prev) return prev;
        const merged = mergeRunPages([prev.runs, headResult.runs]);
        return { ...prev, runs: mergedWithSnapshot(merged, snapshotRunsRef.current, filterRef.current.period, new Date()) };
      });
    } catch {
      // T058: a failed periodic head refresh is silent — the next 60s tick
      // or the next visibilitychange retries; the page's own error UI is
      // reserved for the main `loadHistory`/`loadMore` calls.
    } finally {
      headRefreshInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    // A stale "показать ещё" in flight for the previous filter is no longer
    // relevant to the request this effect just started (L1) — re-enable the
    // button up front rather than leaving it stuck disabled forever.
    setLoadingMore(false);
    setLoadMoreError(undefined);
    setLoadError(undefined);
    void (async () => {
      try {
        const next = await loadHistory({ period: filter.period, serverFilter, now: new Date() });
        if (cancelled || requestId !== requestIdRef.current) return;
        setResult({ ...next, runs: mergedWithSnapshot(next.runs, snapshotRunsRef.current, filter.period, new Date()) });
        // T058: right after a fresh load, top up the head once more — a
        // source whose cache `loadHistory` just reused (still within its
        // own 5-min TTL) can be minutes stale; `refreshHead`'s own 60s TTL
        // makes this a no-op right after a `loadHistory` that actually
        // fetched, and a real (bounded) request otherwise.
        void doHeadRefresh();
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        setLoadError(historyErrorKindOf(err));
      } finally {
        if (!cancelled && requestId === requestIdRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.period, serverFilterKey, reloadToken]);

  // T058: merges live poller/background snapshot runs into the displayed
  // table immediately (no reload) — respecting the current period (an
  // active run always passes, see `runInPeriod`); filters/tab/sort are
  // already applied downstream by the existing `result.runs` pipeline.
  useEffect(() => {
    if (!subscribedInstanceId) return;
    return onSnapshotChanged(subscribedInstanceId, (snapshot) => {
      snapshotRunsRef.current = snapshot.runs;
      setResult((prev) =>
        prev ? { ...prev, runs: mergedWithSnapshot(prev.runs, snapshot.runs, filterRef.current.period, new Date()) } : prev
      );
    });
  }, [subscribedInstanceId]);

  // T058: while the tab is visible, top up the head of history every 60s,
  // and immediately on regaining visibility — 0 requests while hidden. Runs
  // for the component's whole lifetime (not re-created on filter changes:
  // `doHeadRefresh` itself always reads the *current* filter via refs).
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (intervalId !== undefined) return;
      intervalId = setInterval(() => void doHeadRefresh(), HEAD_REFRESH_MS);
    }
    function stop(): void {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    }
    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        start();
        void doHeadRefresh();
      } else {
        stop();
      }
    }
    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [doHeadRefresh]);

  // M2: restore the period/filters from the address on browser Back/Forward
  // (and any other external hash edit) — compare against the current filter
  // first so this doesn't loop with `writeFilterToHash` below.
  useEffect(() => {
    function onHashChange(): void {
      setFilter((prev) => {
        const next = readFilterFromHash();
        return sameFilter(prev, next) ? prev : next;
      });
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function handleFilterChange(next: RunHistoryFilter): void {
    setFilter(next);
    writeFilterToHash(next);
  }

  function handlePeriodChange(period: Period): void {
    handleFilterChange({ ...filter, period });
  }

  function handleSort(column: RunHistorySortColumn): void {
    const direction =
      filter.sort.column === column && filter.sort.direction === 'desc' ? 'asc' : 'desc';
    handleFilterChange({ ...filter, sort: { column, direction } });
  }

  function handleRetry(): void {
    setReloadToken((n) => n + 1);
  }

  async function handleShowMore(): Promise<void> {
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const next = await loadMore({ period: filter.period, serverFilter, now: new Date() });
      if (requestId !== requestIdRef.current) return; // L1: a newer load superseded this one
      setResult(next);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setLoadMoreError(historyErrorKindOf(err));
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  }

  function workflowLabelForRun(run: Run): string {
    const key = `${run.repo.owner}/${run.repo.name}::${run.workflow}`;
    return workflowNames[key] ?? run.workflow;
  }

  const loadedRuns = useMemo(() => result?.runs ?? [], [result]);
  // Client-side tab view (FR-125): facets, rows, stats and pagination all work
  // over the tab's runs; the loader/server filters are untouched.
  const allRuns = useMemo(() => runsOfKind(loadedRuns, filter.kind), [loadedRuns, filter.kind]);
  // Tab counters: loaded runs narrowed by every filter except the tab itself.
  const preFilteredRuns = useMemo(
    () => filterRuns(loadedRuns, filter, me, prIndex),
    [loadedRuns, filter, me, prIndex]
  );
  const kindCounts = useMemo(
    () => ({ builds: runsOfKind(preFilteredRuns, 'builds').length, all: preFilteredRuns.length }),
    [preFilteredRuns]
  );
  const filteredRuns = useMemo(
    () => runsOfKind(preFilteredRuns, filter.kind),
    [preFilteredRuns, filter.kind]
  );
  const sortedRuns = useMemo(
    () => sortRuns(filteredRuns, filter.sort.column, filter.sort.direction),
    [filteredRuns, filter.sort]
  );
  const stats = useMemo(() => runStats(filteredRuns), [filteredRuns]);
  // T034 (US5): repo full names among the currently-shown rows, so RepoTag
  // only drops the owner when there's no collision among what's on screen.
  const allFullNames = useMemo(
    () => sortedRuns.map((run) => `${run.repo.owner}/${run.repo.name}`),
    [sortedRuns]
  );

  // T045 (FR-120): client-side pagination over the loaded runs; reaching the
  // last loaded page while the loader has more fetches the next API page
  // (history-loader keeps its own <=20 requests cap).
  const [pageSize, setPageSize] = usePageSize();
  const [pageIndex, setPageIndex] = useState(0);
  const lastPageIndex = Math.max(0, Math.ceil(sortedRuns.length / pageSize) - 1);
  const currentPage = Math.min(pageIndex, lastPageIndex);
  const pageRuns = useMemo(
    () => sortedRuns.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    [sortedRuns, currentPage, pageSize]
  );
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setPageIndex(0);
  }, [filterKey]);

  function handlePageChange(next: number): void {
    setPageIndex(next);
    const reachesEnd = next >= lastPageIndex;
    if (reachesEnd && result?.hasMore && !loadingMore) void handleShowMore();
  }

  // T035 (US6): job/step ("stage") data for the visible active runs,
  // refreshed on its own 20s cadence (use-run-stages.ts) — independent of
  // this component's own filter/period reloads above.
  const stages = useRunStages(sortedRuns, me);

  function openRun(run: Run): void {
    void browser.tabs.create({ url: run.htmlUrl });
  }

  function toggleExpand(run: Run): void {
    const key = runRowKey(run);
    const wasExpanded = expandedKey === key;
    setExpandedKey(wasExpanded ? undefined : key);
    // L6: the collapsed row (this one, or the previously expanded one that a
    // new expansion replaces) leaves the fast stage loop.
    const previous = wasExpanded
      ? run
      : expandedKey !== undefined
        ? sortedRuns.find((r) => runRowKey(r) === expandedKey)
        : undefined;
    if (previous) stages.release(previous);
    if (wasExpanded) return;

    // M3: a row with no cached jobs at all — active or not — needs an
    // explicit fetch (the periodic refresh only covers the first 10
    // active runs).
    const existing = stages.get(run);
    const isFinished = !!existing && !existing.unavailable && !!existing.finalState;
    if (existing && (isActiveRun(run) || isFinished)) return;

    if (existing) {
      // LOW: `existing` here is a stale in-progress snapshot from `load()`
      // (the run has since completed but hasn't been re-fetched) — hide it
      // while the authoritative `loadOne` fetch is in flight.
      setPendingKeys((prev) => new Set(prev).add(key));
    }
    void stages.loadOne(run).finally(() => {
      setPendingKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });
  }

  const now = new Date();
  // `hasMore` is exactly "coveredUntil is more recent than the requested
  // period's start" (LoadHistoryResult's own contract, history-loader.ts) —
  // reused directly rather than recomputing the period boundary here.
  const notFullyCovered = !!result?.hasMore;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-4">
      <Tabs
        value={filter.kind}
        onValueChange={(value) => handleFilterChange({ ...filter, kind: value as RunHistoryKind })}
      >
        <TabsList aria-label={t('historyTabsLabel')}>
          <TabsTrigger value="builds">
            {t('historyTabBuilds')}
            <span data-testid="history-count-builds" className="text-xs tabular-nums text-muted-foreground">
              {kindCounts.builds}
            </span>
          </TabsTrigger>
          <TabsTrigger value="all">
            {t('historyTabAll')}
            <span data-testid="history-count-all" className="text-xs tabular-nums text-muted-foreground">
              {kindCounts.all}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <ToggleGroup
        type="single"
        variant="outline"
        value={filter.period}
        onValueChange={(value) => value && handlePeriodChange(value as Period)}
        aria-label={t('historyPeriodLabel')}
      >
        {PERIODS.map((period) => (
          <ToggleGroupItem key={period} value={period}>
            {t(PERIOD_LABEL_KEYS[period])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      </div>

      <HistoryFilters
        runs={allRuns}
        filter={filter}
        onChange={handleFilterChange}
        prIndex={prIndex}
        workflowLabel={(file) => {
          const match = allRuns.find((r) => r.workflow === file);
          return match ? workflowLabelForRun(match) : file;
        }}
      />

      {result?.sourceErrors && Object.keys(result.sourceErrors).length > 0 && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>
            {t('historySourceErrors', [Object.keys(result.sourceErrors).join(', ')])}
          </AlertTitle>
        </Alert>
      )}

      {loadError === 'auth' ? (
        <ErrorState messageKey="authError" />
      ) : loadError === 'other' ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('historyLoadError')}</AlertTitle>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            {t('historyRetry')}
          </Button>
        </Alert>
      ) : loading && loadedRuns.length === 0 ? (
        <div data-testid="history-skeleton" className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
          <Table data-testid="history-runs-table">
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>{t('historyColWorkflow')}</TableHead>
                <TableHead>{t('historyColRepo')}</TableHead>
                <TableHead>{t('historyColBranch')}</TableHead>
                <TableHead>{t('historyColEvent')}</TableHead>
                <TableHead>{t('historyColActor')}</TableHead>
                <TableHead>{t('historyColStage')}</TableHead>
                <TableHead>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1 px-1"
                    onClick={() => handleSort('started')}
                  >
                    {t('historyColStarted')}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1 px-1"
                    onClick={() => handleSort('duration')}
                  >
                    {t('historyColDuration')}
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRuns.map((run) => {
                const rowKey = runRowKey(run);
                const isExpanded = expandedKey === rowKey;
                const stageText = stageTextFor(run, stages) ?? '—';
                // M1: once `loadOne`/the periodic refresh sees every job
                // completed, show the derived outcome instead of the
                // (possibly stale) `run.state` from the runs list.
                const info = stages.get(run);
                const finalState: StatusIconState | undefined =
                  info && !info.unavailable ? info.finalState : undefined;
                const detailStage = pendingKeys.has(rowKey) ? undefined : info;
                return (
                  <Fragment key={rowKey}>
                    <TableRow
                      tabIndex={0}
                      className="cursor-pointer"
                      onClick={() => openRun(run)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') openRun(run);
                      }}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-expanded={isExpanded}
                            aria-label={t('buildsStageToggle')}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpand(run);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <ChevronRight
                              size={14}
                              className={cn('transition-transform', isExpanded && 'rotate-90')}
                            />
                          </Button>
                          <StatusIcon state={finalState ?? run.state} />
                        </div>
                      </TableCell>
                      <TableCell>{workflowLabelForRun(run)}</TableCell>
                      <TableCell>
                        <RepoTag
                          fullName={`${run.repo.owner}/${run.repo.name}`}
                          allFullNames={allFullNames}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const display = runBranchDisplay(run, prIndex);
                            if (display.kind === 'branch') {
                              return display.branch ? <BranchTag branch={display.branch} /> : '—';
                            }
                            if (display.baseRef) {
                              return (
                                <>
                                  <NumberTag number={display.prNumber} />
                                  <span className="text-muted-foreground">&rarr;</span>
                                  <BranchTag branch={display.baseRef} />
                                </>
                              );
                            }
                            return (
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="h-auto p-0 font-mono"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void browser.tabs.create({ url: display.prUrl });
                                }}
                              >
                                #{display.prNumber}
                              </Button>
                            );
                          })()}
                          {classifyRun(run) === 'release' && (
                            <Badge variant="secondary">{t('historyKindRelease')}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{run.event}</TableCell>
                      <TableCell>{run.actor}</TableCell>
                      <TableCell
                        className="max-w-[220px] truncate text-xs text-muted-foreground"
                        title={stageText !== '—' ? stageText : undefined}
                      >
                        {stageText}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {run.startedAt
                          ? relative(run.startedAt, now)
                          : run.state === 'waiting' || run.state === 'blocked'
                            ? t('historyStartedQueued')
                            : '—'}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {(() => {
                          if (!run.startedAt || !run.completedAt) return '—';
                          const sec = (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
                          return sec > 0 ? formatDurationSec(sec) : '—';
                        })()}
                      </TableCell>
                    </TableRow>
                    <TableRow key={`${rowKey}-detail`}>
                      <TableCell colSpan={9} className="p-0">
                        <Collapsible open={isExpanded}>
                          <CollapsibleContent>
                            <RunStageDetail stage={detailStage} />
                          </CollapsibleContent>
                        </Collapsible>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          </div>

          <TablePagination
            pageIndex={currentPage}
            pageSize={pageSize}
            total={sortedRuns.length}
            canLoadMore={!!result?.hasMore}
            loading={loadingMore}
            onPageChange={handlePageChange}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPageIndex(0);
            }}
          />

          {notFullyCovered && result && (
            <p className="shrink-0 text-sm text-muted-foreground">
              {t('historyCoverageNote', [formatDdMm(result.coveredUntil)])}
            </p>
          )}

          <Collapsible open={historyStatsOpen} onOpenChange={toggleHistoryStats} className="shrink-0">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-2 px-2">
                <ChevronDown
                  size={14}
                  className={cn('transition-transform', !historyStatsOpen && '-rotate-90')}
                />
                {t('historyStatsToggle')}
                <span className="text-xs font-normal text-muted-foreground">
                  {t('historyStatsSummary', [String(stats.total), String(Math.round(stats.failureRate * 100))])}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="max-h-56 overflow-auto">
              <HistoryStats
                stats={stats}
                workflowLabel={(file) => {
                  const match = allRuns.find((r) => r.workflow === file);
                  return match ? workflowLabelForRun(match) : file;
                }}
              />
            </CollapsibleContent>
          </Collapsible>

          {result && <HistoryDiagnostics result={result} />}

          {result?.hasMore && (
            <div className="shrink-0 space-y-2">
              <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void handleShowMore()}>
                {t('historyShowMore')}
              </Button>
              {loadMoreError === 'auth' && <ErrorState messageKey="authError" />}
              {loadMoreError === 'other' && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>{t('historyLoadError')}</AlertTitle>
                </Alert>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
