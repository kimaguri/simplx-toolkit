// "Сборки" groups section (US4, FR-030..033, FR-072). Renders two groups from
// the snapshot's `runs` — "Мои и закреплённые" (always expanded) and
// "Остальные" (collapsed by default, toggle persisted in ui.othersCollapsed)
// — plus a ticking duration for running items and a popup-heartbeat while
// mounted so the background can poll builds faster (FR-041).
//
// Rendered by src/entrypoints/popup/tabs/Builds.tsx (density="compact") and,
// per docs/specs/002-fullpage-dashboard/research.md R8, by the dashboard page
// (density="comfortable") — same behavior, roomier spacing on the page.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ChevronDown } from 'lucide-react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { duration } from '../../lib/time';
import { getUiState, setUiState } from '../../lib/storage';
import { runCounts } from '../../domain/runs';
import { ACTIVE_RUN_STATES, type Capabilities, type Run, type Snapshot } from '../../domain/types';
import type { PopupHeartbeatMessage } from '../../background/messages';
import { List } from '../../ui/List';
import { Empty } from '../../ui/Empty';
import { ErrorState } from '../../ui/ErrorState';
import { StatusIcon } from '../../ui/StatusIcon';
import { Badge } from '../../components/ui/badge';
import { Separator } from '../../components/ui/separator';
import { cn } from '../../lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible';

const HEARTBEAT_MS = 5000;
const TICK_MS = 1000;

export type Density = 'compact' | 'comfortable';

export interface BuildsGroupsProps {
  snapshot?: Snapshot;
  capabilities?: Capabilities;
  density: Density;
  /**
   * Whether to send `popup-heartbeat` while mounted (FR-041). Defaults to
   * `true` (popup behavior, unchanged). The dashboard page passes `false`
   * because its own visibility-gated heartbeat already covers this —
   * without it, a hidden dashboard tab would keep the background's fast
   * poll alive via this component's always-on heartbeat (M1).
   */
  heartbeat?: boolean;
  /**
   * Renders the comfortable-density secondary line (repo/branch tags + event
   * · actor) for a run. Only ever called when `density === 'comfortable'`.
   * T039: kept out of this file (rather than importing `src/ui/Tags`
   * directly) so the popup — which only ever renders `density="compact"` —
   * never pulls the Tags module (and its CSS classes) into its bundle. The
   * dashboard page passes `renderComfortableSecondary` from
   * `./comfortable-row`; the popup passes nothing, so comfortable density
   * without a renderer falls back to the same plain text line compact uses.
   */
  renderSecondary?: (run: Run, allFullNames: string[]) => JSX.Element;
}

function isActive(run: Run): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(run.state);
}

/**
 * Active first, then by startedAt descending. T057: an active run with no
 * `startedAt` yet (waiting/blocked, or running without a timestamp) is
 * current — it sorts at the TOP of the active group immediately, not to the
 * bottom (which used to hide it until it actually started); ties then break
 * by `id` desc (higher id = newer).
 */
function sortRuns(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => {
    const aActive = isActive(a);
    const bActive = isActive(b);
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    const aStarted = a.startedAt ? new Date(a.startedAt).getTime() : aActive ? Number.POSITIVE_INFINITY : 0;
    const bStarted = b.startedAt ? new Date(b.startedAt).getTime() : bActive ? Number.POSITIVE_INFINITY : 0;
    return aStarted === bStarted ? b.id - a.id : bStarted - aStarted;
  });
}

/** Sends `popup-heartbeat` every 5s while mounted (FR-041, research R10). */
function useHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function send(): void {
      browser.runtime
        .sendMessage({ type: 'popup-heartbeat' } satisfies PopupHeartbeatMessage)
        .catch(() => {});
    }
    send();
    const id = setInterval(send, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [enabled]);
}

