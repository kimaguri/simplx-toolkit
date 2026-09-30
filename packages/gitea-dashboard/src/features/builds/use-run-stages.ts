// Dashboard-only (US6, research.md R9, tasks.md T035): periodic job/step
// ("stage") data for the currently visible *active* runs. Wraps
// `run-jobs.ts`'s `createRunJobsLoader` with the page's own refresh cadence
// — its own 20s interval while the tab is visible, independent of
// `src/entrypoints/dashboard/App.tsx`'s `popup-heartbeat` interval, per
// tasks.md T035 ("don't couple to App internals"). Cleared on unmount and
// while the tab is hidden. Not imported by any popup path (rule 18).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRunJobsLoader, currentStage, type RunJobsLoader, type StageInfo } from './run-jobs';
import { ACTIVE_RUN_STATES, type Run } from '../../domain/types';
import { t } from '../../lib/i18n';

const REFRESH_MS = 20000;
// T043: fast stage refresh while the page is visible and I have an active build.
const FAST_REFRESH_MS = 5000;
const FAST_MAX_IN_FLIGHT = 3;

function runKey(run: Run): string {
  return `${run.id}:${run.attempt}`;
}

export function isActiveRun(run: Run): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(run.state);
}

export interface UseRunStagesResult {
  /** Reads the currently known stage for `run` (`undefined` while loading/unknown). */
  get(run: Run): StageInfo | undefined;
  /**
   * Fetches (once) and caches `run`'s jobs — for a row explicitly expanded,
   * typically a completed run that the periodic refresh below never
   * touches. Never rejects: any failure (including auth) resolves to
   * `{ unavailable: true }`.
   */
  loadOne(run: Run): Promise<StageInfo>;
  /**
   * The row was collapsed: an active run that `loadOne` registered for the
   * fast loop no longer takes a fast slot.
   */
  release(run: Pick<Run, 'id' | 'attempt'>): void;
}

/**
 * Loads job/step detail for the visible active runs among `runs` on mount
 * and every 20s while the tab is visible. Errors from the periodic refresh
 * (including auth) are swallowed here — the page already surfaces the
 * auth-paused state elsewhere (US6: "auth error → ignore here").
 */
export function useRunStages(runs: Run[], me: string): UseRunStagesResult {
  const loaderRef = useRef<RunJobsLoader | undefined>(undefined);
  if (!loaderRef.current) {
    loaderRef.current = createRunJobsLoader();
  }
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const meRef = useRef(me);
  meRef.current = me;

  // Keys of active runs the user expanded (T043): they join the fast loop.
  const expandedRef = useRef<Set<string>>(new Set());

  const [stagesMap, setStagesMap] = useState<Map<string, StageInfo>>(new Map());

  // Only the set of currently-active run keys re-arms the mount-time fetch
  // below — an unrelated re-render (e.g. a parent's own ticking clock) must
  // not trigger an extra load.
  const activeKey = useMemo(
    () =>
      runs
        .filter(isActiveRun)
        .map(runKey)
        .sort()
        .join(','),
    [runs]
  );

  // T043: the fast loop only exists while I have an active build of my own.
  const hasMineActive = useMemo(
    () => runs.some((r) => isActiveRun(r) && (r.mine || (me !== '' && r.actor === me))),
    [runs, me]
  );

  useEffect(() => {
    if (!hasMineActive) return;
    let cancelled = false;
    let inFlight = false;

    async function fastRefresh(): Promise<void> {
      if (inFlight || document.visibilityState !== 'visible') return;
      const current = runsRef.current;
      const isMine = (r: Run): boolean => r.mine || (meRef.current !== '' && r.actor === meRef.current);
      // Mine first, then expanded; never more than FAST_MAX_IN_FLIGHT at once.
      const targets = current
        .filter((r) => isActiveRun(r) && (isMine(r) || expandedRef.current.has(runKey(r))))
        .sort((a, b) => Number(isMine(b)) - Number(isMine(a)))
        .slice(0, FAST_MAX_IN_FLIGHT);
      if (targets.length === 0) return;
      inFlight = true;
      try {
        const infos = await Promise.all(
          targets.map((r) => loaderRef.current!.loadOne(r).catch((): StageInfo => ({ unavailable: true })))
        );
        if (!cancelled) {
          setStagesMap((prev) => {
            const next = new Map(prev);
            targets.forEach((r, i) => next.set(runKey(r), infos[i]!));
            return next;
          });
        }
      } finally {
        inFlight = false;
      }
    }

    const id = setInterval(() => void fastRefresh(), FAST_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasMineActive]);

  useEffect(() => {
    let cancelled = false;
    // M2: a single in-flight `load()` at a time — a slow response must not
    // overlap with the next tick's (or a visibilitychange's) refresh.
    let inFlight = false;

    async function refresh(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await loaderRef.current!.load(runsRef.current, meRef.current);
        if (!cancelled) setStagesMap(new Map(result));
      } catch {
        // Auth (or any other) error from the periodic refresh: ignore here,
        // the page shows the auth-paused state elsewhere (US6 scenario 4's
        // "unavailable" is for a *single run's* fetch failure, handled
        // inside the loader itself — this catch is only for e.g. a rejected
        // auth check aborting the whole `load` call).
      } finally {
        inFlight = false;
      }
    }

    // M2: never refresh while the tab is hidden — including this
    // mount/activeKey-change refresh.
    function refreshIfVisible(): void {
      if (document.visibilityState === 'visible') void refresh();
    }

    let intervalId: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (intervalId !== undefined) return;
      intervalId = setInterval(refreshIfVisible, REFRESH_MS);
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
        // M2: refresh immediately on regaining visibility, not just at the
        // next 20s tick.
        refreshIfVisible();
      } else {
        stop();
      }
    }

    refreshIfVisible();
    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const loadOne = useCallback(async (run: Run): Promise<StageInfo> => {
    const key = runKey(run);
    if (isActiveRun(run)) expandedRef.current.add(key);
    let info: StageInfo;
    try {
      info = await loaderRef.current!.loadOne(run);
    } catch {
      info = { unavailable: true };
    }
    setStagesMap((prev) => new Map(prev).set(key, info));
    return info;
  }, []);

  const release = useCallback((run: Pick<Run, 'id' | 'attempt'>): void => {
    expandedRef.current.delete(runKey(run as Run));
  }, []);

  return useMemo<UseRunStagesResult>(
    () => ({
      get: (run) => stagesMap.get(runKey(run)),
      loadOne,
      release,
    }),
    [stagesMap, loadOne, release]
  );
}

/**
 * The run's current-stage display text (`jobName › stepName · index/total`),
 * the localized "unavailable" label, or `undefined` when the run isn't
 * active or its stage isn't known yet — callers render their own fallback
 * (e.g. "—") for `undefined`.
 */
export function stageTextFor(run: Run, stages: UseRunStagesResult): string | undefined {
  if (!isActiveRun(run)) return undefined;
  const info = stages.get(run);
  if (!info) return undefined;
  if (info.unavailable) return t('buildsStageUnavailable');
  const stage = currentStage(info.jobs);
  if (!stage) return undefined;
  return `${stage.jobName} › ${stage.stepName} · ${stage.index}/${stage.total}`;
}
