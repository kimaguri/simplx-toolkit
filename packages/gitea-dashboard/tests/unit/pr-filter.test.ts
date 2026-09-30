// Contract: docs/specs/002-fullpage-dashboard/data-model.md "PrTableFilter (в
// адресе)", spec.md US3 (FR-110, SC-106), tasks.md T014.
import { describe, expect, it } from 'vitest';
import { applyPrFilter, facetCounts } from '../../src/domain/pr-filter';
import { DEFAULT_PR_SORT, type PrTableFilter } from '../../src/domain/route';
import type { CiState, PrGroup, PullRequest } from '../../src/domain/types';

function ci(state: CiState) {
  return { state, fetchedAt: '2026-01-01T00:00:00Z' };
}

const PR_GROUPS: readonly PrGroup[] = ['review', 'mine', 'other'];
const CI_STATES: readonly CiState[] = ['success', 'failure', 'pending', 'error'];

function pr(overrides: Partial<PullRequest> & { id: number }): PullRequest {
  return {
    repo: { owner: 'acme', name: 'platform' },
    number: overrides.id,
    title: `PR ${overrides.id}`,
    author: 'alice',
    updatedAt: '2026-01-01T00:00:00Z',
    htmlUrl: `https://example.test/acme/platform/pulls/${overrides.id}`,
    draft: false,
    group: 'other',
    ci: ci('success'),
    ...overrides,
  };
}

function emptyFilter(overrides: Partial<PrTableFilter> = {}): PrTableFilter {
  return {
    repo: [],
    author: [],
    ci: [],
    q: '',
    sort: DEFAULT_PR_SORT,
    ...overrides,
  };
}

const prs: PullRequest[] = [
  pr({
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    title: 'Fix login bug',
    author: 'alice',
    updatedAt: '2026-01-03T00:00:00Z',
    draft: false,
    group: 'review',
    ci: ci('success'),
  }),
  pr({
    id: 2,
    repo: { owner: 'acme', name: 'core' },
    title: 'Add feature flag',
    author: 'bob',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: true,
    group: 'mine',
    ci: ci('failure'),
  }),
  pr({
    id: 3,
    repo: { owner: 'umbrella', name: 'web' },
    title: 'Refactor CSS',
    author: 'carol',
    updatedAt: '2026-01-02T00:00:00Z',
    draft: false,
    mergeable: false,
    group: 'other',
    ci: ci('pending'),
  }),
];

