// Contract: docs/specs/001-gitea-dashboard/research.md R1/R10, data-model.md
// Capabilities/Settings, spec.md FR-034/FR-035.
import { describe, expect, it } from 'vitest';
import { runSources } from '../../src/domain/scope';
import { DEFAULT_SETTINGS, type Capabilities, type RepoRef, type Settings } from '../../src/domain/types';

function caps(actions: Capabilities['actions'], orgs: string[] = []): Capabilities {
  return { actions, notifications: false, orgs, missingScopes: [] };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope },
  };
}

function repo(full: string): RepoRef {
  const [owner, name] = full.split('/');
  return { owner: owner ?? '', name: name ?? '' };
}

describe('runSources — org mode', () => {
  it('emits active+recent+mine sources for every org, minus excludeOrgs', () => {
    const result = runSources({
      caps: caps('org', ['acme', 'umbrella']),
      settings: settings({ scope: { ...DEFAULT_SETTINGS.scope, excludeOrgs: ['umbrella'] } }),
      orgs: ['acme', 'umbrella'],
      pins: [],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toEqual([
      { kind: 'orgActive', org: 'acme' },
      { kind: 'orgRecent', org: 'acme' },
      { kind: 'orgMine', org: 'acme' },
    ]);
    expect(result.overLimit).toBe(false);
  });

  it('adds a repo source for a pinned repo outside every org', () => {
    const result = runSources({
      caps: caps('org', ['acme']),
      settings: settings(),
      orgs: ['acme'],
      pins: [repo('me/dotfiles')],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toContainEqual({
      kind: 'repo',
      owner: 'me',
      repo: 'dotfiles',
      limit: 10,
    });
  });

  it('adds a repo source for a pinned repo even when its org is already covered (R4: floods must not push pinned runs off the org page)', () => {
    const result = runSources({
      caps: caps('org', ['acme']),
      settings: settings(),
      orgs: ['acme'],
      pins: [repo('acme/platform')],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toContainEqual({
      kind: 'repo',
      owner: 'acme',
      repo: 'platform',
      limit: 10,
    });
  });

  it('adds includeRepos and ownRepos as repo sources in base mode', () => {
    const result = runSources({
      caps: caps('org', []),
      settings: settings({ scope: { ...DEFAULT_SETTINGS.scope, includeRepos: ['other/tool'] } }),
      orgs: [],
      pins: [],
      ownRepos: [repo('me/dotfiles')],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toContainEqual({ kind: 'repo', owner: 'other', repo: 'tool', limit: 10 });
    expect(result.sources).toContainEqual({ kind: 'repo', owner: 'me', repo: 'dotfiles', limit: 10 });
  });

  it('excludeRepos filters pinned/include/own repo sources', () => {
    const result = runSources({
      caps: caps('org', []),
      settings: settings({
        scope: { ...DEFAULT_SETTINGS.scope, excludeRepos: ['me/dotfiles', 'other/tool'] },
      }),
      orgs: [],
      pins: [repo('me/dotfiles')],
      ownRepos: [repo('me/dotfiles')],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources.some((s) => s.kind === 'repo' && s.owner === 'other' && s.repo === 'tool')).toBe(false);
    expect(result.sources.some((s) => s.kind === 'repo' && s.owner === 'me' && s.repo === 'dotfiles')).toBe(false);
  });

  it('excludeRepos filters out includeRepos too', () => {
    const result = runSources({
      caps: caps('org', []),
      settings: settings({ scope: { ...DEFAULT_SETTINGS.scope, excludeRepos: ['other/tool'], includeRepos: ['other/tool'] } }),
      orgs: [],
      pins: [],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toEqual([]);
  });

  it('fast mode only emits active+mine per org plus every pinned repo, incl. inside the org (no recent/own/include)', () => {
    const result = runSources({
      caps: caps('org', ['acme']),
      settings: settings({ scope: { ...DEFAULT_SETTINGS.scope, includeRepos: ['other/tool'] } }),
      orgs: ['acme'],
      pins: [repo('me/dotfiles'), repo('acme/platform')],
      ownRepos: [repo('me/side-project')],
      recentMine: [],
      mode: 'fast',
    });

    expect(result.sources).toEqual([
      { kind: 'orgActive', org: 'acme' },
      { kind: 'orgMine', org: 'acme' },
      { kind: 'repo', owner: 'me', repo: 'dotfiles', limit: 10 },
      { kind: 'repo', owner: 'acme', repo: 'platform', limit: 10 },
    ]);
  });
});

describe('runSources — repo fallback mode', () => {
  it('builds repo sources from pinned + recentMine, deduplicated', () => {
    const result = runSources({
      caps: caps('repo'),
      settings: settings(),
      orgs: ['acme'],
      pins: [repo('acme/platform')],
      ownRepos: [],
      recentMine: [repo('acme/platform'), repo('acme/core')],
      mode: 'base',
    });

    expect(result.sources).toEqual([
      { kind: 'repo', owner: 'acme', repo: 'platform', limit: 20 },
      { kind: 'repo', owner: 'acme', repo: 'core', limit: 20 },
    ]);
    expect(result.overLimit).toBe(false);
  });

  it('truncates to repoModeLimit and sets overLimit', () => {
    const many = Array.from({ length: 5 }, (_, i) => repo(`acme/repo${i}`));
    const result = runSources({
      caps: caps('repo'),
      settings: settings({ repoModeLimit: 3 }),
      orgs: [],
      pins: many,
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toHaveLength(3);
    expect(result.overLimit).toBe(true);
  });

  it('excludeRepos filters candidates before truncation', () => {
    const result = runSources({
      caps: caps('repo'),
      settings: settings({ scope: { ...DEFAULT_SETTINGS.scope, excludeRepos: ['acme/core'] } }),
      orgs: [],
      pins: [repo('acme/platform'), repo('acme/core')],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources).toEqual([{ kind: 'repo', owner: 'acme', repo: 'platform', limit: 20 }]);
  });

  it('ignores org caps.orgs entirely (no orgActive/orgRecent/orgMine sources)', () => {
    const result = runSources({
      caps: caps('repo'),
      settings: settings(),
      orgs: ['acme'],
      pins: [repo('acme/platform')],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });

    expect(result.sources.every((s) => s.kind === 'repo')).toBe(true);
  });
});

describe('runSources — unsupported/forbidden', () => {
  it('returns no sources when actions are unsupported', () => {
    const result = runSources({
      caps: caps('unsupported'),
      settings: settings(),
      orgs: ['acme'],
      pins: [repo('acme/platform')],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });
    expect(result).toEqual({ sources: [], overLimit: false });
  });

  it('returns no sources when actions are forbidden', () => {
    const result = runSources({
      caps: caps('forbidden'),
      settings: settings(),
      orgs: ['acme'],
      pins: [],
      ownRepos: [],
      recentMine: [],
      mode: 'base',
    });
    expect(result).toEqual({ sources: [], overLimit: false });
  });
});
