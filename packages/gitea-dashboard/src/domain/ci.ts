// CI status mapping. Pure, no browser APIs.
// Source of truth: docs/specs/001-gitea-dashboard/data-model.md "CiStatus",
// research.md R7 ("total_count==0 => none, because the empty response reports
// state:'pending'"), spec.md FR-022.

import type { ApiCombinedStatus } from '../api/types';
import type { CiStatus } from './types';

/**
 * Maps a Gitea combined-status response to a domain CiStatus.
 *
 * Gitea's combined-status endpoint reports `state:"pending"` for a commit
 * with zero statuses (status.go L55-61) — that quirk MUST be read as "no
 * checks" (`none`), not as "checks in progress" (`pending`). Every other
 * state passes through unchanged.
 */
export function toCiStatus(status: ApiCombinedStatus, now: string): CiStatus {
  const state = status.total_count === 0 ? 'none' : status.state;
  return { state, fetchedAt: now };
}

/**
 * A CiStatus is final (won't change on its own) unless it is still `pending`
 * with outstanding statuses — per FR-022, final statuses are not
 * re-requested.
 */
export function isFinal(status: CiStatus): boolean {
  return status.state !== 'pending';
}
