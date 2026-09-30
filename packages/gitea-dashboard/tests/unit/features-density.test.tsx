// @vitest-environment happy-dom
// T004 [Foundational] — density prop parity between popup (compact) and the
// future dashboard page (comfortable). Contract:
// docs/specs/002-fullpage-dashboard/research.md R8: comfortable density must
// render the same rows (same titles/aria) as compact for the same props.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { browser } from 'wxt/browser';

import { PrsGroups } from '../../src/features/prs/PrsGroups';
import { BuildsGroups } from '../../src/features/builds/BuildsGroups';
import { renderComfortableSecondary } from '../../src/features/builds/comfortable-row';
import { DEFAULT_SETTINGS, type PullRequest, type Run, type Snapshot } from '../../src/domain/types';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'core' },
    number: 42,
    title: 'Fix the thing',
    author: 'octocat',
    updatedAt: '2024-01-01T00:00:00.000Z',
    htmlUrl: 'https://git.example.test/acme/core/pulls/42',
    draft: false,
    group: 'review',
    ci: { state: 'success', fetchedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function snapshotOfPrs(prs: PullRequest[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: '2024-01-01T00:00:00.000Z',
    prs,
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'core' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'abc123',
    htmlUrl: 'https://git.example.test/acme/core/actions/runs/1',
    title: 'CI',
    workflow: 'ci.yml',
    state: 'success',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

function snapshotOfRuns(runs: Run[]): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: [],
    runs,
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

describe('density parity (compact vs comfortable)', () => {
  beforeEach(() => {
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('PrsGroups renders the same PR title and listbox aria-label at both densities', () => {
    const snapshot = snapshotOfPrs([pr({ title: 'Fix the thing', group: 'mine' })]);

    const { unmount } = render(
      <PrsGroups snapshot={snapshot} settings={DEFAULT_SETTINGS} density="compact" />
    );
    expect(screen.getByText('Fix the thing')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'prsGroupMine' })).toBeTruthy();
    unmount();
    cleanup();

    render(<PrsGroups snapshot={snapshot} settings={DEFAULT_SETTINGS} density="comfortable" />);
    expect(screen.getByText('Fix the thing')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'prsGroupMine' })).toBeTruthy();
  });

  it('BuildsGroups renders the same workflow title and listbox aria-label at both densities', () => {
    const snapshot = snapshotOfRuns([makeRun({ workflow: 'ci.yml', group: 'mine' })]);

    const { unmount } = render(<BuildsGroups snapshot={snapshot} density="compact" />);
    expect(screen.getByText('ci.yml')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'buildsGroupMine' })).toBeTruthy();
    unmount();
    cleanup();

    render(
      <BuildsGroups
        snapshot={snapshot}
        density="comfortable"
        renderSecondary={renderComfortableSecondary}
      />
    );
    expect(screen.getByText('ci.yml')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'buildsGroupMine' })).toBeTruthy();
  });

  // T034 (US5): compact keeps the plain "owner/repo · branch · event · actor"
  // secondary line (byte-identical popup markup); comfortable swaps the
  // repo/branch segments for RepoTag/BranchTag Badges instead.
  it('BuildsGroups: compact renders plain repo/branch text, comfortable renders RepoTag/BranchTag badges', () => {
    const snapshot = snapshotOfRuns([
      makeRun({ workflow: 'ci.yml', group: 'mine', repo: { owner: 'acme', name: 'core' }, branch: 'main' }),
    ]);

    const { unmount } = render(<BuildsGroups snapshot={snapshot} density="compact" />);
    expect(screen.getByText('acme/core · main · push · alice')).toBeTruthy();
    expect(screen.queryByText('core', { selector: '[data-slot="badge"]' })).toBeNull();
    unmount();
    cleanup();

    render(
      <BuildsGroups
        snapshot={snapshot}
        density="comfortable"
        renderSecondary={renderComfortableSecondary}
      />
    );
    expect(screen.queryByText('acme/core · main · push · alice')).toBeNull();
    const repoBadge = screen.getByText('core');
    const branchBadge = screen.getByText('main');
    expect(repoBadge.getAttribute('data-slot')).toBe('badge');
    expect(branchBadge.getAttribute('data-slot')).toBe('badge');
    expect(branchBadge.className).toMatch(/bg-blue-500\/10/);
  });
});
