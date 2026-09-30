// Build the list of Actions run sources to poll for a given cycle.
// Source of truth: docs/specs/001-gitea-dashboard/research.md R1/R4/R10,
// docs/specs/001-gitea-dashboard/data-model.md Capabilities/Settings,
// spec.md FR-034/FR-035.
//
// No browser APIs here — only pure functions over domain types.

import type { Capabilities, RepoRef, Settings } from './types';

export type RunSource =
  | { kind: 'orgActive'; org: string }
  | { kind: 'orgRecent'; org: string }
  | { kind: 'orgMine'; org: string }
  | { kind: 'repo'; owner: string; repo: string; limit: number };

export interface RunSourcesInput {
  caps: Capabilities;
  settings: Settings;
  /** Organizations the signed-in user is a member of. */
  orgs: string[];
  /** Pinned repos (across all orgs and outside them). */
  pins: RepoRef[];
  /** The signed-in user's own repos with Actions enabled. */
  ownRepos: RepoRef[];
  /**
   * Repo-fallback candidates: repos where the user had a PR or a build in
   * the last 7 days (FR-034 fallback scope), used only when
   * `caps.actions === 'repo'`.
   */
  recentMine: RepoRef[];
  /** `page-fast` (T043): only `orgActive` per org, nothing else. */
  mode: 'base' | 'fast' | 'page-fast';
}

export interface RunSourcesResult {
  sources: RunSource[];
  overLimit: boolean;
}

function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}

function parseRepoKey(key: string): RepoRef {
  const slash = key.indexOf('/');
  if (slash === -1) {
    return { owner: key, name: '' };
  }
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}

export function runSources(input: RunSourcesInput): RunSourcesResult {
  const { caps, settings, orgs, pins, ownRepos, recentMine, mode } = input;
  const excludeOrgs = new Set(settings.scope.excludeOrgs);
  const excludeRepos = new Set(settings.scope.excludeRepos);

  if (caps.actions === 'unsupported' || caps.actions === 'forbidden') {
    return { sources: [], overLimit: false };
  }

  if (mode === 'page-fast' && caps.actions !== 'org') {
    return { sources: [], overLimit: false };
  }

  if (caps.actions === 'repo') {
    const includeRepos = settings.scope.includeRepos.map(parseRepoKey);
    const seen = new Set<string>();
    const candidates: RepoRef[] = [];
    for (const r of [...pins, ...recentMine, ...includeRepos]) {
      const key = repoKey(r);
      if (excludeRepos.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(r);
    }

    const limit = settings.repoModeLimit;
    const overLimit = candidates.length > limit;
    const truncated = candidates.slice(0, limit);
    const sources: RunSource[] = truncated.map((r) => ({
      kind: 'repo',
      owner: r.owner,
      repo: r.name,
      limit: 20,
    }));
    return { sources, overLimit };
  }

  // caps.actions === 'org'
  const activeOrgs = orgs.filter((org) => !excludeOrgs.has(org));
  const activeOrgSet = new Set(activeOrgs);
  const sources: RunSource[] = [];

  for (const org of activeOrgs) {
    sources.push({ kind: 'orgActive', org });
    if (mode === 'base') {
      sources.push({ kind: 'orgRecent', org });
    }
    if (mode !== 'page-fast') {
      sources.push({ kind: 'orgMine', org });
    }
  }

  if (mode === 'page-fast') {
    return { sources, overLimit: false };
  }

  const seenRepos = new Set<string>();

  // Pinned repos always get their own source, even when their org is
  // already covered by an org-wide source: a flood of others' runs on the
  // org page must not push a pinned repo's own runs off it (research R4).
  function addPinnedRepoSource(r: RepoRef, limit: number): void {
    const key = repoKey(r);
    if (excludeRepos.has(key) || seenRepos.has(key)) {
      return;
    }
    seenRepos.add(key);
    sources.push({ kind: 'repo', owner: r.owner, repo: r.name, limit });
  }

  // includeRepos/ownRepos are extra org-cycle coverage, not pin protection —
  // skip them when the org already covers that owner.
  function addExtraRepoSource(r: RepoRef, limit: number): void {
    const key = repoKey(r);
    if (excludeRepos.has(key) || seenRepos.has(key) || activeOrgSet.has(r.owner)) {
      return;
    }
    seenRepos.add(key);
    sources.push({ kind: 'repo', owner: r.owner, repo: r.name, limit });
  }

  for (const p of pins) {
    addPinnedRepoSource(p, 10);
  }

  if (mode === 'base') {
    for (const raw of settings.scope.includeRepos) {
      addExtraRepoSource(parseRepoKey(raw), 10);
    }
    for (const r of ownRepos) {
      addExtraRepoSource(r, 10);
    }
  }

  return { sources, overLimit: false };
}
