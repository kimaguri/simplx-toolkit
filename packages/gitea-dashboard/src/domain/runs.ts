// Gitea Actions run list — pure mapping/merging logic.
// Source of truth: docs/specs/001-gitea-dashboard/data-model.md "Run"/"RunState",
// docs/specs/001-gitea-dashboard/research.md R4-R6, spec.md FR-030..032.
//
// No browser APIs here — only pure functions over API/domain types.

import type { ApiActionWorkflowRun } from '../api/types';
import { ACTIVE_RUN_STATES, type Run, type RunGroup, type RunState } from './types';

// ---------------------------------------------------------------------------
// RunState mapping (research R4)
// ---------------------------------------------------------------------------

/**
 * Maps Gitea's `status`/`conclusion` pair to the domain `RunState`.
 * `completed` without a `conclusion` field (Gitea's "unknown"/cancelling
 * edge case) is treated as `cancelled`, per research.md R4.
 */
export function toRunState(status: string, conclusion?: string): RunState {
  switch (status) {
    case 'queued':
      return 'waiting';
    case 'waiting':
      return 'blocked';
    case 'in_progress':
      return 'running';
    case 'completed':
      switch (conclusion) {
        case 'success':
          return 'success';
        case 'failure':
          return 'failure';
        case 'cancelled':
          return 'cancelled';
        case 'skipped':
          return 'skipped';
        default:
          return 'cancelled';
      }
    default:
      return 'cancelled';
  }
}

// ---------------------------------------------------------------------------
// toRun (research R5-R6)
// ---------------------------------------------------------------------------

export interface RunContext {
  /** The signed-in user's login. */
  me: string;
  /** "owner/repo" -> set of the user's own open PR numbers in that repo. */
  myOpenPrs: Map<string, Set<number>>;
  /** "owner/repo" of pinned repos. */
  pinned: Set<string>;
  /** "owner/repo" -> workflow file name -> human workflow name (from cache). */
  workflowNames: Map<string, Map<string, string>>;
}

function parseRepoFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/');
  if (slash === -1) {
    return { owner: fullName, name: '' };
  }
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** `"<file>@<ref>"` -> `"<file>"` (research R5). */
function workflowFileFromPath(path: string | undefined): string {
  if (!path) return '';
  const at = path.indexOf('@');
  return at === -1 ? path : path.slice(0, at);
}

/**
 * Gitea leaves `head_branch` empty for tag/scheduled runs; the ref survives
 * in `path` (`file@refs/tags/v1.2.3`) — keep the short branch/tag name.
 * Pull refs (`refs/pull/N/head`) stay empty.
 */
function refNameFromPath(path: string | undefined): string {
  if (!path) return '';
  const at = path.indexOf('@');
  if (at === -1) return '';
  const m = /^refs\/(?:tags|heads)\/(.+)$/.exec(path.slice(at + 1));
  return m?.[1] ?? '';
}

/**
 * T056: PR check runs carry the PR number in `path`
 * (`pr.yml@refs/pull/81/head` or `.../merge`), since `head_branch` is empty
 * and Gitea's `pull_requests` array is only populated for some events. A
 * `pr-cleanup.yml@<40-hex sha>` path (no PR number) yields `undefined` — the
 * branch column then falls back to "—" instead of a PR link.
 */
function prNumberFromPath(path: string | undefined): number | undefined {
  if (!path) return undefined;
  const at = path.indexOf('@');
  if (at === -1) return undefined;
  const m = /^refs\/pull\/(\d+)\/(?:head|merge)$/.exec(path.slice(at + 1));
  return m ? Number(m[1]) : undefined;
}

/**
 * T056: `prNumber`/`baseRef` for a PR check run. `pull_requests[].base.ref`
 * (Gitea's ActionWorkflowRun payload) is preferred when present — it comes
 * straight from the run and still works once the PR itself has been closed
 * (a snapshot lookup wouldn't find it then); `path`'s `refs/pull/N/head`
 * covers `prNumber` on Gitea versions/events where `pull_requests` is empty,
 * leaving `baseRef` for a snapshot lookup (`buildPrIndex`) to fill in later.
 */
function prInfoFromApi(api: ApiActionWorkflowRun): { prNumber?: number; baseRef?: string } {
  const prNumber = prNumberFromPath(api.path);
  if (prNumber === undefined) return {};
  // `pull_requests` isn't gated to PR-triggered runs alone (research R6: it's
  // also used to detect "runs on one of my open PRs" for push/other events),
  // so only trust it here once `path` itself confirms this is a PR run.
  const match = api.pull_requests.find((pr) => pr.number === prNumber);
  return { prNumber, baseRef: match?.base?.ref };
}

