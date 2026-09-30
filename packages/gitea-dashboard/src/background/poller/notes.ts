// Poll Section: comment/review threads on my open PRs (US5, FR-060).
// Source of truth: docs/specs/001-gitea-dashboard/contracts/gitea-api.md A14
// (`/notifications?since=&limit=50`; `subject.{type,html_url,
// latest_comment_html_url}`, `repository.full_name`), data-model.md
// "Уведомление", spec.md FR-060 (off by default).
//
// Gated by `settings.notify.comments` (off by default) AND
// `instance.capabilities.notifications !== false` — a 403 from A14 (no
// `read:notification` scope) persists `capabilities.notifications = false`
// (mirrors `runs.ts`'s `capabilities.actions` fallback on a 403) and returns
// `{}` without throwing: this section has no dedicated `Snapshot.
// sectionErrors` slot (unlike `prs`/`runs`), so a 403 here must never be
// cycle-fatal or surface as an outage. Any other `ApiError` is left to
// propagate to `poller/index.ts`'s generic per-section handling.
//
// `since` comes from this section's own cursor (`notesCursor:<instanceId>`,
// T069 M2) — NOT `prev.fetchedAt`, which advances every cycle regardless of
// whether `notes` ran (a fast cycle skips this section entirely; see
// `poller/index.ts`'s `mode === 'fast' && !section.fast` gate) or errored,
// and would silently drop comments landing in the gap. The cursor only
// advances to this cycle's `now` after a successful A14 response; on a 403
// (capability off) or any other error it is left untouched so the next
// cycle re-requests from the same `since`. On the very first cycle (no
// cursor yet) `since = now - recentWindowHours`.
//
// Only `subject.type === 'Pull'` threads on a PR in `ctx.merged.prs`'s
// `mine` group (this cycle's PRs, falling back to `prev.prs` the same way
// `runs.ts` does) are kept; everything else (issues, other people's PRs) is
// dropped before it ever reaches `pickEvents`.

import { ApiError } from '../../api/client';
import { createEndpoints } from '../../api/endpoints';
import type { ApiNotificationThread } from '../../api/types';
import type { NoteInput } from '../../domain/notify';
import type { Capabilities, PullRequest, Snapshot } from '../../domain/types';
import * as storage from '../../lib/storage';
import type { Section, SectionContext } from './index';

function prKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`;
}

/** "owner/repo#number" -> the matching `PullRequest` for every PR of mine. */
function buildMyOpenPrs(prs: PullRequest[]): Map<string, PullRequest> {
  const map = new Map<string, PullRequest>();
  for (const pr of prs) {
    if (pr.group !== 'mine') continue;
    map.set(prKey(pr.repo.owner, pr.repo.name, pr.number), pr);
  }
  return map;
}

/** Extracts the trailing `/pulls/<number>` from `subject.html_url`. */
function prNumberFromHtmlUrl(htmlUrl: string): number | undefined {
  const match = /\/pulls\/(\d+)(?:$|[/?#])/.exec(htmlUrl);
  if (!match?.[1]) return undefined;
  const n = Number(match[1]);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Persists a `capabilities` patch (L6 fix, mirrors `poller/runs.ts`):
 * re-reads `instances` right before writing and merges the patch onto
 * whatever is currently stored, so a concurrent write to another field
 * (e.g. `runs.ts`'s own `capabilities.actions`/`orgs` downgrade landing
 * mid-cycle) is preserved instead of clobbered by this section's
 * now-stale copy of the rest of `capabilities`.
 */
async function persistCapabilities(
  instanceId: string,
  patch: Partial<Capabilities>
): Promise<void> {
  const state = await storage.getInstances();
  const instances = state.instances.map((instance) =>
    instance.id === instanceId
      ? { ...instance, capabilities: { ...instance.capabilities, ...patch } }
      : instance
  );
  await storage.setInstances({ ...state, instances });
}

function toNote(thread: ApiNotificationThread, pr: PullRequest): NoteInput {
  return {
    threadId: String(thread.id),
    prId: pr.id,
    title: thread.subject.title,
    url: thread.subject.latest_comment_html_url || thread.subject.html_url,
    updatedAt: thread.updated_at,
  };
}

export const notesSection: Section = {
  name: 'notes',
  async run(ctx: SectionContext): Promise<Partial<Snapshot>> {
    const { instance, settings, client, prev, now } = ctx;

    if (!settings.notify.comments || instance.capabilities.notifications === false) {
      return {};
    }

    const endpoints = createEndpoints(client);
    const cursor = await storage.getNotesCursor(instance.id);
    const since =
      cursor ??
      new Date(now.getTime() - settings.recentWindowHours * 60 * 60 * 1000).toISOString();

    let threads: ApiNotificationThread[];
    try {
      threads = await endpoints.notifications(since);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'forbidden') {
        await persistCapabilities(instance.id, { notifications: false });
        return {};
      }
      // Any other error (e.g. a 500): leave the cursor untouched so the
      // next cycle re-requests from the same `since` instead of losing the
      // window.
      throw err;
    }

    // Only advance the cursor after a successful A14 response.
    await storage.setNotesCursor(instance.id, now.toISOString());

    const myOpenPrs = buildMyOpenPrs(ctx.merged.prs ?? prev?.prs ?? []);
    const notes: NoteInput[] = [];
    for (const thread of threads) {
      if (thread.subject.type !== 'Pull') continue;
      const number = prNumberFromHtmlUrl(thread.subject.html_url);
      if (number === undefined) continue;
      const parts = thread.repository.full_name.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      const pr = myOpenPrs.get(prKey(parts[0], parts[1], number));
      if (!pr) continue;
      notes.push(toNote(thread, pr));
    }

    return { notes };
  },
};
