// Contract: docs/specs/001-gitea-dashboard/data-model.md "PullRequest"/"CiStatus",
// research.md R7/R8, spec.md FR-020..022/FR-034/FR-035.
import { describe, expect, it } from 'vitest';
import {
  groupPrs,
  mergeCi,
  mergeHeads,
  reposNeedingHeads,
  shasNeedingStatus,
  toPrHeadsEntry,
  updatePrHeads,
  type GroupPrsInput,
} from '../../src/domain/prs';
import { DEFAULT_SETTINGS, type CiStatus, type PullRequest, type Settings } from '../../src/domain/types';
import type { ApiIssue, ApiPullRequest } from '../../src/api/types';
import type { PrHeadsEntry } from '../../src/lib/storage';

import reviewFixture from '../fixtures/issues-search-review.json';
import createdFixture from '../fixtures/issues-search-created.json';
import orgFixture from '../fixtures/issues-search-org.json';
import pullsOpenFixture from '../fixtures/pulls-open.json';

const review = reviewFixture as ApiIssue[]; // acme/platform#12 (alice), acme/core#7 (bob)
const created = createdFixture as ApiIssue[]; // me/dotfiles#21 (me)
const org = orgFixture as ApiIssue[]; // umbrella/web#5 (alice), acme/platform#9 (bob)
const pulls = pullsOpenFixture as ApiPullRequest[]; // #12 mergeable, #7 conflict, #21 draft

function settingsWith(scope: Partial<Settings['scope']>): Settings {
  return { ...DEFAULT_SETTINGS, scope: { ...DEFAULT_SETTINGS.scope, ...scope } };
}