/**
 * T055: Gitea serializes a zero TimeStamp (a run that never started, or
 * hasn't finished) as the Unix epoch in the server's zone
 * (`1970-01-01T05:00:00+05:00`), some versions as `0001-01-01T00:00:00Z`.
 * Such a value is "no time", not a real date — anything before 2000 is
 * dropped to `undefined` (it used to make the history loader think a
 * source already reached back to 1970 and stop paging after page 1).
 */
const MIN_REAL_TIME_MS = Date.UTC(2000, 0, 1);

export function realTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= MIN_REAL_TIME_MS ? value : undefined;
}

export function toRun(api: ApiActionWorkflowRun, ctx: RunContext): Run {
  const repoFullName = api.repository.full_name;
  const repo = parseRepoFullName(repoFullName);
  const file = workflowFileFromPath(api.path);
  const workflow = ctx.workflowNames.get(repoFullName)?.get(file) ?? file;
  const state = toRunState(api.status, api.conclusion);

  const myPrs = ctx.myOpenPrs.get(repoFullName);
  const mine =
    api.actor.login === ctx.me ||
    api.trigger_actor.login === ctx.me ||
    api.pull_requests.some((pr) => myPrs?.has(pr.number) ?? false);

  const group: RunGroup = mine || ctx.pinned.has(repoFullName) ? 'mine' : 'others';

  return {
    id: api.id,
    attempt: api.run_attempt,
    number: api.run_number,
    repo,
    branch: api.head_branch || refNameFromPath(api.path),
    event: api.event ?? '',
    actor: api.actor?.login ?? '',
    headSha: api.head_sha,
    htmlUrl: api.html_url,
    title: api.display_title ?? '',
    workflow,
    state,
    startedAt: realTimestamp(api.started_at),
    completedAt: realTimestamp(api.completed_at),
    mine,
    group,
    ...prInfoFromApi(api),
  };
}

// ---------------------------------------------------------------------------
// buildRunList: merge sources, dedupe, drop stale completed, sort.
// ---------------------------------------------------------------------------

function isActive(state: RunState): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(state);
}

/**
 * Merges multiple raw API run lists (e.g. active/recent/mine/per-repo
 * sources), deduplicates by `id` keeping the highest `run_attempt`, drops
 * completed runs older than `recentWindowHours` (active runs are always
 * kept regardless of age), and sorts active runs first, then by
 * `startedAt` descending.
 */
export function buildRunList(
  sources: ApiActionWorkflowRun[][],
  ctx: RunContext,
  now: string,
  recentWindowHours: number
): Run[] {
  const byId = new Map<number, ApiActionWorkflowRun>();
  for (const list of sources) {
    for (const api of list) {
      const existing = byId.get(api.id);
      if (!existing || api.run_attempt > existing.run_attempt) {
        byId.set(api.id, api);
      }
    }
  }

  const nowMs = new Date(now).getTime();
  const windowMs = recentWindowHours * 60 * 60 * 1000;

  const runs = Array.from(byId.values())
    .map((api) => toRun(api, ctx))
    .filter((run) => {
      if (isActive(run.state)) {
        return true;
      }
      if (!run.completedAt) {
        return true;
      }
      const completedMs = new Date(run.completedAt).getTime();
      return nowMs - completedMs <= windowMs;
    });

  runs.sort((a, b) => {
    const aActive = isActive(a.state);
    const bActive = isActive(b.state);
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    // T057: an active (waiting/blocked/running) run with no `startedAt` yet
    // is current, not oldest — it must sort at the top of the active group,
    // not sink to the bottom the way `0` (epoch) used to. A non-active run
    // with no time (e.g. cancelled before it started) still sorts last.
    const aStarted = a.startedAt ? new Date(a.startedAt).getTime() : aActive ? Number.POSITIVE_INFINITY : 0;
    const bStarted = b.startedAt ? new Date(b.startedAt).getTime() : bActive ? Number.POSITIVE_INFINITY : 0;
    return aStarted === bStarted ? b.id - a.id : bStarted - aStarted;
  });

  return runs;
}

// ---------------------------------------------------------------------------
// runCounts
// ---------------------------------------------------------------------------

export interface RunCounts {
  activeMine: number;
  activeOthers: number;
  failedOthers: number;
}

export function runCounts(runs: Run[]): RunCounts {
  let activeMine = 0;
  let activeOthers = 0;
  let failedOthers = 0;

  for (const run of runs) {
    const active = isActive(run.state);
    if (run.group === 'mine') {
      if (active) {
        activeMine += 1;
      }
    } else if (active) {
      activeOthers += 1;
    } else if (run.state === 'failure') {
      failedOthers += 1;
    }
  }

  return { activeMine, activeOthers, failedOthers };
}
