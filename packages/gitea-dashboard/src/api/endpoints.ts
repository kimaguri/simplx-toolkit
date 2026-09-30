// Typed wrappers around ApiClient for each Gitea call this extension makes.
// Source of truth: docs/specs/001-gitea-dashboard/contracts/gitea-api.md (A1-A15).
// Thin layer only: builds the exact path/query per the contract and returns
// the parsed (occasionally unwrapped) response — no domain mapping here.

import type { ApiClient } from './client';
import type {
  ApiActionWorkflow,
  ApiActionWorkflowRunsResponse,
  ApiCombinedStatus,
  ApiIssue,
  ApiOrganization,
  ApiPullRequest,
  ApiRepository,
  ApiSearchResults,
  ApiServerVersion,
  ApiSettings,
  ApiUser,
  ApiNotificationThread,
  ApiWorkflowJob,
  ApiWorkflowJobsResponse,
} from './types';

/**
 * 002 contracts/page-surface.md "Запросы к Gitea" — optional paging/server
 * filters for the history loader (T021). Additive to the existing
 * per-purpose run endpoints below (orgActiveRuns/orgRecentRuns/orgMyRuns,
 * repoRuns's plain `limit` call): `page`/`limit` let a caller walk pages
 * newest-to-oldest at `limit=max_response_items` (research.md R5),
 * `branch`/`event`/`actor` are Gitea's own server-side filters, sent only
 * when the caller passes them (never forced).
 */
export interface RunsQueryOpts {
  page?: number;
  limit?: number;
  branch?: string;
  event?: string;
  actor?: string;
}

export type PrSearchKind = 'review' | 'created' | { owner: string };

export interface PrSearchResult {
  items: ApiIssue[];
  totalCount: number;
}

