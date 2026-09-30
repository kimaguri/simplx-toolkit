// @vitest-environment happy-dom
// T016 (US3): the "table" view of the PR section — canonical shadcn
// data-table (TanStack Table v9) driven entirely by
// src/domain/pr-filter.ts (applyPrFilter/facetCounts) and
// src/domain/route.ts (PrTableFilter <-> hash), spec.md US3 scenarios 1-6.
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { PullRequest, Snapshot } from '../../src/domain/types';
import { PrsTable } from '../../src/features/prs/PrsTable';
import { App as DashboardApp } from '../../src/entrypoints/dashboard/App';

// Radix Popover/Command in happy-dom need these stubbed (cmdk scrolls
// highlighted items into view; Radix dismiss-layers probe pointer capture).
beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
});

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 1,
    title: 'Add feature',
    author: 'alice',
    updatedAt: '2026-09-20T10:00:00.000Z',
    htmlUrl: 'https://gitea.example/acme/platform/pulls/1',
    draft: false,
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2026-09-20T10:00:00.000Z' },
    ...overrides,
  };
}

const PRS: PullRequest[] = [
  pr({
    id: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    title: 'Add feature A',
    author: 'alice',
    updatedAt: '2026-09-20T08:00:00.000Z',
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2026-09-20T08:00:00.000Z' },
  }),
  pr({
    id: 2,
    number: 2,
    repo: { owner: 'acme', name: 'core' },
    title: 'Fix bug B',
    author: 'bob',
    updatedAt: '2026-09-21T08:00:00.000Z',
    draft: true,
    group: 'review',
    ci: { state: 'failure', fetchedAt: '2026-09-21T08:00:00.000Z' },
  }),
  pr({
    id: 3,
    number: 3,
    repo: { owner: 'acme', name: 'platform' },
    title: 'Zzz refactor',
    author: 'carol',
    updatedAt: '2026-09-22T08:00:00.000Z',
    mergeable: false,
    group: 'other',
    ci: { state: 'pending', fetchedAt: '2026-09-22T08:00:00.000Z' },
  }),
];

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: PRS,
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    ...overrides,
  };
}

