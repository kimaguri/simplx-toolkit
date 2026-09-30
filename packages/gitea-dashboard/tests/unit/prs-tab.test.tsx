// @vitest-environment happy-dom
// T038 [US3] — PRs popup tab.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-020..023, FR-072.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { browser } from 'wxt/browser';

import { Prs } from '../../src/entrypoints/popup/tabs/Prs';
import { DEFAULT_SETTINGS, type PullRequest, type Snapshot } from '../../src/domain/types';

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

/**
 * Group headers are canonical shadcn markup: a muted uppercase title text
 * node plus a *separate* `Badge variant="secondary"` for the count (not one
 * concatenated string) — so this reads the title from the heading's own text
 * and the count from its Badge child independently, instead of asserting a
 * single "title (N)" string.
 */
function headingParts(heading: HTMLElement): { title: string; count: string } {
  const badge = heading.querySelector('[data-slot="badge"]');
  const title = (heading.textContent ?? '').replace(badge?.textContent ?? '', '').trim();
  return { title, count: badge?.textContent ?? '' };
}

function snapshotOf(prs: PullRequest[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: '2024-01-01T00:00:00.000Z',
    prs,
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    ...overrides,
  };
}

describe('Prs tab', () => {
  beforeEach(() => {
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the whole-tab empty state when there is no snapshot yet', () => {
    render(<Prs snapshot={null} settings={DEFAULT_SETTINGS} />);
    expect(screen.getByText('prsEmpty')).toBeTruthy();
  });

  it('shows the whole-tab empty state when the snapshot has no PRs at all', () => {
    render(<Prs snapshot={snapshotOf([])} settings={DEFAULT_SETTINGS} />);
    expect(screen.getByText('prsEmpty')).toBeTruthy();
  });

  it('renders the three groups with headers and counts, each item with title/owner-repo#N/author/time/CI/badges', () => {
    const snapshot = snapshotOf([
      pr({ id: 1, group: 'review', title: 'Review me' }),
      pr({
        id: 2,
        group: 'mine',
        title: 'My draft PR',
        draft: true,
        mergeable: false,
        ci: { state: 'failure', fetchedAt: '2024-01-01T00:00:00.000Z' },
      }),
      pr({ id: 3, group: 'other', title: 'Someone elses PR' }),
    ]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    const headings = screen.getAllByRole('heading');
    expect(headings.map(headingParts)).toEqual([
      { title: 'prsGroupReview', count: '1' },
      { title: 'prsGroupMine', count: '1' },
      { title: 'prsGroupOther', count: '1' },
    ]);

    // review item
    const reviewOption = screen.getByText('Review me').closest('[role="option"]') as HTMLElement;
    expect(reviewOption.textContent).toContain('acme/core #42');
    expect(reviewOption.textContent).toContain('octocat');

    // mine item: draft + conflict badges
    const mineOption = screen.getByText('My draft PR').closest('[role="option"]') as HTMLElement;
    expect(within(mineOption).getByText('prsDraftBadge')).toBeTruthy();
    expect(within(mineOption).getByText('prsConflictBadge')).toBeTruthy();

    // CI status icon has an accessible title per ci.state
    expect(within(mineOption).getByRole('img', { name: 'statusFailure' })).toBeTruthy();
    const reviewCi = within(reviewOption).getByRole('img', { name: 'statusSuccess' });
    expect(reviewCi).toBeTruthy();
  });

  it('hides the "other" group when settings.showOtherPrs is false', () => {
    const snapshot = snapshotOf([
      pr({ id: 1, group: 'review' }),
      pr({ id: 2, group: 'other' }),
    ]);

    render(<Prs snapshot={snapshot} settings={{ ...DEFAULT_SETTINGS, showOtherPrs: false }} />);

    const headings = screen.getAllByRole('heading');
    expect(headings.map(headingParts)).toEqual([
      { title: 'prsGroupReview', count: '1' },
      { title: 'prsGroupMine', count: '0' },
    ]);
  });

  it('shows a per-group empty state when a visible group has no items', () => {
    const snapshot = snapshotOf([pr({ id: 1, group: 'review' })]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    expect(screen.getByText('prsGroupMineEmpty')).toBeTruthy();
    expect(screen.getByText('prsGroupOtherEmpty')).toBeTruthy();
  });

  it('opens the PR in a new tab on click', () => {
    const target = pr({ id: 1, group: 'review', htmlUrl: 'https://git.example.test/acme/core/pulls/42' });
    const snapshot = snapshotOf([target]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    fireEvent.click(screen.getByText(target.title));
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: target.htmlUrl });
  });

  it('opens the PR on Enter after keyboard navigation', () => {
    const snapshot = snapshotOf([
      pr({ id: 1, group: 'review', title: 'First', htmlUrl: 'https://git.example.test/a/b/pulls/1' }),
      pr({ id: 2, group: 'review', title: 'Second', htmlUrl: 'https://git.example.test/a/b/pulls/2' }),
    ]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    const listbox = screen.getByRole('listbox', { name: 'prsGroupReview' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://git.example.test/a/b/pulls/2',
    });
  });

  it('shows an ErrorState for sectionErrors.prs when there is no data at all', () => {
    const snapshot = snapshotOf([], { sectionErrors: { prs: { kind: 'network', at: '2024-01-01T00:00:00.000Z' } } });

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('prsErrorNetwork')).toBeTruthy();
  });

  it('shows a "ещё N" link when prTotals exceeds the shown count and opens it in a new tab', () => {
    const snapshot = snapshotOf(
      [pr({ id: 1, group: 'review' })],
      { prTotals: { review: 3, mine: 0, other: 0 } }
    );

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} baseUrl="https://gitea.example" />);

    const link = screen.getByText('prsMoreLink');
    fireEvent.click(link);

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://gitea.example/pulls?type=review_requested',
    });
  });

  it('does not show a "ещё N" link when prTotals does not exceed the shown count', () => {
    const snapshot = snapshotOf(
      [pr({ id: 1, group: 'review' })],
      { prTotals: { review: 1, mine: 0, other: 0 } }
    );

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} baseUrl="https://gitea.example" />);

    expect(screen.queryByText('prsMoreLink')).toBeNull();
  });

  it('T082: keeps exactly one selected row across all groups, ↑/↓ crosses group boundaries, Enter opens it', () => {
    const snapshot = snapshotOf([
      pr({ id: 1, group: 'review', title: 'Review only', htmlUrl: 'https://git.example.test/a/b/pulls/1' }),
      pr({ id: 2, group: 'mine', title: 'Mine first', htmlUrl: 'https://git.example.test/a/b/pulls/2' }),
      pr({ id: 3, group: 'mine', title: 'Mine second', htmlUrl: 'https://git.example.test/a/b/pulls/3' }),
    ]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    // Exactly one aria-selected=true across all three groups' listboxes.
    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    const reviewListbox = screen.getByRole('listbox', { name: 'prsGroupReview' });
    // "review" has a single row and is already the last row of its group:
    // ArrowDown here must cross into the "mine" group's first row.
    fireEvent.keyDown(reviewListbox, { key: 'ArrowDown' });

    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    const mineListbox = screen.getByRole('listbox', { name: 'prsGroupMine' });
    expect(within(mineListbox).getByText('Mine first').closest('[role="option"]')?.getAttribute('aria-selected')).toBe(
      'true'
    );

    fireEvent.keyDown(mineListbox, { key: 'Enter' });
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'https://git.example.test/a/b/pulls/2' });
  });

  it('T082: shows the selected-row highlight only once the list has keyboard focus', () => {
    const snapshot = snapshotOf([pr({ id: 1, group: 'review', title: 'Only PR' })]);

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    const option = screen.getByText('Only PR').closest('[role="option"]') as HTMLElement;
    expect(option.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);

    const listbox = screen.getByRole('listbox', { name: 'prsGroupReview' });
    fireEvent.focus(listbox);
    expect(option.className).toMatch(/(?:^|\s)bg-accent(?:\s|$)/);

    fireEvent.blur(listbox);
    expect(option.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
  });

  it('shows a stale hint (not a hard error) when sectionErrors.prs is set but stale data is still available', () => {
    const snapshot = snapshotOf([pr({ id: 1, group: 'review' })], {
      sectionErrors: { prs: { kind: 'server', at: '2024-01-01T00:00:00.000Z' } },
    });

    render(<Prs snapshot={snapshot} settings={DEFAULT_SETTINGS} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('staleMessage')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
