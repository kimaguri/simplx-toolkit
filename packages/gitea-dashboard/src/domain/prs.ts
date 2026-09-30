// Pull-request grouping / merging. Pure, no browser APIs.
// Source of truth: docs/specs/001-gitea-dashboard/data-model.md "PullRequest",
// research.md R7/R8, spec.md FR-020..022/FR-034/FR-035.

import type { ApiIssue, ApiPullRequest } from '../api/types';
import type { PrHead, PrHeadsEntry } from '../lib/storage';
import type { CiStatus, PrGroup, PullRequest, RepoRef, Settings } from './types';

// ---------------------------------------------------------------------------
// groupPrs
// ---------------------------------------------------------------------------

export interface GroupPrsInput {
  /** issues/search?review_requested=true — PRs where I'm a requested reviewer. */
  review: ApiIssue[];
  /** issues/search?created=true — PRs I authored. */
  created: ApiIssue[];
  /** issues/search?owner=<org> (+ includeRepos / own repos) — candidate "other" PRs. */
  others: ApiIssue[];
  /** My login, used to dedupe "others" against PRs I authored. */
  me: string;
  settings: Settings;
}

function repoKey(fullName: string): string {
  return fullName;
}

function toRepoRef(fullName: string): RepoRef {
  const slash = fullName.indexOf('/');
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

function toPullRequest(issue: ApiIssue, group: PrGroup): PullRequest {
  return {
    id: issue.id,
    repo: toRepoRef(issue.repository.full_name),
    number: issue.number,
    title: issue.title,
    author: issue.user.login,
    updatedAt: issue.updated_at,
    htmlUrl: issue.html_url,
    draft: issue.pull_request?.draft ?? false,
    group,
    // headSha/headRef/mergeable/ci are filled in later by mergeHeads/mergeCi,
    // once the cached PR-heads entry and status cache are available. 'none'
    // ("no checks") is the honest placeholder — 'pending' would falsely
    // render as "running" before we've even looked.
    ci: { state: 'none', fetchedAt: '' },
  };
}

/**
 * Builds the deduplicated, grouped PR list shown in the "PR" tab (FR-020).
 *
 * - `review` wins over `created` wins over `others` when the same PR id
 *   appears in more than one input (a PR is shown exactly once).
 * - `others` drops PRs authored by `me` (those already appear via `created`),
 *   and applies `settings.scope.excludeRepos` / `excludeOrgs`, unless the
 *   repo is explicitly listed in `settings.scope.includeRepos` (FR-035).
 * - The result is sorted by `updatedAt` descending.
 */
export function groupPrs(input: GroupPrsInput): PullRequest[] {
  const { review, created, others, me, settings } = input;
  const { excludeRepos, excludeOrgs, includeRepos } = settings.scope;

  const seen = new Set<number>();
  const result: PullRequest[] = [];

  for (const issue of review) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    result.push(toPullRequest(issue, 'review'));
  }

  for (const issue of created) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    result.push(toPullRequest(issue, 'mine'));
  }

  for (const issue of others) {
    if (seen.has(issue.id)) continue;
    if (issue.user.login === me) continue;

    const fullName = issue.repository.full_name;
    const owner = fullName.slice(0, fullName.indexOf('/'));
    const included = includeRepos.includes(repoKey(fullName));

    if (!included) {
      if (excludeRepos.includes(repoKey(fullName))) continue;
      if (excludeOrgs.includes(owner)) continue;
    }

    seen.add(issue.id);
    result.push(toPullRequest(issue, 'other'));
  }

  result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

/**
 * Adapts an A8 (`GET .../pulls`) item into the `ApiIssue` shape `groupPrs`
 * expects, for `includeRepos` (repos outside the user's orgs, FR-034/FR-035):
 * those repos have no A7 `owner=` search to draw "other" candidates from, so
 * their open PRs are read straight from the same A8 response already fetched
 * for `prHeads` (no extra request).
 */
export function pullToIssue(pull: ApiPullRequest, repoFullName: string): ApiIssue {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    user: pull.user,
    updated_at: pull.updated_at,
    html_url: pull.html_url,
    repository: { full_name: repoFullName },
    pull_request: { draft: pull.draft },
  };
}

// ---------------------------------------------------------------------------
// mergeHeads
// ---------------------------------------------------------------------------

/**
 * Merges the cached PR-heads entries into `prs`, setting
 * `headSha`/`headRef`/`mergeable`. Reads from the CACHE (`PrHeadsEntry`,
 * `storage.ts`), not from a same-cycle fetch: `reposNeedingHeads` only
 * re-fetches repos whose PR list actually changed (R9), so on any given
 * cycle most repos rely entirely on what's already in the cache — `prHeads`
 * must therefore already contain every repo's latest known heads, kept
 * current via `updatePrHeads`. `mergeable === false` flags a merge conflict;
 * `undefined` (not yet computed by Gitea, or repo/PR not cached yet) means
 * unknown, not a conflict.
 */