describe('PrsTable', () => {
  it('renders the CI/title/repo/author/updated columns and draft/conflict badges', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    expect(screen.getByText('prsColCi')).toBeTruthy();
    expect(screen.getByText('prsColTitle')).toBeTruthy();
    expect(screen.getByText('prsColRepo')).toBeTruthy();
    expect(screen.getByText('prsColAuthor')).toBeTruthy();
    expect(screen.queryByText('prsColGroup')).toBeNull();
    expect(screen.getByText('prsColUpdated')).toBeTruthy();

    expect(screen.getByText('Add feature A')).toBeTruthy();
    expect(screen.getByText('prsDraftBadge')).toBeTruthy();
    expect(screen.getByText('prsConflictBadge')).toBeTruthy();
  });

  // T034 (US5): the "Репозиторий" cell renders a NumberTag ("#N") followed by
  // a RepoTag (short label, no owner — no collision among acme/platform,
  // acme/core), each a separate Badge element, in that order.
  it('renders the repo cell as a NumberTag followed by a RepoTag (no owner collision)', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    const numberBadge = screen.getByText('#2');
    const repoBadge = screen.getByText('core');
    expect(numberBadge.getAttribute('data-slot')).toBe('badge');
    expect(repoBadge.getAttribute('data-slot')).toBe('badge');
    expect(repoBadge.getAttribute('title')).toBe('acme/core');
    // NumberTag comes before RepoTag in document order.
    expect(numberBadge.compareDocumentPosition(repoBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows "N из M" and filters rows via the repo facet with per-option counts', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    expect(screen.getByText('prsFiltersCount')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /prsFacetRepo/ }));
    const platformOption = screen.getByText('acme/platform').closest('[cmdk-item]') as HTMLElement;
    expect(within(platformOption).getByText('2')).toBeTruthy();

    fireEvent.click(screen.getByText('acme/platform'));

    expect(screen.getByText('prsFiltersCount')).toBeTruthy();
    expect(screen.getByText('Add feature A')).toBeTruthy();
    expect(screen.getByText('Zzz refactor')).toBeTruthy();
    expect(screen.queryByText('Fix bug B')).toBeNull();
  });

  it('filters rows by the search box across title/repo/number/author, case-insensitively', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    fireEvent.change(screen.getByPlaceholderText('prsFilterSearchPlaceholder'), {
      target: { value: 'BOB' },
    });

    expect(screen.getByText('prsFiltersCount')).toBeTruthy();
    expect(screen.getByText('Fix bug B')).toBeTruthy();
    expect(screen.queryByText('Add feature A')).toBeNull();
  });

  it('sorts rows by clicking a column header, toggling direction on repeat clicks', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    const table = screen.getByRole('table');
    const titlesInOrder = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent ?? '');

    // Default: updated desc -> Zzz refactor (22nd), Fix bug B (21st), Add feature A (20th).
    expect(titlesInOrder()[0]).toContain('Zzz refactor');

    fireEvent.click(screen.getByRole('button', { name: /prsColTitle/ }));
    expect(titlesInOrder()[0]).toContain('Add feature A');
    expect(titlesInOrder()[2]).toContain('Zzz refactor');

    fireEvent.click(screen.getByRole('button', { name: /prsColTitle/ }));
    expect(titlesInOrder()[0]).toContain('Zzz refactor');
    expect(titlesInOrder()[2]).toContain('Add feature A');
  });

  it('shows "Сбросить" only while a filter is active, and it clears everything', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    expect(screen.queryByText('prsFiltersReset')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('prsFilterSearchPlaceholder'), {
      target: { value: 'bob' },
    });
    expect(screen.getByText('prsFiltersReset')).toBeTruthy();

    fireEvent.click(screen.getByText('prsFiltersReset'));

    expect(screen.getByText('prsFiltersCount')).toBeTruthy();
    expect(screen.queryByText('prsFiltersReset')).toBeNull();
  });

  it('shows "ничего не найдено" plus a reset button when filters leave no rows', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    fireEvent.change(screen.getByPlaceholderText('prsFilterSearchPlaceholder'), {
      target: { value: 'does-not-exist' },
    });

    expect(screen.getByText('prsTableNoResults')).toBeTruthy();
    fireEvent.click(screen.getAllByText('prsFiltersReset')[0] as HTMLElement);
    expect(screen.getByText('prsFiltersCount')).toBeTruthy();
    expect(screen.getByText('Add feature A')).toBeTruthy();
  });

  it('writes filter changes to the hash and restores them from the hash on mount', () => {
    const { unmount } = render(<PrsTable snapshot={baseSnapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: /prsFacetRepo/ }));
    fireEvent.click(screen.getByText('acme/platform'));

    expect(window.location.hash).toContain('repo=acme%2Fplatform');
    unmount();
    cleanup();

    render(<PrsTable snapshot={baseSnapshot()} />);
    expect(screen.getByText('prsFiltersCount')).toBeTruthy();
  });

  // T031 (Phase 8 review fixes, M2): "back" (or any external hash change)
  // must re-read the filter from the hash and re-render, not just leave the
  // address bar out of sync with a stale in-memory filter.
  it('re-reads the filter from the hash on hashchange (browser back)', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    expect(screen.getByText('Add feature A')).toBeTruthy();
    expect(screen.getByText('Fix bug B')).toBeTruthy();

    window.location.hash = '#/prs?view=table&repo=acme%2Fplatform&sort=updated%3Adesc';
    fireEvent(window, new Event('hashchange'));

    expect(screen.getByText('Add feature A')).toBeTruthy();
    expect(screen.getByText('Zzz refactor')).toBeTruthy();
    expect(screen.queryByText('Fix bug B')).toBeNull();
  });

  // T031 (T025 defect, spec.md FR-109 / quickstart P10: "горизонтальной
  // прокрутки страницы нет"): the table's own scroll container must stay
  // scoped to the table (overflow-x-auto), never bubbled up to the page --
  // a wide table must never give the whole page a horizontal scrollbar.
  it('keeps the horizontal scroll scoped to the table container (no page-level overflow, FR-109)', () => {
    render(<PrsTable snapshot={baseSnapshot()} />);

    const table = screen.getByRole('table');
    const container = table.closest('[data-slot="table-container"]') as HTMLElement | null;
    expect(container).toBeTruthy();
    expect(container?.className).toContain('overflow-x-auto');
    // Regression guard: nothing between the table and this container may
    // override that to `overflow-x-visible` (which would let a wide table
    // bleed into page-level scroll instead of scrolling within its own box).
    let node: HTMLElement | null = table.parentElement;
    while (node && node !== container) {
      expect(node.className).not.toContain('overflow-x-visible');
      node = node.parentElement;
    }
  });

  it('opens the PR on row click and on Enter', () => {
    const tabsCreate = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    render(<PrsTable snapshot={baseSnapshot()} />);

    fireEvent.click(screen.getByText('Add feature A'));
    expect(tabsCreate).toHaveBeenCalledWith({ url: PRS[0]?.htmlUrl });

    tabsCreate.mockClear();
    const row = screen.getByText('Fix bug B').closest('tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(tabsCreate).toHaveBeenCalledWith({ url: PRS[1]?.htmlUrl });
  });
});

// T041 re-scope: the Группы/Таблица toggle is gone -- the PR section on the
// page always renders the table (PrsGroups is no longer reachable from
// there at all).
describe('PR section on the page (no view toggle)', () => {
  async function configureInstance(): Promise<void> {
    const { setInstances, setToken } = await import('../../src/lib/storage');
    await setInstances({
      instances: [
        {
          id: 'i_test0001',
          baseUrl: 'https://gitea.example',
          capabilities: { actions: 'org', notifications: false, orgs: [], missingScopes: [] },
        },
      ],
      activeInstanceId: 'i_test0001',
    });
    await setToken('i_test0001', 'test-token');
  }

  it('always renders the table (no toggle), even for an old view=groups hash', async () => {
    const { setSnapshot } = await import('../../src/lib/storage');
    await configureInstance();
    await setSnapshot('i_test0001', baseSnapshot());
    window.location.hash = '#/prs?view=groups';

    render(<DashboardApp />);

    await waitFor(() => {
      expect(screen.getByText('prsColTitle')).toBeTruthy();
    });
    expect(screen.queryByRole('radio', { name: 'prsViewTable' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'prsViewGroups' })).toBeNull();
  });

  it('has no group facet filter and ignores a legacy group= hash without breaking', async () => {
    const { setSnapshot } = await import('../../src/lib/storage');
    await configureInstance();
    await setSnapshot('i_test0001', baseSnapshot());
    window.location.hash = '#/prs?group=mine';

    render(<DashboardApp />);

    await waitFor(() => {
      expect(screen.getByText('prsColTitle')).toBeTruthy();
    });
    expect(screen.queryByText('prsColGroup')).toBeNull();
    expect(screen.queryByRole('button', { name: /prsFacetGroup/ })).toBeNull();
    // The stale group=mine filter must not hide any row (all 4 PRs visible).
    expect(screen.getByText('Add feature A')).toBeTruthy();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(3);
  });
});