function baseInput(overrides: Partial<GroupPrsInput> = {}): GroupPrsInput {
  return {
    review,
    created,
    others: org,
    me: 'me',
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe('groupPrs', () => {
  it('assigns review/mine/other groups and sorts by updatedAt desc', () => {
    const prs = groupPrs(baseInput());

    expect(prs.map((pr) => `${pr.repo.owner}/${pr.repo.name}#${pr.number}`)).toEqual([
      'me/dotfiles#21',
      'acme/platform#12',
      'acme/core#7',
      'acme/platform#9',
      'umbrella/web#5',
    ]);
    expect(prs.find((pr) => pr.number === 12)?.group).toBe('review');
    expect(prs.find((pr) => pr.number === 7)?.group).toBe('review');
    expect(prs.find((pr) => pr.number === 21)?.group).toBe('mine');
    expect(prs.find((pr) => pr.number === 9)?.group).toBe('other');
    expect(prs.find((pr) => pr.number === 5)?.group).toBe('other');
  });

  it('shows a PR present in both review and others only once, review wins', () => {
    const reviewed = review[0]!;
    const duplicate: ApiIssue = {
      ...reviewed,
      id: reviewed.id,
      repository: { full_name: 'acme/platform' },
    };
    const prs = groupPrs(baseInput({ others: [duplicate, ...org] }));

    const matches = prs.filter((pr) => pr.id === reviewed.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.group).toBe('review');
  });

  it('excludes PRs authored by me from "others" (they belong to "mine" via the created search)', () => {
    const myOwn: ApiIssue = {
      id: 9999,
      number: 42,
      title: 'My PR seen via org search',
      user: { login: 'me' },
      updated_at: '2026-09-26T09:10:00Z',
      html_url: 'https://git.example.test/acme/platform/pulls/42',
      repository: { full_name: 'acme/platform' },
      pull_request: { draft: false },
    };
    const prs = groupPrs(baseInput({ others: [myOwn, ...org] }));

    expect(prs.some((pr) => pr.id === 9999)).toBe(false);
  });

  it('excludes repos in scope.excludeRepos from "others"', () => {
    const prs = groupPrs(
      baseInput({ settings: settingsWith({ excludeRepos: ['acme/platform'] }) })
    );

    expect(prs.some((pr) => pr.number === 9)).toBe(false);
    expect(prs.some((pr) => pr.number === 5)).toBe(true);
  });

  it('excludes organizations in scope.excludeOrgs from "others"', () => {
    const prs = groupPrs(baseInput({ settings: settingsWith({ excludeOrgs: ['umbrella'] }) }));

    expect(prs.some((pr) => pr.number === 5)).toBe(false);
    expect(prs.some((pr) => pr.number === 9)).toBe(true);
  });

  it('keeps repos from an excluded org when explicitly listed in scope.includeRepos', () => {
    const prs = groupPrs(
      baseInput({
        settings: settingsWith({ excludeOrgs: ['umbrella'], includeRepos: ['umbrella/web'] }),
      })
    );

    expect(prs.some((pr) => pr.number === 5)).toBe(true);
  });

  it('gives every PR a placeholder ci status of none (no checks known yet)', () => {
    // 'pending' would falsely render as "running" before we've even looked;
    // 'none' ("no checks") is the honest placeholder until mergeCi runs.
    const prs = groupPrs(baseInput());
    for (const pr of prs) {
      expect(pr.ci.state).toBe('none');
      expect(pr.headSha).toBeUndefined();
    }
  });
});

describe('toPrHeadsEntry', () => {
  it('builds a cache entry keyed by PR number from a repo pull list', () => {
    const pr12 = pulls.find((p) => p.number === 12)!;
    const pr7 = pulls.find((p) => p.number === 7)!;
    const entry = toPrHeadsEntry([pr12, pr7], '2026-09-26T08:45:00Z');

    expect(entry.maxUpdatedAt).toBe('2026-09-26T08:45:00Z');
    expect(entry.heads[12]).toEqual({
      sha: pr12.head.sha,
      ref: pr12.head.ref,
      mergeable: true,
      baseRef: pr12.base.ref,
    });
    expect(entry.heads[7]).toEqual({
      sha: pr7.head.sha,
      ref: pr7.head.ref,
      mergeable: false,
      baseRef: pr7.base.ref,
    });
  });

  it('T056: carries base.ref (target branch) into the cache entry', () => {
    const pr12 = pulls.find((p) => p.number === 12)!;
    const entry = toPrHeadsEntry([pr12], '2026-09-26T08:45:00Z');
    expect(entry.heads[12]!.baseRef).toBe('main');
  });

  it('treats a null mergeable (not yet computed by Gitea) as unknown, not a conflict', () => {
    const pr12 = pulls.find((p) => p.number === 12)!;
    const entry = toPrHeadsEntry([{ ...pr12, mergeable: null }], '2026-09-26T08:45:00Z');
    expect(entry.heads[12]!.mergeable).toBeUndefined();
  });
});

describe('updatePrHeads', () => {
  it('replaces the cache entry for a freshly fetched repo, keeps other repos untouched', () => {
    const pr12 = pulls.find((p) => p.number === 12)!;
    const staleEntry: PrHeadsEntry = {
      maxUpdatedAt: '2000-01-01T00:00:00Z',
      heads: { 12: { sha: 'stale-sha', ref: 'stale-ref' } },
    };
    const untouchedEntry: PrHeadsEntry = {
      maxUpdatedAt: '2026-09-25T22:00:00Z',
      heads: { 5: { sha: 'web-sha', ref: 'web-ref' } },
    };
    const cache: Record<string, PrHeadsEntry> = {
      'acme/platform': staleEntry,
      'umbrella/web': untouchedEntry,
    };

    const updated = updatePrHeads(cache, { 'acme/platform': [pr12] }, review);

    expect(updated['acme/platform']).toEqual({
      maxUpdatedAt: '2026-09-26T08:45:00Z', // review[0].updated_at, the acme/platform#12 issue
      heads: { 12: { sha: pr12.head.sha, ref: pr12.head.ref, mergeable: true, baseRef: pr12.base.ref } },
    });
    expect(updated['umbrella/web']).toBe(untouchedEntry); // not in `fetched` -> unchanged
  });
});

describe('mergeHeads', () => {
  const grouped = groupPrs(baseInput());
  const pr12 = pulls.find((p) => p.number === 12)!;
  const pr7 = pulls.find((p) => p.number === 7)!;

  function cacheOf(byRepo: Record<string, ApiPullRequest[]>): Record<string, PrHeadsEntry> {
    const cache: Record<string, PrHeadsEntry> = {};
    for (const [repo, list] of Object.entries(byRepo)) {
      cache[repo] = toPrHeadsEntry(list, '2026-09-26T08:45:00Z');
    }
    return cache;
  }

  it('sets headSha/headRef/mergeable from the cached PR-heads entry', () => {
    const merged = mergeHeads(
      grouped,
      cacheOf({ 'acme/platform': [pr12], 'acme/core': [pr7] })
    );

    const platform12 = merged.find((pr) => pr.number === 12)!;
    expect(platform12.headSha).toBe(pr12.head.sha);
    expect(platform12.headRef).toBe(pr12.head.ref);
    expect(platform12.mergeable).toBe(true);
    expect(platform12.baseRef).toBe(pr12.base.ref); // T056

    const core7 = merged.find((pr) => pr.number === 7)!;
    expect(core7.headSha).toBe(pr7.head.sha);
    expect(core7.mergeable).toBe(false); // false => conflict flag in the UI
  });

  it('leaves PRs untouched when their repo is not in the cache', () => {
    const merged = mergeHeads(grouped, {});
    for (const pr of merged) {
      expect(pr.headSha).toBeUndefined();
      expect(pr.mergeable).toBeUndefined();
    }
  });

  it('treats a null mergeable (not yet computed by Gitea) as unknown, not a conflict', () => {
    const merged = mergeHeads(grouped, cacheOf({ 'acme/platform': [{ ...pr12, mergeable: null }] }));
    expect(merged.find((pr) => pr.number === 12)?.mergeable).toBeUndefined();
  });

  it('keeps using a repo\'s cached heads across a cycle where it was not re-fetched (seam fix)', () => {
    // Cycle 1: acme/platform needed a fetch, its cache gets populated.
    const cycle1Cache = updatePrHeads({}, { 'acme/platform': [pr12] }, review);

    // Cycle 2: acme/platform did NOT need re-fetching (reposNeedingHeads said
    // no), so `fetched` is empty this time — the cache must still be there.
    const cycle2Cache = updatePrHeads(cycle1Cache, {}, review);
    expect(cycle2Cache).toBe(cycle1Cache); // untouched, same reference

    const merged = mergeHeads(grouped, cycle2Cache);
    const platform12 = merged.find((pr) => pr.number === 12)!;
    expect(platform12.headSha).toBe(pr12.head.sha);
    expect(platform12.headRef).toBe(pr12.head.ref);
    expect(platform12.mergeable).toBe(true);
  });
});

describe('mergeCi', () => {
  it('sets ci from the status cache by headSha, leaves unknown shas as-is', () => {
    const grouped = groupPrs(baseInput());
    const pr12 = pulls.find((p) => p.number === 12)!;
    const withHeads = mergeHeads(grouped, {
      'acme/platform': toPrHeadsEntry([pr12], '2026-09-26T08:45:00Z'),
    });

    const success: CiStatus = { state: 'success', fetchedAt: '2026-09-26T09:00:00Z' };
    const merged = mergeCi(withHeads, { [pr12.head.sha]: success });

    expect(merged.find((pr) => pr.number === 12)?.ci).toEqual(success);
    // #21 has no headSha yet -> untouched placeholder.
    expect(merged.find((pr) => pr.number === 21)?.ci.state).toBe('none');
  });
});

describe('reposNeedingHeads', () => {
  it('includes a repo with no cache entry', () => {
    const repos = reposNeedingHeads(org, {});
    expect(repos).toContainEqual({ owner: 'umbrella', name: 'web' });
    expect(repos).toContainEqual({ owner: 'acme', name: 'platform' });
  });

  it('excludes a repo whose cached maxUpdatedAt already covers the newest issue', () => {
    const cache: Record<string, PrHeadsEntry> = {
      'umbrella/web': { maxUpdatedAt: '2026-09-25T22:00:00Z', heads: {} },
      'acme/platform': { maxUpdatedAt: '2000-01-01T00:00:00Z', heads: {} },
    };
    const repos = reposNeedingHeads(org, cache);

    expect(repos).not.toContainEqual({ owner: 'umbrella', name: 'web' });
    expect(repos).toContainEqual({ owner: 'acme', name: 'platform' });
  });

  it('picks the max(updated_at) per repo when several issues share it', () => {
    const platformIssue = org[1]!; // acme/platform#9, updated_at 2026-09-26T06:20:00Z
    const older: ApiIssue = {
      ...platformIssue,
      id: 12345,
      number: 99,
      updated_at: '2020-01-01T00:00:00Z',
    };
    const cache: Record<string, PrHeadsEntry> = {
      'acme/platform': { maxUpdatedAt: '2026-09-26T06:20:00Z', heads: {} },
    };
    const repos = reposNeedingHeads([older, platformIssue], cache);
    expect(repos).not.toContainEqual({ owner: 'acme', name: 'platform' });
  });
});

describe('shasNeedingStatus', () => {
  it('returns shas with no cache entry and cached-but-not-final shas, skips cached final shas', () => {
    const prs: PullRequest[] = [
      makePr({ number: 1, headSha: 'sha-new' }),
      makePr({ number: 2, headSha: 'sha-final' }),
      makePr({ number: 3, headSha: 'sha-pending' }),
      makePr({ number: 4 }), // no headSha yet -> ignored
    ];
    const cache: Record<string, CiStatus> = {
      'sha-final': { state: 'success', fetchedAt: 'x' },
      'sha-pending': { state: 'pending', fetchedAt: 'x' },
    };

    expect(shasNeedingStatus(prs, cache).sort()).toEqual(['sha-new', 'sha-pending']);
  });

  it('dedupes repeated shas', () => {
    const prs: PullRequest[] = [
      makePr({ number: 1, headSha: 'sha-a' }),
      makePr({ number: 2, headSha: 'sha-a' }),
    ];
    expect(shasNeedingStatus(prs, {})).toEqual(['sha-a']);
  });
});

function makePr(overrides: Partial<PullRequest>): PullRequest {
  return {
    id: overrides.number ?? 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 1,
    title: 't',
    author: 'alice',
    updatedAt: '2026-09-26T09:00:00Z',
    htmlUrl: 'https://git.example.test/acme/platform/pulls/1',
    draft: false,
    group: 'other',
    ci: { state: 'none', fetchedAt: '' },
    ...overrides,
  };
}