export function BuildsGroups({
  snapshot,
  capabilities,
  density,
  heartbeat = true,
  renderSecondary,
}: BuildsGroupsProps): JSX.Element {
  const comfortable = density === 'comfortable';
  useHeartbeat(heartbeat);

  const [othersCollapsed, setOthersCollapsed] = useState(true);
  const [now, setNow] = useState(() => new Date());
  // One flat selection index shared across "Мои" + (when expanded)
  // "Остальные" (T082): ↑/↓ cross the group boundary, exactly one row is
  // ever selected/highlighted per section.
  const [selectedFlat, setSelectedFlat] = useState(0);
  const mineRef = useRef<HTMLDivElement | null>(null);
  const othersRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getUiState().then((ui) => {
      if (!cancelled) setOthersCollapsed(ui.othersCollapsed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runs = snapshot?.runs ?? [];
  const mine = useMemo(() => sortRuns(runs.filter((run) => run.group === 'mine')), [runs]);
  const others = useMemo(() => sortRuns(runs.filter((run) => run.group === 'others')), [runs]);
  const { activeOthers, failedOthers } = useMemo(() => runCounts(runs), [runs]);
  // T034 (US5): repo full names among all currently-listed runs, so
  // RepoTag (comfortable density only) drops the owner unless it collides.
  const allFullNames = useMemo(() => runs.map((run) => `${run.repo.owner}/${run.repo.name}`), [runs]);

  // Flat cross-group selection: collapsed "Остальные" rows are not part of
  // the flat list (they aren't visible/keyboard-reachable at all).
  const flatLength = mine.length + (othersCollapsed ? 0 : others.length);
  const clampedFlat = flatLength > 0 ? Math.min(Math.max(selectedFlat, 0), flatLength - 1) : 0;
  const mineSelectedIndex = clampedFlat < mine.length ? clampedFlat : -1;
  const othersSelectedIndex =
    !othersCollapsed && clampedFlat >= mine.length ? clampedFlat - mine.length : -1;

  function handleBoundary(direction: 1 | -1): void {
    if (flatLength === 0) return;
    const next = Math.min(Math.max(clampedFlat + direction, 0), flatLength - 1);
    if (next === clampedFlat) return;
    setSelectedFlat(next);
    if (next < mine.length) {
      mineRef.current?.focus();
    } else {
      othersRef.current?.focus();
    }
  }

  const visibleRunning =
    mine.some((run) => run.state === 'running') ||
    (!othersCollapsed && others.some((run) => run.state === 'running'));

  // Single ticking interval, only while a running item is actually visible;
  // cleared whenever that stops being true or the component unmounts.
  useEffect(() => {
    if (!visibleRunning) return;
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, [visibleRunning]);

  function toggleOthers(): void {
    const next = !othersCollapsed;
    setOthersCollapsed(next);
    void setUiState({ othersCollapsed: next });
  }

  function openRun(run: Run): void {
    void browser.tabs.create({ url: run.htmlUrl });
  }

  function renderRun(run: Run): JSX.Element {
    return (
      <div className={cn('flex items-center gap-2', comfortable && 'py-2.5')}>
        <StatusIcon state={run.state} />
        <div className="min-w-0 flex-1">
          <div className={cn('font-medium', comfortable ? 'text-base' : 'truncate')}>
            {run.workflow || '—'}
          </div>
          {comfortable && renderSecondary ? (
            renderSecondary(run, allFullNames)
          ) : (
            <div className="truncate text-xs text-muted-foreground">
              {run.repo.owner}/{run.repo.name} · {run.branch || '—'} · {run.event} · {run.actor}
            </div>
          )}
        </div>
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {duration(run.startedAt, run.completedAt, now)}
        </span>
      </div>
    );
  }

  if (capabilities?.actions === 'unsupported') {
    return <ErrorState messageKey="buildsUnsupported" />;
  }
  if (capabilities?.actions === 'forbidden') {
    return <ErrorState messageKey="buildsForbidden" />;
  }
  if (snapshot?.sectionErrors?.runs) {
    return <ErrorState messageKey="buildsSectionError" />;
  }

  if (mine.length === 0 && others.length === 0) {
    return <Empty messageKey="buildsEmpty" />;
  }

  return (
    <div>
      <section className="mb-2">
        <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('buildsGroupMine')}
          <Badge variant="secondary">{mine.length}</Badge>
        </h3>
        {mine.length === 0 ? (
          <Empty messageKey="buildsEmpty" />
        ) : (
          <List
            items={mine}
            selectedIndex={mineSelectedIndex}
            onSelectIndex={setSelectedFlat}
            onBoundary={handleBoundary}
            focusOnly
            containerRef={mineRef}
            onActivate={openRun}
            aria-label={t('buildsGroupMine')}
            idPrefix="gd-builds-mine"
            maxHeight="none"
            renderItem={renderRun}
          />
        )}
      </section>
      <Separator className="mb-2" />
      <Collapsible
        open={!othersCollapsed}
        onOpenChange={() => toggleOthers()}
      >
        <h3>
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ChevronDown
                size={14}
                className={cn('transition-transform', !othersCollapsed && 'rotate-180')}
              />
              {t('buildsGroupOthers')}
            </span>
            <span className="flex items-center gap-1.5 normal-case tracking-normal">
              <Badge variant="secondary">{activeOthers}</Badge>
              <Badge variant="destructive">{failedOthers}</Badge>
              <span className="sr-only">
                {t('buildsOthersCounter', [String(activeOthers), String(failedOthers)])}
              </span>
            </span>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent>
          {others.length === 0 ? (
            <Empty messageKey="buildsEmpty" />
          ) : (
            <List
              items={others}
              selectedIndex={othersSelectedIndex}
              onSelectIndex={(i) => setSelectedFlat(mine.length + i)}
              onBoundary={handleBoundary}
              focusOnly
              containerRef={othersRef}
              onActivate={openRun}
              aria-label={t('buildsGroupOthers')}
              idPrefix="gd-builds-others"
              maxHeight="none"
              renderItem={renderRun}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