export interface Endpoints {
  version(): Promise<ApiServerVersion>;
  currentUser(): Promise<ApiUser>;
  userOrgs(): Promise<ApiOrganization[]>;
  searchRepos(q: string, limit: number): Promise<ApiRepository[]>;
  ownRepos(userId: number): Promise<ApiRepository[]>;
  searchPrs(kind: PrSearchKind): Promise<PrSearchResult>;
  openPulls(owner: string, repo: string): Promise<ApiPullRequest[]>;
  combinedStatus(owner: string, repo: string, sha: string): Promise<ApiCombinedStatus>;
  orgActiveRuns(org: string): Promise<ApiActionWorkflowRunsResponse>;
  orgRecentRuns(org: string): Promise<ApiActionWorkflowRunsResponse>;
  repoRuns(
    owner: string,
    repo: string,
    limit?: number,
    opts?: RunsQueryOpts
  ): Promise<ApiActionWorkflowRunsResponse>;
  orgMyRuns(org: string, login: string): Promise<ApiActionWorkflowRunsResponse>;
  /** 002 R5: plain paged org history (no `status` filter), for the history loader. */
  orgRuns(org: string, opts?: RunsQueryOpts): Promise<ApiActionWorkflowRunsResponse>;
  repoWorkflows(owner: string, repo: string): Promise<ApiActionWorkflow[]>;
  notifications(since: string): Promise<ApiNotificationThread[]>;
  /** 002 R5: `GET /settings/api` — `max_response_items` caps run-page `limit`. */
  apiSettings(): Promise<ApiSettings>;
  /** 002 R9: jobs (+ steps) for a single run, for the "build stage" UI. */
  runJobs(owner: string, repo: string, runId: number): Promise<ApiWorkflowJob[]>;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export function createEndpoints(client: ApiClient): Endpoints {
  return {
    // A1
    version() {
      return client.get<ApiServerVersion>('/version');
    },

    // A2
    currentUser() {
      return client.get<ApiUser>('/user');
    },

    // A3
    userOrgs() {
      return client.get<ApiOrganization[]>('/user/orgs', { limit: 50 });
    },

    // A4 — unwraps {ok, data} -> Repository[]; `q` omitted entirely when empty.
    async searchRepos(q, limit) {
      const result = await client.get<ApiSearchResults>('/repos/search', {
        q: q === '' ? undefined : q,
        sort: 'updated',
        order: 'desc',
        limit,
      });
      return result.data;
    },

    // A4 — the signed-in user's own repos (research R1 "own repos with
    // Actions enabled" for runSources): unwraps {ok, data} and drops repos
    // with `has_actions === false` (explicitly disabled); absent/true is
    // kept.
    async ownRepos(userId) {
      const result = await client.get<ApiSearchResults>('/repos/search', {
        uid: userId,
        exclusive: true,
        limit: 20,
      });
      return result.data.filter((repo) => repo.has_actions !== false);
    },

    // A5-A7 — never sends `q`; `review_requested`/`created`/`owner` are
    // mutually exclusive per the requested kind.
    async searchPrs(kind) {
      const extra =
        kind === 'review'
          ? { review_requested: true }
          : kind === 'created'
            ? { created: true }
            : { owner: kind.owner };

      const { data, totalCount } = await client.getWithMeta<ApiIssue[]>('/repos/issues/search', {
        type: 'pulls',
        state: 'open',
        limit: 50,
        ...extra,
      });

      return { items: data, totalCount: totalCount ?? data.length };
    },

    // A8
    openPulls(owner, repo) {
      return client.get<ApiPullRequest[]>(`/repos/${seg(owner)}/${seg(repo)}/pulls`, {
        state: 'open',
        sort: 'recentupdate',
        limit: 50,
      });
    },

    // A9
    combinedStatus(owner, repo, sha) {
      return client.get<ApiCombinedStatus>(
        `/repos/${seg(owner)}/${seg(repo)}/commits/${seg(sha)}/status`
      );
    },

    // A10
    orgActiveRuns(org) {
      return client.get<ApiActionWorkflowRunsResponse>(`/orgs/${seg(org)}/actions/runs`, {
        status: ['queued', 'waiting', 'in_progress'],
        limit: 50,
      });
    },

    // A11
    orgRecentRuns(org) {
      return client.get<ApiActionWorkflowRunsResponse>(`/orgs/${seg(org)}/actions/runs`, {
        limit: 50,
      });
    },

    // A12 — default limit 10 (fallback mode uses 20, passed explicitly by the caller);
    // `opts` (002 R5) additively layers on `page`/`branch`/`event`/`actor` for the
    // history loader without disturbing the existing 2-arg/3-arg call sites.
    repoRuns(owner, repo, limit = 10, opts = {}) {
      return client.get<ApiActionWorkflowRunsResponse>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/runs`,
        { limit, page: opts.page, branch: opts.branch, event: opts.event, actor: opts.actor }
      );
    },

    // A15
    orgMyRuns(org, login) {
      return client.get<ApiActionWorkflowRunsResponse>(`/orgs/${seg(org)}/actions/runs`, {
        actor: login,
        limit: 30,
      });
    },

    // 002 R5 — plain paged org run history (no `status` filter), used by the
    // history loader (src/features/builds/history-loader.ts) instead of the
    // purpose-built A10/A11/A15 above.
    orgRuns(org, opts = {}) {
      return client.get<ApiActionWorkflowRunsResponse>(`/orgs/${seg(org)}/actions/runs`, {
        page: opts.page,
        limit: opts.limit,
        branch: opts.branch,
        event: opts.event,
        actor: opts.actor,
      });
    },

    // A13 — unwraps {total_count, workflows} -> ApiActionWorkflow[].
    async repoWorkflows(owner, repo) {
      const result = await client.get<{ total_count: number; workflows: ApiActionWorkflow[] }>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/workflows`
      );
      return result.workflows;
    },

    // A14
    notifications(since) {
      return client.get<ApiNotificationThread[]>('/notifications', { since, limit: 50 });
    },

    // 002 R5
    apiSettings() {
      return client.get<ApiSettings>('/settings/api');
    },

    // 002 R9 — unwraps {total_count, jobs} -> ApiWorkflowJob[].
    async runJobs(owner, repo, runId) {
      const result = await client.get<ApiWorkflowJobsResponse>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}/jobs`,
        { limit: 50 }
      );
      return result.jobs;
    },
  };
}
