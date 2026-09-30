// "PR" groups section (US3, FR-020..023, FR-072).
//
// Rendered by src/entrypoints/popup/tabs/Prs.tsx (density="compact") and, per
// docs/specs/002-fullpage-dashboard/research.md R8, by the dashboard page
// (density="comfortable") — same behavior, roomier spacing on the page.
import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { relative } from '../../lib/time';
import {
  DEFAULT_SETTINGS,
  type PrGroup,
  type PullRequest,
  type Settings,
  type SnapshotErrorKind,
  type Snapshot,
} from '../../domain/types';
import { List } from '../../ui/List';
import { Empty } from '../../ui/Empty';
import { ErrorState } from '../../ui/ErrorState';
import { Stale } from '../../ui/Stale';
import { StatusIcon } from '../../ui/StatusIcon';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Separator } from '../../components/ui/separator';
import { cn } from '../../lib/utils';

export type Density = 'compact' | 'comfortable';

export interface PrsGroupsProps {
  snapshot?: Snapshot | null;
  settings?: Settings;
  /** Active instance's normalized base URL, for the "ещё N" link (FR-072). */
  baseUrl?: string;
  density: Density;
}

interface GroupDef {
  id: PrGroup;
  titleKey: string;
  emptyKey: string;
}

const GROUPS: readonly GroupDef[] = [
  { id: 'review', titleKey: 'prsGroupReview', emptyKey: 'prsGroupReviewEmpty' },
  { id: 'mine', titleKey: 'prsGroupMine', emptyKey: 'prsGroupMineEmpty' },
  { id: 'other', titleKey: 'prsGroupOther', emptyKey: 'prsGroupOtherEmpty' },
];

/** Maps a per-section error kind to an ErrorState message key. */
function sectionErrorMessageKey(kind: SnapshotErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'authError';
    case 'network':
      return 'prsErrorNetwork';
    case 'forbidden':
      return 'prsErrorForbidden';
    case 'server':
      return 'prsErrorServer';
  }
}

function PrItem({ pr, comfortable }: { pr: PullRequest; comfortable: boolean }): JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-2', comfortable && 'py-2.5')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusIcon state={pr.ci.state} />
          <span className={cn('font-medium', comfortable ? 'text-base' : 'truncate')}>
            {pr.title}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {pr.repo.owner}/{pr.repo.name} #{pr.number} · {pr.author} ·{' '}
            {relative(pr.updatedAt, new Date())}
          </span>
          {pr.draft && <Badge variant="outline">{t('prsDraftBadge')}</Badge>}
          {pr.mergeable === false && <Badge variant="destructive">{t('prsConflictBadge')}</Badge>}
        </div>
      </div>
    </div>
  );
}

interface FlatGroup {
  id: PrGroup;
  items: PullRequest[];
}

/** Locates which group (and local index within it) a flat cross-group index falls into. */
function locateFlat(flatIndex: number, groups: readonly FlatGroup[]): { id: PrGroup; localIndex: number } | null {
  let offset = 0;
  for (const g of groups) {
    if (flatIndex < offset + g.items.length) {
      return { id: g.id, localIndex: flatIndex - offset };
    }
    offset += g.items.length;
  }
  return null;
}

/**
 * Maps a PR group to its "ещё N" target URL on the Gitea instance
 * (FR-072). `review`/`mine` deep-link into the matching Gitea PR-list
 * filter; `other` falls back to the plain PR list.
 */
function moreUrl(baseUrl: string, group: PrGroup): string {
  switch (group) {
    case 'review':
      return `${baseUrl}/pulls?type=review_requested`;
    case 'mine':
      return `${baseUrl}/pulls?type=your_repositories`;
    case 'other':
      return `${baseUrl}/pulls`;
  }
}