export function mergeHeads(
  prs: PullRequest[],
  prHeads: Record<string, PrHeadsEntry>
): PullRequest[] {
  return prs.map((pr) => {
    const entry = prHeads[`${pr.repo.owner}/${pr.repo.name}`];
    const head = entry?.heads[pr.number];
    if (!head) return pr;
    return {
      ...pr,
      headSha: head.sha,
      headRef: head.ref,
      baseRef: head.baseRef,
      mergeable: head.mergeable,
    };
  });
}

// ---------------------------------------------------------------------------
// toPrHeadsEntry / updatePrHeads
// ---------------------------------------------------------------------------

/**
 * Builds a `PrHeadsEntry` (the `prHeads:<instanceId>` cache shape) from a
 * freshly fetched per-repo pull list (A8, `GET .../pulls`) and the
 * `maxUpdatedAt` this fetch covers (see `reposNeedingHeads`). `null`
 * mergeable (not yet computed by Gitea) is stored as `undefined`.
 */
export function toPrHeadsEntry(pulls: ApiPullRequest[], maxUpdatedAt: string): PrHeadsEntry {
  const heads: Record<number, PrHead> = {};
  for (const pull of pulls) {
    heads[pull.number] = {
      sha: pull.head.sha,
      ref: pull.head.ref,
      mergeable: pull.mergeable ?? undefined,
      baseRef: pull.base?.ref,
    };
  }
  return { maxUpdatedAt, heads };
}

/**
 * Returns an updated `prHeads` cache: repos present in `fetched` get a fresh
 * entry (built from their new pull list and the max `updated_at` among
 * `issues` for that repo); every other repo's cached entry is carried over
 * unchanged — this is what keeps `mergeHeads` working across cycles where a
 * repo's PR list wasn't re-fetched (R9 / seam fix).
 */
export function updatePrHeads(
  cache: Record<string, PrHeadsEntry>,
  fetched: Record<string, ApiPullRequest[]>,
  issues: ApiIssue[]
): Record<string, PrHeadsEntry> {
  const repoKeys = Object.keys(fetched);
  if (repoKeys.length === 0) return cache;

  const maxByRepo = new Map<string, string>();
  for (const issue of issues) {
    const fullName = issue.repository.full_name;
    const current = maxByRepo.get(fullName);
    if (!current || issue.updated_at > current) {
      maxByRepo.set(fullName, issue.updated_at);
    }
  }

  const next = { ...cache };
  for (const repo of repoKeys) {
    const maxUpdatedAt = maxByRepo.get(repo) ?? cache[repo]?.maxUpdatedAt ?? '';
    next[repo] = toPrHeadsEntry(fetched[repo]!, maxUpdatedAt);
  }
  return next;
}

// ---------------------------------------------------------------------------
// mergeCi
// ---------------------------------------------------------------------------

/**
 * Merges the CI status cache (keyed by head sha) into `prs` (FR-022). PRs
 * with no `headSha` yet, or whose sha is not (yet) in the cache, keep their
 * current `ci` value.
 */
export function mergeCi(prs: PullRequest[], statusCache: Record<string, CiStatus>): PullRequest[] {
  return prs.map((pr) => {
    if (!pr.headSha) return pr;
    const status = statusCache[pr.headSha];
    if (!status) return pr;
    return { ...pr, ci: status };
  });
}

// ---------------------------------------------------------------------------
// reposNeedingHeads
// ---------------------------------------------------------------------------

/**
 * Returns the repos among `issues` whose PR list (heads/mergeable) needs
 * re-fetching: no cache entry yet, or the newest `updated_at` among their
 * issues is more recent than the cached `maxUpdatedAt` (R9 — unchanged repos
 * are not re-queried).
 */
export function reposNeedingHeads(
  issues: ApiIssue[],
  prHeads: Record<string, PrHeadsEntry>
): RepoRef[] {
  const maxByRepo = new Map<string, string>();
  for (const issue of issues) {
    const fullName = issue.repository.full_name;
    const current = maxByRepo.get(fullName);
    if (!current || issue.updated_at > current) {
      maxByRepo.set(fullName, issue.updated_at);
    }
  }

  const result: RepoRef[] = [];
  for (const [fullName, maxUpdatedAt] of maxByRepo) {
    const cached = prHeads[fullName];
    if (!cached || maxUpdatedAt > cached.maxUpdatedAt) {
      result.push(toRepoRef(fullName));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// shasNeedingStatus
// ---------------------------------------------------------------------------

/**
 * Returns the distinct head shas among `prs` that need a status request:
 * shas with no cache entry, or cached but not final (still `pending`,
 * FR-022). PRs without a `headSha` yet are skipped.
 */
export function shasNeedingStatus(
  prs: PullRequest[],
  statusCache: Record<string, CiStatus>
): string[] {
  const shas = new Set<string>();
  for (const pr of prs) {
    if (!pr.headSha) continue;
    const cached = statusCache[pr.headSha];
    if (!cached || cached.state === 'pending') {
      shas.add(pr.headSha);
    }
  }
  return Array.from(shas);
}
