// Pure domain functions for the "Репо" tab (US2, FR-010..015).
// No browser APIs here — pin persistence itself is done by the caller via
// src/lib/storage.ts (getPins/setPins); this module only computes the next
// pins array and other pure view data.

import type { ApiRepository } from '../api/types';
import type { Repo, RepoRef } from './types';

export type RepoUrlMode = 'open' | 'pulls' | 'actions';

function refKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`.toLowerCase();
}

function refEquals(a: RepoRef, b: RepoRef): boolean {
  return refKey(a) === refKey(b);
}

function apiRepoKey(repo: ApiRepository): string {
  return `${repo.owner.login}/${repo.name}`.toLowerCase();
}

function toRepo(api: ApiRepository, pinned: boolean): Repo {
  return {
    owner: api.owner.login,
    name: api.name,
    private: api.private,
    updatedAt: api.updated_at,
    htmlUrl: api.html_url,
    pinned,
  };
}

/** A pinned ref with no matching search result yet (e.g. not in the current page). */
function toPlaceholderRepo(ref: RepoRef): Repo {
  return {
    owner: ref.owner,
    name: ref.name,
    private: false,
    updatedAt: '',
    htmlUrl: '',
    pinned: true,
  };
}

/**
 * Merges pinned repos (always first, deduplicated) with search/list results
 * (sorted by `updated_at` descending), per FR-011.
 */
export function mergeRepoList(
  pins: readonly RepoRef[],
  results: readonly ApiRepository[]
): Repo[] {
  const seen = new Set<string>();
  const pinned: Repo[] = [];

  for (const pin of pins) {
    const key = refKey(pin);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = results.find((r) => apiRepoKey(r) === key);
    pinned.push(match ? toRepo(match, true) : toPlaceholderRepo(pin));
  }

  const rest = results
    .filter((r) => !seen.has(apiRepoKey(r)))
    .map((r) => toRepo(r, false))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return [...pinned, ...rest];
}

/**
 * Builds the destination URL for a repo action, per FR-013:
 * `open` -> the repo page, `pulls` -> its pull requests, `actions` -> its runs.
 */
export function repoUrl(repo: Repo, mode: RepoUrlMode): string {
  const base = repo.htmlUrl.replace(/\/+$/, '');
  switch (mode) {
    case 'open':
      return base;
    case 'pulls':
      return `${base}/pulls`;
    case 'actions':
      return `${base}/actions`;
  }
}

/**
 * Returns the next pins array with `ref` toggled: removed if already present
 * (case-insensitive match on owner/name), added otherwise (FR-014). Pure —
 * does not touch storage; the caller persists the result via setPins().
 */
export function togglePin(pins: readonly RepoRef[], ref: RepoRef): RepoRef[] {
  const exists = pins.some((p) => refEquals(p, ref));
  if (exists) {
    return pins.filter((p) => !refEquals(p, ref));
  }
  return [...pins, ref];
}

export interface OmniboxSuggestion {
  content: string;
  description: string;
}

const MAX_SUGGESTIONS = 6;

/**
 * Builds omnibox suggestions (FR-015): pinned repos first, then search
 * results, deduplicated, filtered case-insensitively against `query` on
 * `owner/name`, capped at 6.
 */
export function omniboxSuggestions(
  query: string,
  pins: readonly RepoRef[],
  results: readonly ApiRepository[]
): OmniboxSuggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const suggestions: OmniboxSuggestion[] = [];

  function tryAdd(key: string, content: string): void {
    if (suggestions.length >= MAX_SUGGESTIONS) return;
    if (seen.has(key)) return;
    if (q && !key.includes(q)) return;
    seen.add(key);
    suggestions.push({ content, description: key });
  }

  for (const pin of pins) {
    tryAdd(refKey(pin), refKey(pin));
  }
  for (const result of results) {
    tryAdd(apiRepoKey(result), result.html_url);
  }

  return suggestions;
}
