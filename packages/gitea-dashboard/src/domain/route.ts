// Page hash routing: `#/<section>?<params>`. Pure functions over
// URLSearchParams — no browser APIs (no window/location access) here.
// Source of truth: docs/specs/002-fullpage-dashboard/data-model.md
// "PageRoute (адрес страницы)", "PrTableFilter (в адресе)",
// "RunHistoryFilter (в адресе)", research.md R2.

import type { CiState, RunState } from './types';

// ---------------------------------------------------------------------------
// PageRoute
// ---------------------------------------------------------------------------

export type PageSection = 'repos' | 'prs' | 'builds';
export type PageView = 'table' | 'history';

export interface PageRoute {
  section: PageSection;
  view?: PageView;
  params: URLSearchParams;
}

const SECTIONS: readonly PageSection[] = ['repos', 'prs', 'builds'];
const VIEWS: readonly PageView[] = ['table', 'history'];

function isPageSection(value: string): value is PageSection {
  return (SECTIONS as readonly string[]).includes(value);
}

function isPageView(value: string): value is PageView {
  return (VIEWS as readonly string[]).includes(value);
}

/**
 * Parses a page hash (e.g. `#/prs?view=table&repo=a/b`) into a PageRoute.
 *
 * - Empty hash (`''`, `'#'`, `'#/'`) → `fallbackSection` (data-model: "По
 *   умолчанию раздел из `ui.lastPageSection`, иначе `prs`" — the caller
 *   passes that already-resolved default in).
 * - A present but unrecognized section → `prs` (fallbackSection is ignored).
 */
export function parseRoute(hash: string, fallbackSection: PageSection): PageRoute {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = withoutHash.startsWith('/') ? withoutHash.slice(1) : withoutHash;
  const queryIndex = path.indexOf('?');
  const sectionPart = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  const params = new URLSearchParams(queryPart);

  let section: PageSection;
  if (sectionPart === '') {
    section = fallbackSection;
  } else if (isPageSection(sectionPart)) {
    section = sectionPart;
  } else {
    section = 'prs';
  }

  const viewParam = params.get('view');
  const view = viewParam !== null && isPageView(viewParam) ? viewParam : undefined;

  return { section, view, params };
}

/**
 * Serializes a PageRoute back to a hash string starting with `#/`.
 *
 * `route.params` is the source of truth for the query string (it already
 * carries `view` when set, see `parseRoute`) — this keeps
 * `serializeRoute(parseRoute(hash, fb))` semantically idempotent.
 */
export function serializeRoute(route: PageRoute): string {
  const query = route.params.toString();
  return query === '' ? `#/${route.section}` : `#/${route.section}?${query}`;
}

// ---------------------------------------------------------------------------
// PrTableFilter
// ---------------------------------------------------------------------------

const CI_STATES: readonly CiState[] = [
  'success',
  'failure',
  'error',
  'pending',
  'warning',
  'skipped',
  'none',
];
const PR_DRAFT_VALUES = ['only', 'exclude'] as const;
const PR_CONFLICT_VALUES = ['only'] as const;

export type PrSortDirection = 'asc' | 'desc';
export interface PrSort {
  column: string;
  direction: PrSortDirection;
}

export const DEFAULT_PR_SORT: PrSort = { column: 'updated', direction: 'desc' };

export interface PrTableFilter {
  repo: string[];
  author: string[];
  ci: CiState[];
  draft?: (typeof PR_DRAFT_VALUES)[number];
  conflict?: (typeof PR_CONFLICT_VALUES)[number];
  q: string;
  sort: PrSort;
}

function parseSort(raw: string | null, fallback: PrSort): PrSort {
  if (raw === null) {
    return fallback;
  }
  const colonIndex = raw.lastIndexOf(':');
  if (colonIndex === -1) {
    return fallback;
  }
  const column = raw.slice(0, colonIndex);
  const direction = raw.slice(colonIndex + 1);
  if (column === '' || (direction !== 'asc' && direction !== 'desc')) {
    return fallback;
  }
  return { column, direction };
}

function serializeSort(sort: PrSort): string {
  return `${sort.column}:${sort.direction}`;
}

/** Reads a PrTableFilter from route params, dropping unrecognized values. */
export function prTableFilterFromParams(params: URLSearchParams): PrTableFilter {
  const draftRaw = params.get('draft');
  const conflictRaw = params.get('conflict');
  return {
    repo: params.getAll('repo'),
    author: params.getAll('author'),
    ci: params.getAll('ci').filter((v): v is CiState => (CI_STATES as readonly string[]).includes(v)),
    draft:
      draftRaw !== null && (PR_DRAFT_VALUES as readonly string[]).includes(draftRaw)
        ? (draftRaw as (typeof PR_DRAFT_VALUES)[number])
        : undefined,
    conflict:
      conflictRaw !== null && (PR_CONFLICT_VALUES as readonly string[]).includes(conflictRaw)
        ? (conflictRaw as (typeof PR_CONFLICT_VALUES)[number])
        : undefined,
    q: params.get('q') ?? '',
    sort: parseSort(params.get('sort'), DEFAULT_PR_SORT),
  };
}

