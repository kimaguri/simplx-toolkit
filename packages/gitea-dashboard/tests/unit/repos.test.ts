// T027 [US2] — pure domain functions for the Repos tab.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-010..014.
import { describe, expect, it } from 'vitest';
import type { ApiRepository } from '../../src/api/types';
import type { Repo, RepoRef } from '../../src/domain/types';
import {
  mergeRepoList,
  omniboxSuggestions,
  repoUrl,
  togglePin,
} from '../../src/domain/repos';

function apiRepo(
  overrides: Omit<Partial<ApiRepository>, 'owner' | 'name'> & { owner: string; name: string }
): ApiRepository {
  const { owner, name, ...rest } = overrides;
  return {
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    name,
    private: false,
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://git.example.test/${owner}/${name}`,
    ...rest,
  };
}

describe('mergeRepoList', () => {
  it('puts pinned repos first, without duplicates, then the rest sorted by updated_at desc', () => {
    const pins: RepoRef[] = [{ owner: 'acme', name: 'core' }];
    const results = [
      apiRepo({ owner: 'acme', name: 'platform', updated_at: '2026-01-03T00:00:00Z' }),
      apiRepo({ owner: 'acme', name: 'core', updated_at: '2026-01-01T00:00:00Z' }),
      apiRepo({ owner: 'umbrella', name: 'web', updated_at: '2026-01-05T00:00:00Z' }),
    ];

    const merged = mergeRepoList(pins, results);

    expect(merged.map((r) => `${r.owner}/${r.name}`)).toEqual([
      'acme/core',
      'umbrella/web',
      'acme/platform',
    ]);
    expect(merged[0]?.pinned).toBe(true);
    expect(merged[1]?.pinned).toBe(false);
  });

  it('does not duplicate a pinned repo that also appears in results', () => {
    const pins: RepoRef[] = [{ owner: 'acme', name: 'core' }];
    const results = [apiRepo({ owner: 'acme', name: 'core' })];

    const merged = mergeRepoList(pins, results);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.pinned).toBe(true);
  });

  it('keeps a pinned repo even when it is absent from results', () => {
    const pins: RepoRef[] = [{ owner: 'acme', name: 'missing' }];

    const merged = mergeRepoList(pins, []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ owner: 'acme', name: 'missing', pinned: true });
  });
});

describe('repoUrl', () => {
  const repo: Repo = {
    owner: 'acme',
    name: 'core',
    private: false,
    updatedAt: '2026-01-01T00:00:00Z',
    htmlUrl: 'https://git.example.test/acme/core',
    pinned: false,
  };

  it('returns the repo html_url for "open"', () => {
    expect(repoUrl(repo, 'open')).toBe('https://git.example.test/acme/core');
  });

  it('appends /pulls for "pulls"', () => {
    expect(repoUrl(repo, 'pulls')).toBe('https://git.example.test/acme/core/pulls');
  });

  it('appends /actions for "actions"', () => {
    expect(repoUrl(repo, 'actions')).toBe('https://git.example.test/acme/core/actions');
  });

  it('strips a trailing slash from html_url before appending', () => {
    const trailing: Repo = { ...repo, htmlUrl: 'https://git.example.test/acme/core/' };
    expect(repoUrl(trailing, 'pulls')).toBe('https://git.example.test/acme/core/pulls');
  });
});

describe('togglePin', () => {
  it('adds a ref that is not yet pinned', () => {
    const pins: RepoRef[] = [];
    const next = togglePin(pins, { owner: 'acme', name: 'core' });
    expect(next).toEqual([{ owner: 'acme', name: 'core' }]);
  });

  it('removes a ref that is already pinned', () => {
    const pins: RepoRef[] = [{ owner: 'acme', name: 'core' }];
    const next = togglePin(pins, { owner: 'acme', name: 'core' });
    expect(next).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const pins: RepoRef[] = [{ owner: 'acme', name: 'core' }];
    togglePin(pins, { owner: 'acme', name: 'platform' });
    expect(pins).toEqual([{ owner: 'acme', name: 'core' }]);
  });
});

describe('omniboxSuggestions', () => {
  const pins: RepoRef[] = [{ owner: 'acme', name: 'core' }];
  const results = [
    apiRepo({ owner: 'acme', name: 'core' }),
    apiRepo({ owner: 'acme', name: 'platform' }),
    apiRepo({ owner: 'umbrella', name: 'web' }),
  ];

  it('returns at most 6 suggestions', () => {
    const many = Array.from({ length: 20 }, (_, i) => apiRepo({ owner: 'acme', name: `repo${i}` }));
    const suggestions = omniboxSuggestions('repo', [], many);
    expect(suggestions.length).toBeLessThanOrEqual(6);
  });

  it('matches pins case-insensitively against the query', () => {
    const suggestions = omniboxSuggestions('ACME/CORE', pins, []);
    expect(suggestions.some((s) => s.description.toLowerCase() === 'acme/core')).toBe(true);
  });

  it('filters results by query (case-insensitive), matching owner/name', () => {
    const suggestions = omniboxSuggestions('umbrella', pins, results);
    expect(suggestions.map((s) => s.description)).toEqual(['umbrella/web']);
  });

  it('does not duplicate an entry that is both pinned and in results', () => {
    const suggestions = omniboxSuggestions('acme/core', pins, results);
    expect(suggestions.filter((s) => s.description === 'acme/core')).toHaveLength(1);
  });

  it('returns everything (up to 6) for an empty query', () => {
    const suggestions = omniboxSuggestions('', pins, results);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(6);
  });
});
