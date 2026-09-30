// "PR" table view (US3, spec.md scenarios 1-6): canonical shadcn data-table
// (TanStack Table v9, see prs-columns.tsx) whose filtering/sorting is driven
// entirely by src/domain/pr-filter.ts (applyPrFilter/facetCounts) against a
// PrTableFilter kept in sync with the page hash (src/domain/route.ts) — the
// table itself only renders whatever `applyPrFilter` already produced.
//
// Rendered by src/entrypoints/dashboard/App.tsx's PR section (density
// "comfortable" equivalent — there is no popup/compact variant: the table
// view only exists on the full page, per research.md R3/R8). The popup does
// NOT import this component (checked via `node scripts/check-size.mjs`).
import { useEffect, useMemo, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useTable } from '@tanstack/react-table';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { applyPrFilter, facetCounts } from '../../domain/pr-filter';
import {
  DEFAULT_PR_SORT,
  parseRoute,
  prTableFilterFromParams,
  prTableFilterToParams,
  serializeRoute,
  type PageRoute,
  type PrTableFilter,
} from '../../domain/route';
import { DEFAULT_SETTINGS, type PullRequest, type Settings, type Snapshot } from '../../domain/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Button } from '../../components/ui/button';
import { Empty } from '../../ui/Empty';
import { createPrColumns, features } from './prs-columns';
import { PrsFilters } from './PrsFilters';
import { TablePagination, usePageSize } from '../TablePagination';

const EMPTY_PRS: readonly PullRequest[] = [];

function defaultFilter(): PrTableFilter {
  return { repo: [], author: [], ci: [], q: '', sort: DEFAULT_PR_SORT };
}

/** Reads a PrTableFilter from the current page hash (data-model.md "PrTableFilter"). */
function readFilterFromHash(): PrTableFilter {
  const route = parseRoute(window.location.hash, 'prs');
  return prTableFilterFromParams(route.params);
}

/**
 * Serializes `filter` back onto the current hash, keeping the section
 * (`prs`) and any existing `view` param intact. Search-box typing uses
 * `history.replaceState` (must not spam browser history one keystroke at a
 * time); every other filter/sort change pushes via `location.hash =` (US3
 * scenario 5 — "Сбросить"/facet/sort changes are each a meaningful, back-
 * navigable step). Documented per the brief's "pick one consistently".
 */
function writeFilterToHash(filter: PrTableFilter, replace: boolean): void {
  const route = parseRoute(window.location.hash, 'prs');
  const params = prTableFilterToParams(filter);
  const view = route.params.get('view');
  if (view !== null) {
    params.set('view', view);
  }
  const nextRoute: PageRoute = { section: 'prs', view: route.view, params };
  const hash = serializeRoute(nextRoute);
  if (replace) {
    window.history.replaceState(null, '', hash);
  } else {
    window.location.hash = hash;
  }
}

function hasActiveFilter(filter: PrTableFilter): boolean {
  return (
    filter.repo.length > 0 ||
    filter.author.length > 0 ||
    filter.ci.length > 0 ||
    filter.draft !== undefined ||
    filter.conflict !== undefined ||
    filter.q !== ''
  );
}

export interface PrsTableProps {
  snapshot?: Snapshot | null;
  settings?: Settings;
}

/**
 * PR table view: toolbar (PrsFilters.tsx) + shadcn `table` rendering rows
 * produced by `applyPrFilter`. Column headers are plain sort buttons
 * (ArrowUpDown/ArrowUp/ArrowDown, US3 scenario 4) since sorting is manual —
 * TanStack Table here only supplies the core row/header model + rendering,
 * per the brief ("TanStack only renders").
 */