/**
 * "PR" groups: "Нужно моё ревью" / "Мои PR" / "Остальные открытые" (the last
 * one hidden by `settings.showOtherPrs`, FR-020), each item's
 * title/owner/repo#N/author/time/CI/draft/conflict (FR-021), a click/Enter
 * opening the PR in a new tab (FR-023), and per-group + whole-section
 * empty/error states (FR-072).
 *
 * Each group is its own keyboard-navigable listbox (arrows + Enter within
 * the group, Tab moves between groups/other controls) — every visible PR is
 * reachable from the keyboard, matching how `List` is used elsewhere
 * (src/features/repos/ReposSection.tsx).
 *
 * When `snapshot.prTotals[group]` exceeds the number of items shown for that
 * group (server-side `X-Total-Count > 50`, FR-072) and `baseUrl` is known, a
 * "ещё N" link opens the rest of that group on the Gitea instance itself.
 */
export function PrsGroups({
  snapshot = null,
  settings = DEFAULT_SETTINGS,
  baseUrl,
  density,
}: PrsGroupsProps): JSX.Element {
  const comfortable = density === 'comfortable';
  // One flat selection index shared across all visible groups (T082): ↑/↓
  // cross group boundaries and exactly one row is ever selected/highlighted
  // per section.
  const [selectedFlat, setSelectedFlat] = useState(0);
  const groupRefs = useRef<Partial<Record<PrGroup, HTMLDivElement | null>>>({});

  function openPr(pr: PullRequest): void {
    void browser.tabs.create({ url: pr.htmlUrl });
  }

  function openMore(group: PrGroup): void {
    if (!baseUrl) return;
    void browser.tabs.create({ url: moreUrl(baseUrl, group) });
  }

  if (!snapshot) {
    return <Empty messageKey="prsEmpty" />;
  }

  const visibleGroups = GROUPS.filter((g) => g.id !== 'other' || settings.showOtherPrs).map(
    (g) => ({ ...g, items: snapshot.prs.filter((pr) => pr.group === g.id) })
  );
  const total = visibleGroups.reduce((sum, g) => sum + g.items.length, 0);
  const sectionError = snapshot.sectionErrors?.prs;

  if (sectionError && total === 0) {
    return <ErrorState messageKey={sectionErrorMessageKey(sectionError.kind)} />;
  }

  if (total === 0) {
    return <Empty messageKey="prsEmpty" />;
  }

  const clampedFlat = Math.min(Math.max(selectedFlat, 0), total - 1);
  const offsets: number[] = [];
  {
    let acc = 0;
    for (const group of visibleGroups) {
      offsets.push(acc);
      acc += group.items.length;
    }
  }

  function handleBoundary(direction: 1 | -1): void {
    const next = Math.min(Math.max(clampedFlat + direction, 0), total - 1);
    if (next === clampedFlat) return;
    setSelectedFlat(next);
    const loc = locateFlat(next, visibleGroups);
    loc && groupRefs.current[loc.id]?.focus();
  }

  return (
    <div>
      {sectionError && <Stale fetchedAt={snapshot.fetchedAt} />}
      {visibleGroups.map((group, index) => {
        const total = snapshot.prTotals?.[group.id];
        const showMore = Boolean(baseUrl) && typeof total === 'number' && total > group.items.length;
        const offset = offsets[index] ?? 0;
        const localIndex = clampedFlat - offset;
        const groupSelectedIndex = localIndex >= 0 && localIndex < group.items.length ? localIndex : -1;
        return (
          <div key={group.id} className="mb-2">
            {index > 0 && <Separator className="mb-2" />}
            <div
              role="heading"
              className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t(group.titleKey)}
              <Badge variant="secondary">{group.items.length}</Badge>
            </div>
            {group.items.length === 0 ? (
              <Empty messageKey={group.emptyKey} />
            ) : (
              <List
                items={group.items}
                selectedIndex={groupSelectedIndex}
                onSelectIndex={(i) => setSelectedFlat(offset + i)}
                onBoundary={handleBoundary}
                focusOnly
                containerRef={(el) => {
                  groupRefs.current[group.id] = el;
                }}
                onActivate={openPr}
                aria-label={t(group.titleKey)}
                idPrefix={`gd-pr-${group.id}`}
                maxHeight="none"
                renderItem={(pr) => <PrItem pr={pr} comfortable={comfortable} />}
              />
            )}
            {showMore && (
              <Button type="button" variant="link" size="sm" onClick={() => openMore(group.id)}>
                {t('prsMoreLink', String((total as number) - group.items.length))}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
