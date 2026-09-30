// Domain types for Gitea Dashboard.
// Pure types + constants + pure mappers only — no browser APIs here.
// Source of truth: docs/specs/001-gitea-dashboard/data-model.md and
// docs/specs/001-gitea-dashboard/contracts/extension-surface.md ("Словарь ошибок").

// ---------------------------------------------------------------------------
// Repo / RepoRef
// ---------------------------------------------------------------------------

export interface RepoRef {
  owner: string;
  name: string;
}

export interface Repo extends RepoRef {
  private: boolean;
  updatedAt: string;
  htmlUrl: string;
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// CI status
// ---------------------------------------------------------------------------

export type CiState =
  | 'success'
  | 'failure'
  | 'error'
  | 'pending'
  | 'warning'
  | 'skipped'
  | 'none';

export interface CiStatus {
  state: CiState;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// PullRequest
// ---------------------------------------------------------------------------

export type PrGroup = 'review' | 'mine' | 'other';

export interface PullRequest {
  id: number;
  repo: RepoRef;
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  htmlUrl: string;
  draft: boolean;
  group: PrGroup;
  headSha?: string;
  headRef?: string;
  /** Target branch (`base.ref`). Undefined for PRs merged before T056 shipped (unknown, tolerated). */
  baseRef?: string;
  mergeable?: boolean;
  ci: CiStatus;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunState =
  | 'waiting'
  | 'blocked'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped';

export const ACTIVE_RUN_STATES: readonly RunState[] = [
  'waiting',
  'blocked',
  'running',
];

export type RunGroup = 'mine' | 'others';

export interface Run {
  id: number;
  attempt: number;
  number: number;
  repo: RepoRef;
  branch: string;
  event: string;
  actor: string;
  headSha: string;
  htmlUrl: string;
  title: string;
  workflow: string;
  state: RunState;
  startedAt?: string;
  completedAt?: string;
  mine: boolean;
  group: RunGroup;
  /** T056: PR number parsed from a `refs/pull/N/head|merge` path (pull_request runs only). */
  prNumber?: number;
  /** T056: target branch, straight from the run's own `pull_requests[].base.ref` when Gitea supplies it (works for closed PRs); falls back to a PR snapshot lookup (`buildPrIndex`) otherwise. */
  baseRef?: string;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SnapshotErrorKind = 'network' | 'auth' | 'forbidden' | 'server';

export interface SnapshotError {
  kind: SnapshotErrorKind;
  at: string;
  detail?: string;
}

export interface SnapshotCounts {
  reviews: number;
  activeMine: number;
  activeOthers: number;
  failedOthers: number;
}

export interface Snapshot {
  fetchedAt: string;
  prs: PullRequest[];
  runs: Run[];
  counts: SnapshotCounts;
  redUntil?: string;
  error?: SnapshotError;
  sectionErrors?: {
    prs?: SnapshotError;
    runs?: SnapshotError;
  };
  /**
   * Per-group PR totals on the server (e.g. `X-Total-Count` from the Gitea
   * search API), distinct from `prs.length` when the results are truncated
   * (FR-072: "ещё N" link in tabs/Prs.tsx).
   */
  prTotals?: { review: number; mine: number; other: number };
  /**
   * Comment threads on my open PRs, fetched by `src/background/poller/
   * notes.ts` (T052, FR-060) when `settings.notify.comments` is on. Consumed
   * by `src/domain/notify.ts`'s `pickEvents` via `notifier.ts`'s
   * `handleCycle`, not rendered anywhere in the UI.
   */
  notes?: import('./notify').NoteInput[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type BadgeMode = 'reviews' | 'builds' | 'sum';

export type NotifyBuildFailed = 'off' | 'myPrs' | 'myPushes' | 'mine' | 'all';

export interface Settings {
  pollIntervalSec: number;
  badgeMode: BadgeMode;
  recentWindowHours: number;
  redBadgeWindowMin: number;
  showOtherPrs: boolean;
  notify: {
    buildFailed: NotifyBuildFailed;
    buildSucceededMyPr: boolean;
    reviewRequested: boolean;
    comments: boolean;
  };
  scope: {
    excludeRepos: string[];
    excludeOrgs: string[];
    includeRepos: string[];
  };
  repoModeLimit: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 60,
  badgeMode: 'reviews',
  recentWindowHours: 24,
  redBadgeWindowMin: 30,
  showOtherPrs: true,
  notify: {
    buildFailed: 'mine',
    buildSucceededMyPr: false,
    reviewRequested: true,
    comments: false,
  },
  scope: {
    excludeRepos: [],
    excludeOrgs: [],
    includeRepos: [],
  },
  repoModeLimit: 30,
};

// ---------------------------------------------------------------------------
// Instance / Capabilities / Scope
// ---------------------------------------------------------------------------

export type Scope =
  | 'read:repository'
  | 'read:issue'
  | 'read:user'
  | 'read:organization'
  | 'read:notification';

export interface Capabilities {
  actions: 'org' | 'repo' | 'unsupported' | 'forbidden';
  notifications: boolean;
  orgs: string[];
  missingScopes: Scope[];
}

export interface Instance {
  id: string;
  baseUrl: string;
  login?: string;
  userId?: number;
  serverVersion?: string;
  capabilities: Capabilities;
  checkedAt?: string;
}

// ---------------------------------------------------------------------------
// SeenEvents / PollState / UiState
// ---------------------------------------------------------------------------

export interface SeenEvents {
  initializedAt: string;
  keys: Record<string, number>;
}

export interface PollState {
  mode: 'base' | 'fast';
  backoffSec: number;
  pausedForAuth: boolean;
  lastOkAt?: string;
}

export interface UiState {
  lastTab: string;
  othersCollapsed: boolean;
  /** 002 data-model.md "UiState (расширение)": last section opened on the dashboard page. */
  lastPageSection?: 'repos' | 'prs' | 'builds';
  /** 002 rev.2 (T037, FR-116): dashboard page sidebar open/collapsed state. */
  sidebarOpen?: boolean;
  /** 002 rev.2 (T042): history stats panel (cards + "По workflow") open/collapsed, default collapsed. */
  historyStatsOpen?: boolean;
  /** 002 rev.4 (T045, FR-120): rows per page for the PR and history tables (25/50/100). */
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Error dictionary (contracts/extension-surface.md "Словарь ошибок")
// ---------------------------------------------------------------------------

export type ApiErrorKind =
  | 'unreachable'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'server'
  | 'not-json';

export type ConnectionKind =
  | 'bad-url'
  | 'unreachable'
  | 'auth'
  | 'scope'
  | 'not-gitea';

export interface ConnectionReport {
  ok: boolean;
  kind?: ConnectionKind;
  login?: string;
  version?: string;
  actions: Capabilities['actions'];
  missingScopes: string[];
  messageKey: string;
}

/**
 * Maps a client-level ApiError.kind to Snapshot.error.kind, per the
 * "Словарь ошибок" table in contracts/extension-surface.md:
 * unreachable -> network, not-json -> server, not-found -> server,
 * everything else passes through unchanged (auth, forbidden, server).
 */
export function toSnapshotErrorKind(kind: ApiErrorKind): SnapshotErrorKind {
  switch (kind) {
    case 'unreachable':
      return 'network';
    case 'not-json':
      return 'server';
    case 'not-found':
      return 'server';
    case 'auth':
      return 'auth';
    case 'forbidden':
      return 'forbidden';
    case 'server':
      return 'server';
  }
}

/**
 * Maps a client-level ApiError.kind to ConnectionReport.kind, per the
 * "Словарь ошибок" table in contracts/extension-surface.md:
 * forbidden -> scope, not-json -> not-gitea, not-found -> not-gitea,
 * server -> unreachable; unreachable/auth pass through. (bad-url is reserved
 * for pre-request URL validation, which happens before an ApiErrorKind
 * exists.)
 */
export function toConnectionKind(kind: ApiErrorKind): ConnectionKind {
  switch (kind) {
    case 'forbidden':
      return 'scope';
    case 'not-json':
      return 'not-gitea';
    case 'not-found':
      return 'not-gitea';
    case 'unreachable':
      return 'unreachable';
    case 'auth':
      return 'auth';
    case 'server':
      return 'unreachable';
  }
}
