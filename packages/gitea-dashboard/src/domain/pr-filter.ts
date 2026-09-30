// Pure PR table filtering/sorting/faceting for the "table" view of the PR
// section. No browser APIs here.
// Source of truth: docs/specs/002-fullpage-dashboard/data-model.md
// "PrTableFilter (в адресе)", spec.md US3 (FR-110), tasks.md T014/T015.

import type { PrSort } from './route';
import type { PrTableFilter } from './route';
import type { PullRequest } from './types';

type PrFacetKey = 'repo' | 'author' | 'ci';

function repoKey(pr: PullRequest): string {
  return `${pr.repo.owner}/${pr.repo.name}`;
}

function matchesQuery(pr: PullRequest, q: string): boolean {
  if (q === '') {
    return true;
  }
  const needle = q.toLowerCase();
  const candidates = [pr.title, repoKey(pr), `#${pr.number}`, pr.author];
  return candidates.some((candidate) => candidate.toLowerCase().includes(needle));
}

/**
 * Builds a predicate over PullRequest applying every part of `filter`
 * except the facet named by `excludeFacet` (used by facetCounts to compute
 * each facet's counts against the *other* active filters, per shadcn
 * faceted-filter semantics).
 */
function buildPredicate(
  filter: PrTableFilter,
  excludeFacet?: PrFacetKey,
): (pr: PullRequest) => boolean {
  return (pr: PullRequest) => {
    if (excludeFacet !== 'repo' && filter.repo.length > 0 && !filter.repo.includes(repoKey(pr))) {
      return false;
    }
    if (excludeFacet !== 'author' && filter.author.length > 0 && !filter.author.includes(pr.author)) {
      return false;
    }
    if (excludeFacet !== 'ci' && filter.ci.length > 0 && !filter.ci.includes(pr.ci.state)) {
      return false;
    }
    if (filter.draft === 'only' && !pr.draft) {
      return false;
    }
    if (filter.draft === 'exclude' && pr.draft) {
      return false;
    }
    if (filter.conflict === 'only' && pr.mergeable !== false) {
      return false;
    }
    if (!matchesQuery(pr, filter.q)) {
      return false;
    }
    return true;
  };
}

function sortValue(pr: PullRequest, column: string): string {
  switch (column) {
    case 'title':
      return pr.title.toLowerCase();
    case 'repo':
      return repoKey(pr).toLowerCase();
    case 'author':
      return pr.author.toLowerCase();
    case 'ci':
      return pr.ci.state;
    case 'updated':
    default:
      return pr.updatedAt;
  }
}

function compareBySort(a: PullRequest, b: PullRequest, sort: PrSort): number {
  const av = sortValue(a, sort.column);
  const bv = sortValue(b, sort.column);
  const cmp = av < bv ? -1 : av > bv ? 1 : 0;
  return sort.direction === 'desc' ? -cmp : cmp;
}

/**
 * Filters `prs` by every criterion in `filter` (repo/author/ci sets,
 * draft/conflict flags, case-insensitive `q` over title/owner-repo/#number/
 * author) and sorts the result by `filter.sort` (defaults to updated:desc).
 * Does not mutate `prs`.
 */
export function applyPrFilter(prs: readonly PullRequest[], filter: PrTableFilter): PullRequest[] {
  const predicate = buildPredicate(filter);
  return prs.filter(predicate).sort((a, b) => compareBySort(a, b, filter.sort));
}

export interface PrFacetCounts {
  repo: Map<string, number>;
  author: Map<string, number>;
  ci: Map<string, number>;
}

function countBy(
  prs: readonly PullRequest[],
  filter: PrTableFilter,
  facet: PrFacetKey,
  keyOf: (pr: PullRequest) => string,
): Map<string, number> {
  const predicate = buildPredicate(filter, facet);
  const counts = new Map<string, number>();
  for (const pr of prs) {
    if (!predicate(pr)) {
      continue;
    }
    const key = keyOf(pr);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Computes per-facet value counts for the repo/author/ci filters:
 * each facet's counts are computed against every OTHER active filter but
 * not its own (shadcn faceted-filter semantics), so picking a value in one
 * facet doesn't zero out its own sibling options.
 */
export function facetCounts(prs: readonly PullRequest[], filter: PrTableFilter): PrFacetCounts {
  return {
    repo: countBy(prs, filter, 'repo', repoKey),
    author: countBy(prs, filter, 'author', (pr) => pr.author),
    ci: countBy(prs, filter, 'ci', (pr) => pr.ci.state),
  };
}