export function PrsTable({ snapshot = null, settings = DEFAULT_SETTINGS }: PrsTableProps): JSX.Element {
  void settings; // reserved: no settings currently affect the table view.
  const [filter, setFilter] = useState<PrTableFilter>(readFilterFromHash);

  // Back/forward (or any external hash change) re-reads the filter from the
  // hash too (M2, T031) -- compared before setting to avoid a redundant
  // re-render/loop when the hashchange was caused by this component's own
  // `updateFilter` (via `writeFilterToHash`).
  useEffect(() => {
    function handleHashChange(): void {
      const next = readFilterFromHash();
      setFilter((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  function updateFilter(next: PrTableFilter, opts: { replace?: boolean } = {}): void {
    setFilter(next);
    writeFilterToHash(next, opts.replace ?? false);
  }

  function resetFilter(): void {
    updateFilter(defaultFilter());
  }

  function toggleSort(column: string): void {
    const direction: 'asc' | 'desc' =
      filter.sort.column === column && filter.sort.direction === 'asc' ? 'desc' : 'asc';
    updateFilter({ ...filter, sort: { column, direction } });
  }

  function openPr(pr: PullRequest): void {
    void browser.tabs.create({ url: pr.htmlUrl });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, pr: PullRequest): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      openPr(pr);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const row = event.currentTarget;
      const sibling = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      (sibling as HTMLElement | null)?.focus();
    }
  }

  const allPrs = snapshot?.prs ?? EMPTY_PRS;
  const filtered = useMemo(() => applyPrFilter(allPrs, filter), [allPrs, filter]);
  const counts = useMemo(() => facetCounts(allPrs, filter), [allPrs, filter]);

  const allFullNames = useMemo(
    () => filtered.map((pr) => `${pr.repo.owner}/${pr.repo.name}`),
    [filtered]
  );
  const columns = useMemo(() => createPrColumns(allFullNames), [allFullNames]);
  const [pageSize, setPageSize] = usePageSize();
  const [pageIndex, setPageIndex] = useState(0);
  const table = useTable({
    features,
    columns,
    data: filtered,
    autoResetPageIndex: false,
    state: { pagination: { pageIndex, pageSize } },
  });

  // T045: any filter/sort/search change returns to page 1.
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setPageIndex(0);
  }, [filterKey]);
  // Data shrinking (snapshot refresh) must not strand the user past the end.
  const lastPageIndex = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  useEffect(() => {
    setPageIndex((i) => Math.min(i, lastPageIndex));
  }, [lastPageIndex]);

  if (allPrs.length === 0) {
    return <Empty messageKey="prsEmpty" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PrsFilters
        prs={allPrs}
        filter={filter}
        counts={counts}
        onFilterChange={updateFilter}
        onReset={resetFilter}
        hasActiveFilter={hasActiveFilter(filter)}
        shownCount={filtered.length}
        totalCount={allPrs.length}
      />
      {filtered.length === 0 ? (
        <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
          <p>{t('prsTableNoResults')}</p>
          <Button type="button" variant="outline" size="sm" onClick={resetFilter}>
            {t('prsFiltersReset')}
          </Button>
        </div>
      ) : (
        // T025 defect (T031): at narrow widths (e.g. 800px) the table is
        // wider than its container. The shadcn `<Table>` wrapper's own
        // `overflow-x-auto` div already makes this scrollable for a real
        // user (confirmed: `container.scrollWidth > clientWidth`, contained
        // correctly, no layout breakage) -- FR-109/quickstart P10 requires
        // the *page* itself to never gain a horizontal scrollbar, so the
        // overflow must stay scoped to this table container, not bubble up
        // to `<body>`. A still screenshot of a nested-scroll region will
        // always show the not-yet-scrolled-to column looking cut at the
        // edge; that's expected (see prs-table.test.tsx's regression test
        // for the actual scroll behavior, and the T025 screenshots for the
        // wide 1280px layout, which needs no scrolling at all).
        <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort(header.column.id)}
                    >
                      <table.FlexRender header={header} />
                      {filter.sort.column === header.column.id ? (
                        filter.sort.direction === 'asc' ? (
                          <ArrowUp size={14} />
                        ) : (
                          <ArrowDown size={14} />
                        )
                      ) : (
                        <ArrowUpDown size={14} className="opacity-50" />
                      )}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getPaginatedRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                tabIndex={0}
                className="cursor-pointer"
                onClick={() => openPr(row.original)}
                onKeyDown={(event) => handleRowKeyDown(event, row.original)}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      )}
      {filtered.length > 0 && (
        <TablePagination
          pageIndex={Math.min(pageIndex, lastPageIndex)}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPageIndex}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPageIndex(0);
          }}
        />
      )}
    </div>
  );
}
