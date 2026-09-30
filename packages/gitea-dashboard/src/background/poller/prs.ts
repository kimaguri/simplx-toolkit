// Poll Section: pull requests (US3). A5+A6 every cycle; A7 per org
// (instance.capabilities.orgs) + the user's own login when
// settings.showOtherPrs (R8, R10 budget "1 на организацию и 1 на себя").
// A8 (per-repo pull list, for head sha/mergeable/draft) is only requested
// for repos whose PR set changed since the cached `prHeads` entry
// (reposNeedingHeads, R9) — an unchanged cycle skips A8 entirely. A9
// (combined status) is only requested for shas with no cached status yet or
// still `pending` (shasNeedingStatus, FR-022) — final statuses are never
// re-requested.
//
// scope.excludeRepos/excludeOrgs are NOT used to skip A7 requests (every org
// is still probed every cycle per the R10 budget) — they are applied by
// `groupPrs` when building the final "other" group.
//
// Source of truth: docs/specs/001-gitea-dashboard/contracts/gitea-api.md
// (A5-A9), data-model.md ("PullRequest", "prHeads:<instanceId>",
// "statusCache:<instanceId>"), research.md R7-R9.

import { createEndpoints } from '../../api/endpoints';
import type { ApiIssue, ApiPullRequest } from '../../api/types';
import { toCiStatus } from '../../domain/ci';
import {
  groupPrs,
  mergeCi,
  mergeHeads,
  pullToIssue,
  reposNeedingHeads,
  shasNeedingStatus,
  updatePrHeads,
} from '../../domain/prs';
import type { CiStatus, RepoRef, Snapshot, SnapshotCounts } from '../../domain/types';
import { getPrHeads, getStatusCache, setPrHeads, setStatusCache } from '../../lib/storage';
import type { Endpoints } from '../../api/endpoints';
import type { Section, SectionContext } from './index';

const EMPTY_COUNTS: SnapshotCounts = {
  reviews: 0,
  activeMine: 0,
  activeOthers: 0,
  failedOthers: 0,
};

function repoKeyOf(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function parseRepoFullName(fullName: string): RepoRef {
  const slash = fullName.indexOf('/');
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

interface OthersResult {
  items: ApiIssue[];
  totalCount: number;
}

/** A7: owner=<org> for every org in capabilities, plus owner=<login> (self). */
async function fetchOthers(
  endpoints: Endpoints,
  orgs: string[],
  login: string | undefined
): Promise<OthersResult> {
  const owners = login ? [...orgs, login] : orgs;
  if (owners.length === 0) {
    return { items: [], totalCount: 0 };
  }
  const results = await Promise.all(owners.map((owner) => endpoints.searchPrs({ owner })));
  return {
    items: results.flatMap((result) => result.items),
    totalCount: results.reduce((sum, result) => sum + result.totalCount, 0),
  };
}

export const prsSection: Section = {
  name: 'prs',
  async run(ctx: SectionContext): Promise<Partial<Snapshot>> {
    const { instance, settings, client, prev, now } = ctx;
    const endpoints = createEndpoints(client);
    const login = instance.login;

    const [review, created] = await Promise.all([
      endpoints.searchPrs('review'),
      endpoints.searchPrs('created'),
    ]);

    const others = settings.showOtherPrs
      ? await fetchOthers(endpoints, instance.capabilities.orgs, login)
      : { items: [], totalCount: 0 };

    const allIssues = [...review.items, ...created.items, ...others.items];

    // A8: only repos whose PR set actually changed since the cache (R9).
    const prHeadsCache = await getPrHeads(instance.id);
    const reposToFetch = reposNeedingHeads(allIssues, prHeadsCache);

    // includeRepos (FR-034/FR-035, T065): repos outside the user's orgs have
    // no A7 owner= search to draw "other" candidates from, so their open PRs
    // are read from A8 directly. Only when settings.showOtherPrs. Merged into
    // the same A8 fetch/prHeads-cache round as `reposToFetch` so a repo that
    // is both in-scope for R9 and in `includeRepos` is only fetched once.
    const includeRepoRefs = settings.showOtherPrs
      ? settings.scope.includeRepos.map(parseRepoFullName)
      : [];
    const reposToFetchKeys = new Set(reposToFetch.map(repoKeyOf));
    const extraIncludeRepos = includeRepoRefs.filter(
      (repo) => !reposToFetchKeys.has(repoKeyOf(repo))
    );
    const allReposToFetch = [...reposToFetch, ...extraIncludeRepos];

    const fetchedPulls: Record<string, ApiPullRequest[]> = {};
    await Promise.all(
      allReposToFetch.map(async (repo) => {
        fetchedPulls[repoKeyOf(repo)] = await endpoints.openPulls(repo.owner, repo.name);
      })
    );

    const includeRepoIssues = includeRepoRefs.flatMap((repo) => {
      const fullName = repoKeyOf(repo);
      const pulls = fetchedPulls[fullName] ?? [];
      return pulls.map((pull) => pullToIssue(pull, fullName));
    });
    const otherIssues = [
      ...others.items,
      ...includeRepoIssues.filter((issue) => issue.user.login !== login),
    ];

    const nextPrHeads = updatePrHeads(prHeadsCache, fetchedPulls, [
      ...allIssues,
      ...includeRepoIssues,
    ]);
    if (allReposToFetch.length > 0) {
      await setPrHeads(instance.id, nextPrHeads);
    }

    const grouped = groupPrs({
      review: review.items,
      created: created.items,
      others: otherIssues,
      me: login ?? '',
      settings,
    });
    const withHeads = mergeHeads(grouped, nextPrHeads);

    // A9: only shas with no cached status, or still `pending` (FR-022).
    const statusCache = await getStatusCache(instance.id);
    const shasToFetch = shasNeedingStatus(withHeads, statusCache);

    const shaToRepo = new Map<string, RepoRef>();
    for (const pr of withHeads) {
      if (pr.headSha && !shaToRepo.has(pr.headSha)) {
        shaToRepo.set(pr.headSha, pr.repo);
      }
    }

    const nowIso = now.toISOString();
    const statusUpdates: Record<string, CiStatus> = {};
    await Promise.all(
      shasToFetch.map(async (sha) => {
        const repo = shaToRepo.get(sha);
        if (!repo) return;
        const status = await endpoints.combinedStatus(repo.owner, repo.name, sha);
        statusUpdates[sha] = toCiStatus(status, nowIso);
      })
    );

    const nextStatusCache = { ...statusCache, ...statusUpdates };
    if (shasToFetch.length > 0) {
      await setStatusCache(instance.id, nextStatusCache);
    }

    const finalPrs = mergeCi(withHeads, nextStatusCache);

    return {
      prs: finalPrs,
      counts: {
        ...(prev?.counts ?? EMPTY_COUNTS),
        reviews: review.totalCount,
      },
      prTotals: {
        review: review.totalCount,
        mine: created.totalCount,
        other:
          others.totalCount +
          includeRepoIssues.filter((issue) => issue.user.login !== login).length,
      },
    };
  },
};
