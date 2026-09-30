// Narrow TypeScript types for the Gitea v1.27.3 REST API responses.
// ONLY the fields this extension actually reads, per
// docs/specs/001-gitea-dashboard/contracts/gitea-api.md (A1-A15 + Run fields).
// Field names/types verified against docs/swagger-1.27.3.json
// (definitions: Repository, SearchResults, Issue, PullRequestMeta,
// PullRequest, PRBranchInfo, CombinedStatus, CommitStatus,
// ActionWorkflowRun, ActionWorkflowRunsResponse, ActionWorkflow,
// NotificationThread, NotificationSubject, User, Organization,
// ServerVersion). Types only, no runtime code.

// ---------------------------------------------------------------------------
// A1 GET /version
// ---------------------------------------------------------------------------

export interface ApiServerVersion {
  version: string;
}

// ---------------------------------------------------------------------------
// A2 GET /user
// ---------------------------------------------------------------------------

export interface ApiUser {
  id: number;
  login: string;
}

// ---------------------------------------------------------------------------
// A3 GET /user/orgs
// ---------------------------------------------------------------------------

export interface ApiOrganization {
  username: string;
}

// ---------------------------------------------------------------------------
// A4 GET /repos/search — SearchResults { ok, data[] }
// ---------------------------------------------------------------------------

export interface ApiRepositoryOwner {
  login: string;
}

export interface ApiRepository {
  full_name: string;
  owner: ApiRepositoryOwner;
  name: string;
  private: boolean;
  updated_at: string;
  html_url: string;
  // Absent on older Gitea versions; explicit `false` means Actions is
  // disabled for this repo (A4 ownRepos filters these out).
  has_actions?: boolean;
}

export interface ApiSearchResults {
  ok: boolean;
  data: ApiRepository[];
}

// ---------------------------------------------------------------------------
// A5-A7 GET /repos/issues/search — Issue (+ pull_request PullRequestMeta)
// ---------------------------------------------------------------------------

export interface ApiIssueUser {
  login: string;
}

export interface ApiIssueRepositoryMeta {
  full_name: string;
}

export interface ApiPullRequestMeta {
  // NOTE: swagger x-go-name is IsWorkInProgress but the JSON field is "draft".
  draft: boolean;
}

export interface ApiIssue {
  id: number;
  number: number;
  title: string;
  user: ApiIssueUser;
  updated_at: string;
  html_url: string;
  repository: ApiIssueRepositoryMeta;
  pull_request?: ApiPullRequestMeta;
}

// ---------------------------------------------------------------------------
// A8 GET /repos/{o}/{r}/pulls — PullRequest (head.sha, head.ref, mergeable, draft)
// ---------------------------------------------------------------------------

export interface ApiPrBranchInfo {
  ref: string;
  sha: string;
}

export interface ApiPullRequest {
  id: number;
  number: number;
  title: string;
  user: ApiIssueUser;
  updated_at: string;
  html_url: string;
  head: ApiPrBranchInfo;
  // Target branch (T056, FR-109: PR check runs have no head_branch).
  base: ApiPrBranchInfo;
  // Gitea sets this to null while mergeability has not been computed yet.
  mergeable: boolean | null;
  draft: boolean;
}

// ---------------------------------------------------------------------------
// A9 GET /repos/{o}/{r}/commits/{sha}/status — CombinedStatus
// ---------------------------------------------------------------------------

export type ApiCommitStatusState =
  | 'pending'
  | 'success'
  | 'error'
  | 'failure'
  | 'warning'
  | 'skipped';

export interface ApiCombinedStatus {
  state: ApiCommitStatusState;
  total_count: number;
  // Gitea returns null (not []) when there are no individual statuses.
  statuses: unknown[] | null;
}

// ---------------------------------------------------------------------------
// 002 R5 GET /settings/api — GeneralAPISettings { max_response_items, ... }
// ---------------------------------------------------------------------------

export interface ApiSettings {
  max_response_items: number;
}

// ---------------------------------------------------------------------------
// A10-A12, A15 GET .../actions/runs — ActionWorkflowRunsResponse { total_count, workflow_runs[] }
// ---------------------------------------------------------------------------

export interface ApiActionActor {
  login: string;
}

export interface ApiActionRepositoryMeta {
  full_name: string;
}

export interface ApiPullRequestMinimalHead {
  ref: string;
}

export interface ApiPullRequestMinimal {
  number: number;
  // T056: straight from the run — works even for a since-closed/merged PR
  // that's no longer in any snapshot. Absent on older Gitea versions.
  base?: ApiPullRequestMinimalHead;
}

export interface ApiActionWorkflowRun {
  id: number;
  run_attempt: number;
  run_number: number;
  status: string;
  // Absent (undefined) while the run has not completed yet.
  conclusion?: string;
  event: string;
  head_branch: string;
  head_sha: string;
  display_title: string;
  // "<file>@<ref>"
  path: string;
  actor: ApiActionActor;
  trigger_actor: ApiActionActor;
  repository: ApiActionRepositoryMeta;
  html_url: string;
  // May be an empty string / zero-time value before the run has started.
  started_at: string;
  completed_at: string;
  pull_requests: ApiPullRequestMinimal[];
}

export interface ApiActionWorkflowRunsResponse {
  total_count: number;
  workflow_runs: ApiActionWorkflowRun[];
}

// ---------------------------------------------------------------------------
// A13 GET /repos/{o}/{r}/actions/workflows — ActionWorkflow
// ---------------------------------------------------------------------------

export interface ApiActionWorkflow {
  // ID is the workflow file name (e.g. "ci.yml"), not a numeric id.
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// 002 R9 GET /repos/{o}/{r}/actions/runs/{run}/jobs — ActionWorkflowJobsResponse
// { total_count, jobs[] }, ActionWorkflowJob, ActionWorkflowStep
// ---------------------------------------------------------------------------

export interface ApiWorkflowStep {
  number: number;
  name: string;
  status: string;
  // Absent while the step has not concluded yet.
  conclusion?: string;
  // Absent/zero-time value before the step has started.
  started_at?: string;
  completed_at?: string;
}

export interface ApiWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  started_at?: string;
  completed_at?: string;
  steps: ApiWorkflowStep[];
}

export interface ApiWorkflowJobsResponse {
  total_count: number;
  jobs: ApiWorkflowJob[];
}

// ---------------------------------------------------------------------------
// A14 GET /notifications — NotificationThread / NotificationSubject
// ---------------------------------------------------------------------------

export type ApiNotificationSubjectType = 'Issue' | 'Pull' | 'Commit' | 'Repository';

export interface ApiNotificationSubject {
  type: ApiNotificationSubjectType;
  title: string;
  html_url: string;
  latest_comment_html_url: string;
}

export interface ApiNotificationRepositoryMeta {
  full_name: string;
}

export interface ApiNotificationThread {
  id: number;
  updated_at: string;
  subject: ApiNotificationSubject;
  repository: ApiNotificationRepositoryMeta;
}