/** Serializes a PrTableFilter to URLSearchParams (inverse of fromParams). */
export function prTableFilterToParams(filter: PrTableFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const repo of filter.repo) {
    params.append('repo', repo);
  }
  for (const author of filter.author) {
    params.append('author', author);
  }
  for (const ci of filter.ci) {
    params.append('ci', ci);
  }
  if (filter.draft !== undefined) {
    params.set('draft', filter.draft);
  }
  if (filter.conflict !== undefined) {
    params.set('conflict', filter.conflict);
  }
  if (filter.q !== '') {
    params.set('q', filter.q);
  }
  params.set('sort', serializeSort(filter.sort));
  return params;
}

// ---------------------------------------------------------------------------
// RunHistoryFilter
// ---------------------------------------------------------------------------

export type RunHistoryPeriod = 'today' | '24h' | '7d' | '30d';
const RUN_HISTORY_PERIODS: readonly RunHistoryPeriod[] = ['today', '24h', '7d', '30d'];
const RUN_STATES: readonly RunState[] = [
  'waiting',
  'blocked',
  'running',
  'success',
  'failure',
  'cancelled',
  'skipped',
];

export type RunHistorySortColumn = 'started' | 'duration';
export interface RunHistorySort {
  column: RunHistorySortColumn;
  direction: PrSortDirection;
}

export const DEFAULT_RUN_HISTORY_SORT: RunHistorySort = { column: 'started', direction: 'desc' };
export const DEFAULT_RUN_HISTORY_PERIOD: RunHistoryPeriod = 'today';

/** History tab: `builds` (release + build runs, default) or `all` runs. */
export type RunHistoryKind = 'builds' | 'all';

export interface RunHistoryFilter {
  kind: RunHistoryKind;
  period: RunHistoryPeriod;
  repo: string[];
  wf: string[];
  branch: string[];
  event: string[];
  result: RunState[];
  mine: boolean;
  sort: RunHistorySort;
}

function parseRunHistorySort(raw: string | null): RunHistorySort {
  if (raw === null) {
    return DEFAULT_RUN_HISTORY_SORT;
  }
  const colonIndex = raw.lastIndexOf(':');
  if (colonIndex === -1) {
    return DEFAULT_RUN_HISTORY_SORT;
  }
  const column = raw.slice(0, colonIndex);
  const direction = raw.slice(colonIndex + 1);
  if (
    (column !== 'started' && column !== 'duration') ||
    (direction !== 'asc' && direction !== 'desc')
  ) {
    return DEFAULT_RUN_HISTORY_SORT;
  }
  return { column, direction };
}

/** Reads a RunHistoryFilter from route params, dropping unrecognized values. */
export function runHistoryFilterFromParams(params: URLSearchParams): RunHistoryFilter {
  const periodRaw = params.get('period');
  return {
    kind: params.get('kind') === 'all' ? 'all' : 'builds',
    period:
      periodRaw !== null && (RUN_HISTORY_PERIODS as readonly string[]).includes(periodRaw)
        ? (periodRaw as RunHistoryPeriod)
        : DEFAULT_RUN_HISTORY_PERIOD,
    repo: params.getAll('repo'),
    wf: params.getAll('wf'),
    branch: params.getAll('branch'),
    event: params.getAll('event'),
    result: params
      .getAll('result')
      .filter((v): v is RunState => (RUN_STATES as readonly string[]).includes(v)),
    mine: params.get('mine') === '1',
    sort: parseRunHistorySort(params.get('sort')),
  };
}

/** Serializes a RunHistoryFilter to URLSearchParams (inverse of fromParams). */
export function runHistoryFilterToParams(filter: RunHistoryFilter): URLSearchParams {
  const params = new URLSearchParams();
  params.set('period', filter.period);
  if (filter.kind === 'all') {
    params.set('kind', 'all');
  }
  for (const repo of filter.repo) {
    params.append('repo', repo);
  }
  for (const wf of filter.wf) {
    params.append('wf', wf);
  }
  for (const branch of filter.branch) {
    params.append('branch', branch);
  }
  for (const event of filter.event) {
    params.append('event', event);
  }
  for (const result of filter.result) {
    params.append('result', result);
  }
  if (filter.mine) {
    params.set('mine', '1');
  }
  params.set('sort', `${filter.sort.column}:${filter.sort.direction}`);
  return params;
}