describe('applyPrFilter', () => {
  it('returns all PRs sorted by updated desc by default', () => {
    const result = applyPrFilter(prs, emptyFilter());
    expect(result.map((p) => p.id)).toEqual([1, 3, 2]);
  });

  it('does not mutate the input array', () => {
    const copy = [...prs];
    applyPrFilter(prs, emptyFilter());
    expect(prs).toEqual(copy);
  });

  it('filters by a set of repos (owner/name)', () => {
    const result = applyPrFilter(prs, emptyFilter({ repo: ['acme/platform', 'umbrella/web'] }));
    expect(result.map((p) => p.id).sort()).toEqual([1, 3]);
  });

  it('filters by a set of authors', () => {
    const result = applyPrFilter(prs, emptyFilter({ author: ['bob', 'carol'] }));
    expect(result.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  it('filters by a set of CI states', () => {
    const result = applyPrFilter(prs, emptyFilter({ ci: ['failure', 'pending'] as CiState[] }));
    expect(result.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  it('draft "only" keeps only drafts', () => {
    const result = applyPrFilter(prs, emptyFilter({ draft: 'only' }));
    expect(result.map((p) => p.id)).toEqual([2]);
  });

  it('draft "exclude" drops drafts', () => {
    const result = applyPrFilter(prs, emptyFilter({ draft: 'exclude' }));
    expect(result.map((p) => p.id).sort()).toEqual([1, 3]);
  });

  it('conflict "only" keeps only PRs with mergeable === false', () => {
    const result = applyPrFilter(prs, emptyFilter({ conflict: 'only' }));
    expect(result.map((p) => p.id)).toEqual([3]);
  });

  it('search q matches title case-insensitively', () => {
    const result = applyPrFilter(prs, emptyFilter({ q: 'LOGIN' }));
    expect(result.map((p) => p.id)).toEqual([1]);
  });

  it('search q matches owner/repo case-insensitively', () => {
    const result = applyPrFilter(prs, emptyFilter({ q: 'ACME/CORE' }));
    expect(result.map((p) => p.id)).toEqual([2]);
  });

  it('search q matches #number', () => {
    const result = applyPrFilter(prs, emptyFilter({ q: '#3' }));
    expect(result.map((p) => p.id)).toEqual([3]);
  });

  it('search q matches author case-insensitively', () => {
    const result = applyPrFilter(prs, emptyFilter({ q: 'CAROL' }));
    expect(result.map((p) => p.id)).toEqual([3]);
  });

  it('combines multiple filters and search (AND semantics)', () => {
    const result = applyPrFilter(
      prs,
      emptyFilter({ repo: ['acme/platform', 'acme/core'], q: 'feature' }),
    );
    expect(result.map((p) => p.id)).toEqual([2]);
  });

  it('sorts by title asc', () => {
    const result = applyPrFilter(prs, emptyFilter({ sort: { column: 'title', direction: 'asc' } }));
    expect(result.map((p) => p.id)).toEqual([2, 1, 3]);
  });

  it('sorts by repo desc', () => {
    const result = applyPrFilter(prs, emptyFilter({ sort: { column: 'repo', direction: 'desc' } }));
    expect(result.map((p) => p.id)).toEqual([3, 1, 2]);
  });

  it('sorts by author asc', () => {
    const result = applyPrFilter(prs, emptyFilter({ sort: { column: 'author', direction: 'asc' } }));
    expect(result.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('sorts by ci asc', () => {
    const result = applyPrFilter(prs, emptyFilter({ sort: { column: 'ci', direction: 'asc' } }));
    expect(result.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('sorts by updated asc', () => {
    const result = applyPrFilter(prs, emptyFilter({ sort: { column: 'updated', direction: 'asc' } }));
    expect(result.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('filters 200 generated PRs and sorts them in under 20ms', () => {
    const many: PullRequest[] = Array.from({ length: 200 }, (_, i) =>
      pr({
        id: i,
        repo: { owner: `owner${i % 10}`, name: `repo${i % 5}` },
        title: `Title ${i} ${i % 7 === 0 ? 'urgent' : ''}`,
        author: `author${i % 13}`,
        updatedAt: new Date(2026, 0, 1 + (i % 30)).toISOString(),
        draft: i % 4 === 0,
        mergeable: i % 5 !== 0,
        group: PR_GROUPS[i % 3]!,
        ci: ci(CI_STATES[i % 4]!),
      }),
    );
    const filter = emptyFilter({ q: 'urgent', sort: { column: 'title', direction: 'asc' } });

    const start = performance.now();
    const result = applyPrFilter(many, filter);
    const elapsed = performance.now() - start;

    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(20);
  });
});

describe('facetCounts', () => {
  it('counts each facet value with no active filters (whole set)', () => {
    const counts = facetCounts(prs, emptyFilter());
    expect(counts.repo.get('acme/platform')).toBe(1);
    expect(counts.repo.get('acme/core')).toBe(1);
    expect(counts.repo.get('umbrella/web')).toBe(1);
    expect(counts.author.get('alice')).toBe(1);
    expect(counts.author.get('bob')).toBe(1);
    expect(counts.author.get('carol')).toBe(1);
    expect(counts.ci.get('success')).toBe(1);
    expect(counts.ci.get('failure')).toBe(1);
    expect(counts.ci.get('pending')).toBe(1);
    expect('group' in counts).toBe(false);
  });

  it('a facet ignores its own active filter but applies the others (shadcn faceted semantics)', () => {
    // Selecting repo=acme/platform should not shrink the repo facet's own
    // counts, but SHOULD shrink the author facet (author alice is the only
    // one on acme/platform).
    const filter = emptyFilter({ repo: ['acme/platform'] });
    const counts = facetCounts(prs, filter);

    expect(counts.repo.get('acme/platform')).toBe(1);
    expect(counts.repo.get('acme/core')).toBe(1);
    expect(counts.repo.get('umbrella/web')).toBe(1);

    expect(counts.author.get('alice')).toBe(1);
    expect(counts.author.has('bob')).toBe(false);
    expect(counts.author.has('carol')).toBe(false);
  });

  it('applies search q to facet counts', () => {
    const filter = emptyFilter({ q: 'feature' });
    const counts = facetCounts(prs, filter);
    expect(counts.repo.get('acme/core')).toBe(1);
    expect(counts.repo.has('acme/platform')).toBe(false);
    expect(counts.repo.has('umbrella/web')).toBe(false);
  });

  it('applies draft/conflict flags to facet counts', () => {
    const filter = emptyFilter({ conflict: 'only' });
    const counts = facetCounts(prs, filter);
    expect(counts.repo.get('umbrella/web')).toBe(1);
    expect(counts.repo.has('acme/platform')).toBe(false);
    expect(counts.repo.has('acme/core')).toBe(false);
  });
});
