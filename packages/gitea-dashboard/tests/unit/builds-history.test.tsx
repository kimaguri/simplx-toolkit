// @vitest-environment happy-dom
// T022 (US4): the "history" view of the Builds section —
// src/features/builds/{BuildsHistory,HistoryStats,HistoryFilters}.tsx, driven
// by src/features/builds/history-loader.ts (mocked here — the loader's own
// behavior is covered by tests/integration/history-fetch.test.ts, T020) and
// src/domain/history.ts / src/domain/route.ts (real, T018/T019/T003).
// Contract: spec.md US4 scenarios 1-7, data-model.md "RunHistoryFilter",
// "RunStats", contracts/page-surface.md.
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { ApiError } from '../../src/api/client';
import type { Run } from '../../src/domain/types';
import { getUiState, setInstances, setToken, setWorkflowsCache } from '../../src/lib/storage';

const loadHistory = vi.fn();
const loadMore = vi.fn();
// T058: BuildsHistory also tops up the head of history right after every
// load (history-loader.ts's own 60s-per-source freshness gate makes this a
// 0-request no-op in every one of the tests below) — the dedicated tests for
// its actual merge/scheduling behavior live in
// tests/unit/builds-history-refresh.test.tsx.
const refreshHead = vi.fn();

vi.mock('../../src/features/builds/history-loader', () => ({
  loadHistory: (...args: unknown[]) => loadHistory(...args),
  loadMore: (...args: unknown[]) => loadMore(...args),
  refreshHead: (...args: unknown[]) => refreshHead(...args),
}));

import { BuildsHistory } from '../../src/features/builds/BuildsHistory';

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
  // Legacy fixtures use non-build branches -> open on "Все запуски" (tab tests set their own hash).
  window.location.hash = '#/builds?view=history&kind=all';
  loadHistory.mockReset();
  loadMore.mockReset();
  refreshHead.mockReset().mockResolvedValue({ runs: [], coveredUntil: '2026-09-01T00:00:00.000Z', hasMore: false, requests: 0 });
});

afterEach(() => {
  cleanup();
});

const INSTANCE = {
  id: 'i_test0001',
  baseUrl: 'https://gitea.example',
  capabilities: { actions: 'org' as const, notifications: false, orgs: [], missingScopes: [] },
};

async function configureInstance(): Promise<void> {
  await setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await setToken(INSTANCE.id, 'test-token');
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'abc123',
    htmlUrl: 'https://gitea.example/acme/platform/actions/runs/1',
    title: 'push: main',
    workflow: 'ci.yml',
    state: 'success',
    startedAt: '2026-09-25T10:00:00.000Z',
    completedAt: '2026-09-25T10:05:00.000Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

const RUNS: Run[] = [
  run({
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    workflow: 'ci.yml',
    branch: 'release',
    event: 'push',
    actor: 'alice',
    state: 'success',
    startedAt: '2026-09-25T10:00:00.000Z',
    completedAt: '2026-09-25T10:05:00.000Z',
  }),
  run({
    id: 2,
    repo: { owner: 'acme', name: 'core' },
    workflow: 'ci.yml',
    branch: 'develop',
    event: 'pull_request',
    actor: 'bob',
    state: 'failure',
    startedAt: '2026-09-24T09:00:00.000Z',
    completedAt: '2026-09-24T09:20:00.000Z',
  }),
  run({
    id: 3,
    repo: { owner: 'acme', name: 'platform' },
    workflow: 'lint.yml',
    branch: 'release',
    event: 'push',
    actor: 'me',
    mine: true,
    state: 'success',
    startedAt: '2026-09-23T08:00:00.000Z',
    completedAt: '2026-09-23T08:01:00.000Z',
  }),
];

function loadResult(overrides: Record<string, unknown> = {}) {
  return {
    runs: RUNS,
    coveredUntil: '2026-09-20T00:00:00.000Z',
    hasMore: false,
    requests: 1,
    ...overrides,
  };
}

const BRANCH_RUNS: Run[] = [
  run({ id: 21, repo: { owner: 'acme', name: 'mainrepo' }, branch: 'main' }),
  run({ id: 22, repo: { owner: 'acme', name: 'devrepo' }, branch: 'develop' }),
  run({ id: 23, repo: { owner: 'acme', name: 'testrepo' }, branch: 'test' }),
];

function table() {
  return within(screen.getByTestId('history-runs-table'));
}

describe('BuildsHistory: no preset branch filter (T052, FR-124)', () => {
  it('shows every branch by default (kind=all) and never writes branch= to the address', async () => {
    window.location.hash = '#/builds?view=history&kind=all';
    loadHistory.mockResolvedValue(loadResult({ runs: BRANCH_RUNS }));
    await configureInstance();
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('devrepo')).toBeTruthy());
    expect(table().getByText('mainrepo')).toBeTruthy();
    expect(table().getByText('testrepo')).toBeTruthy();
    expect(window.location.hash).not.toContain('branch=');
    expect(replace).not.toHaveBeenCalled();
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit branch= from the address', async () => {
    window.location.hash = '#/builds?view=history&kind=all&branch=develop';
    loadHistory.mockResolvedValue(loadResult({ runs: BRANCH_RUNS }));
    await configureInstance();
    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('devrepo')).toBeTruthy());
    expect(table().queryByText('mainrepo')).toBeNull();
  });

  it('clear drops an explicit branch selection', async () => {
    window.location.hash = '#/builds?view=history&kind=all&branch=develop';
    loadHistory.mockResolvedValue(loadResult({ runs: BRANCH_RUNS }));
    await configureInstance();
    render(<BuildsHistory />);
    await waitFor(() => expect(table().queryByText('mainrepo')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'historyClear' }));
    await waitFor(() => expect(table().getByText('mainrepo')).toBeTruthy());
    expect(window.location.hash).not.toContain('branch=');
  });
});

describe('BuildsHistory: tabs Сборки / Все запуски (T053, FR-125)', () => {
  const TAB_RUNS: Run[] = [
    run({ id: 101, repo: { owner: 'acme', name: 'relrepo' }, branch: 'v1.42.5', event: 'push', title: 'Merge pull request into main' }),
    run({ id: 102, repo: { owner: 'acme', name: 'testrepo' }, branch: 'test', event: 'push' }),
    run({ id: 103, repo: { owner: 'acme', name: 'prrepo' }, branch: 'main', event: 'pull_request', state: 'failure' }),
    run({ id: 104, repo: { owner: 'acme', name: 'featrepo' }, branch: 'feature/x', event: 'push' }),
  ];

  beforeEach(() => {
    window.location.hash = '#/builds?view=history';
    loadHistory.mockResolvedValue(loadResult({ runs: TAB_RUNS }));
  });

  it('opens on "Сборки" by default: releases + builds only, with counters on both tabs', async () => {
    await configureInstance();
    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('relrepo')).toBeTruthy());
    expect(table().getByText('testrepo')).toBeTruthy();
    expect(table().queryByText('prrepo')).toBeNull();
    expect(table().queryByText('featrepo')).toBeNull();

    const builds = screen.getByRole('tab', { name: /historyTabBuilds/ });
    const all = screen.getByRole('tab', { name: /historyTabAll/ });
    expect(builds.getAttribute('aria-selected')).toBe('true');
    expect(builds.textContent).toContain('2');
    expect(all.textContent).toContain('4');
  });

  it('kind=all in the address opens "Все запуски"', async () => {
    window.location.hash = '#/builds?view=history&kind=all';
    await configureInstance();
    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('featrepo')).toBeTruthy());
    expect(table().getByText('prrepo')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /historyTabAll/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('switching tabs writes/removes kind=all in the address without reloading the data', async () => {
    await configureInstance();
    render(<BuildsHistory />);
    await waitFor(() => expect(table().getByText('relrepo')).toBeTruthy());

    fireEvent.mouseDown(screen.getByRole('tab', { name: /historyTabAll/ }));
    await waitFor(() => expect(table().getByText('featrepo')).toBeTruthy());
    expect(window.location.hash).toContain('kind=all');

    fireEvent.mouseDown(screen.getByRole('tab', { name: /historyTabBuilds/ }));
    await waitFor(() => expect(table().queryByText('featrepo')).toBeNull());
    expect(window.location.hash).not.toContain('kind=');
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('marks release runs with the "релиз" tag and only them', async () => {
    window.location.hash = '#/builds?view=history&kind=all';
    await configureInstance();
    render(<BuildsHistory />);
    await waitFor(() => expect(table().getByText('relrepo')).toBeTruthy());

    const tags = table().getAllByText('historyKindRelease');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.getAttribute('data-slot')).toBe('badge');
    expect(tags[0]?.closest('tr')?.textContent).toContain('relrepo');
  });

  it('stats are computed over the tab-visible runs', async () => {
    await configureInstance();
    render(<BuildsHistory />);
    await waitFor(() => expect(table().getByText('relrepo')).toBeTruthy());

    // 2 visible builds, both success -> total 2, 0% failed (the failing PR run is hidden).
    const toggle = screen.getByRole('button', { name: /historyStatsToggle/ });
    expect(toggle.textContent).toContain('historyStatsSummary');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('historyStatTotal')).toBeTruthy());
    expect(screen.getByText('historyStatTotal').closest('[data-slot="card"]')?.textContent).toContain('2');
  });

  it('keeps "Показать ещё" reachable when the tab shows nothing but more pages exist', async () => {
    loadHistory.mockResolvedValue(loadResult({ runs: [TAB_RUNS[2]!, TAB_RUNS[3]!], hasMore: true }));
    loadMore.mockResolvedValue(loadResult({ runs: TAB_RUNS, hasMore: false }));
    await configureInstance();
    render(<BuildsHistory />);

    const more = await screen.findByRole('button', { name: 'historyShowMore' });
    expect(table().queryByText('prrepo')).toBeNull();
    fireEvent.click(more);
    await waitFor(() => expect(table().getByText('relrepo')).toBeTruthy());
  });
});

describe('BuildsHistory', () => {
  it('loads via loadHistory and renders stats + the runs table', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => expect(loadHistory).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.getAllByText('platform').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('core')).toBeTruthy();

    // T042: the stats panel (cards + "По workflow") is collapsed by default.
    expect(screen.queryByText('historyStatTotal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /historyStatsToggle/ }));
    await waitFor(() => expect(screen.getByText('historyStatTotal')).toBeTruthy());
    expect(screen.getByText('historyStatTotal').closest('[data-slot="card"]')?.textContent).toContain('3'); // total runs stat
  });

  // T042 (owner decision): stats panel default-collapsed, expandable, and
  // its open state persists in ui.historyStatsOpen.
  it('keeps the stats panel collapsed by default, shows cards on expand, and persists the open state', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => expect(screen.getAllByText('platform').length).toBeGreaterThan(0));
    expect(screen.queryByText('historyStatTotal')).toBeNull();
    const toggle = screen.getByRole('button', { name: /historyStatsToggle/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(screen.getByText('historyStatTotal')).toBeTruthy());
    await waitFor(async () => {
      expect((await getUiState()).historyStatsOpen).toBe(true);
    });
  });

  it('restores an already-open stats panel from ui.historyStatsOpen', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();
    const { setUiState } = await import('../../src/lib/storage');
    await setUiState({ historyStatsOpen: true });

    render(<BuildsHistory />);

    await waitFor(() => expect(screen.getByText('historyStatTotal')).toBeTruthy());
  });

  // T034 (US5): the "Репозиторий"/"Ветка" columns render RepoTag/BranchTag
  // Badges (short repo label, no owner collision among acme/platform,
  // acme/core; branch tone blue for main, amber for a branch named "test").
  it('renders RepoTag/BranchTag badges in the runs table, toned by branch name', async () => {
    loadHistory.mockResolvedValue(
      loadResult({
        runs: [
          ...RUNS,
          run({ id: 4, repo: { owner: 'acme', name: 'core' }, branch: 'test', workflow: 'ci.yml' }),
          // main is present too -> the default branch filter (test+main) keeps both badges visible.
          run({ id: 5, repo: { owner: 'acme', name: 'platform' }, branch: 'main', workflow: 'ci.yml' }),
        ],
      })
    );
    await configureInstance();

    render(<BuildsHistory />);

    const table = await waitFor(() => screen.getByTestId('history-runs-table'));

    const mainBadge = within(table).getAllByText('main')[0] as HTMLElement;
    expect(mainBadge.getAttribute('data-slot')).toBe('badge');
    expect(mainBadge.className).toMatch(/bg-blue-500\/10/);

    const testBranchBadge = within(table).getByText('test');
    expect(testBranchBadge.className).toMatch(/bg-amber-500\/10/);

    const repoBadge = within(table).getAllByText('platform')[0] as HTMLElement;
    expect(repoBadge.getAttribute('data-slot')).toBe('badge');
    expect(repoBadge.getAttribute('title')).toBe('acme/platform');
  });

  it('shows a Skeleton while loading', async () => {
    let resolve!: (v: unknown) => void;
    loadHistory.mockReturnValue(new Promise((r) => (resolve = r)));
    await configureInstance();

    render(<BuildsHistory />);
    expect(screen.getByTestId('history-skeleton')).toBeTruthy();

    resolve(loadResult());
    await waitFor(() => expect(screen.queryByTestId('history-skeleton')).toBeNull());
  });

  it('switches the period via ToggleGroup and reloads', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(loadHistory.mock.calls[0]?.[0]).toMatchObject({ period: 'today' });
    const radios = screen.getAllByRole('radio');
    expect(radios[0]?.getAttribute('aria-label') ?? radios[0]?.textContent).toContain('historyPeriodToday');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'historyPeriod24h' }));

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(loadHistory.mock.calls[1]?.[0]).toMatchObject({ period: '24h' });
  });

  it('filters the table and stats via the repo facet', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /historyFacetRepo/ }));
    const platformOption = screen
      .getAllByText('acme/platform')
      .map((el) => el.closest('[cmdk-item]'))
      .find((el): el is HTMLElement => el !== null) as HTMLElement;
    expect(within(platformOption).getByText('2')).toBeTruthy();
    fireEvent.click(platformOption);

    await waitFor(() => {
      expect(within(screen.getByTestId('history-runs-table')).queryByText('core')).toBeNull();
    });
  });

  it('filters via "только мои" (mine switch)', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() =>
      expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy()
    );

    fireEvent.click(screen.getByRole('switch', { name: 'historyMineLabel' }));

    await waitFor(() => {
      const table = screen.getByTestId('history-runs-table');
      expect(within(table).queryByText('core')).toBeNull();
      expect(within(table).getAllByText('platform').length).toBeGreaterThan(0);
    });
  });

  it('sorts the table by started/duration on header click', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByTestId('history-runs-table')).toBeTruthy());

    const table = screen.getByTestId('history-runs-table');
    const rowsText = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent ?? '');

    // Default sort: started desc -> id 1 (25th) first.
    expect(rowsText()[0]).toContain('platform');

    fireEvent.click(screen.getByRole('button', { name: /historyColStarted/ }));
    // Toggling the already-active sort column reverses direction -> oldest first (id 3, 23rd).
    expect(rowsText()[0]).toContain('lint.yml');
  });

  it('shows "показать ещё" when hasMore, appending merged runs on click', async () => {
    loadHistory.mockResolvedValue(loadResult({ hasMore: true, coveredUntil: '2026-09-24T00:00:00.000Z' }));
    loadMore.mockResolvedValue(
      loadResult({
        runs: [...RUNS, run({ id: 4, repo: { owner: 'acme', name: 'core' }, workflow: 'ci.yml' })],
        hasMore: false,
      })
    );
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('historyShowMore')).toBeTruthy());

    fireEvent.click(screen.getByText('historyShowMore'));

    await waitFor(() => expect(loadMore).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('historyShowMore')).toBeNull());
  });

  it('shows the coverage note when the period is not fully covered', async () => {
    loadHistory.mockResolvedValue(loadResult({ hasMore: true, coveredUntil: '2026-09-21T00:00:00.000Z' }));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => {
      expect(screen.getByText(/historyCoverageNote/)).toBeTruthy();
    });
  });

  it('shows a compact Alert listing failed sources', async () => {
    loadHistory.mockResolvedValue(loadResult({ sourceErrors: { 'org:acme': 'server' } }));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });

  it('opens the run in Gitea on row click and Enter', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();
    const tabsCreate = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);

    render(<BuildsHistory />);
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy());

    fireEvent.click(within(screen.getByTestId('history-runs-table')).getByText('core'));
    expect(tabsCreate).toHaveBeenCalledWith({ url: RUNS[1]?.htmlUrl });

    tabsCreate.mockClear();
    const row = within(screen.getByTestId('history-runs-table'))
      .getByText('lint.yml')
      .closest('tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(tabsCreate).toHaveBeenCalledWith({ url: RUNS[2]?.htmlUrl });
  });

  it('writes filter changes to the hash and restores them from the hash on mount', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    const { unmount } = render(<BuildsHistory />);
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'historyPeriod24h' }));
    await waitFor(() => expect(window.location.hash).toContain('period=24h'));

    unmount();
    cleanup();
    loadHistory.mockClear();
    loadHistory.mockResolvedValue(loadResult());

    render(<BuildsHistory />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalled());
    expect(loadHistory.mock.calls[0]?.[0]).toMatchObject({ period: '24h' });
  });

  it('maps workflow file names to human names via the workflows:<instanceId> cache', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();
    await setWorkflowsCache(INSTANCE.id, {
      fetchedAt: new Date().toISOString(),
      names: { 'acme/platform::ci.yml': 'CI Pipeline' },
    });

    render(<BuildsHistory />);

    await waitFor(() => {
      expect(screen.getAllByText('CI Pipeline').length).toBeGreaterThan(0);
    });
    // Unmapped files fall back to the raw file name.
    expect(within(screen.getByTestId('history-runs-table')).getByText('lint.yml')).toBeTruthy();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BuildsHistory error handling (T029 H2)', () => {
  it('a rejected load shows an error (not a stuck Skeleton) and resets loading', async () => {
    loadHistory.mockRejectedValue(new Error('boom'));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => {
      expect(screen.queryByTestId('history-skeleton')).toBeNull();
      expect(screen.getByText('historyLoadError')).toBeTruthy();
    });
  });

  it('an auth (401) load failure shows ErrorState instead of the table', async () => {
    loadHistory.mockRejectedValue(new ApiError('auth', 'unauthorized', 401));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => {
      expect(screen.getByText('authError')).toBeTruthy();
      expect(screen.getByText('errorStateOpenOptions')).toBeTruthy();
    });
  });

  it('retrying after a load error calls loadHistory again', async () => {
    loadHistory.mockRejectedValueOnce(new Error('boom'));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('historyLoadError')).toBeTruthy());

    loadHistory.mockResolvedValueOnce(loadResult());
    fireEvent.click(screen.getByText('historyRetry'));

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy());
  });

  it('a rejected "показать ещё" re-enables the button and shows an error, keeping the table', async () => {
    loadHistory.mockResolvedValue(loadResult({ hasMore: true, coveredUntil: '2026-09-24T00:00:00.000Z' }));
    loadMore.mockRejectedValue(new Error('boom'));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('historyShowMore')).toBeTruthy());

    const button = screen.getByText('historyShowMore') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(loadMore).toHaveBeenCalled());
    await waitFor(() => {
      // The table is still there and the button is re-enabled.
      expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy();
      expect(screen.getByText('historyShowMore')).toBeTruthy();
      expect((screen.getByText('historyShowMore') as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText('historyLoadError')).toBeTruthy();
    });
  });

  it('an auth "показать ещё" failure shows ErrorState next to the (re-enabled) button', async () => {
    loadHistory.mockResolvedValue(loadResult({ hasMore: true, coveredUntil: '2026-09-24T00:00:00.000Z' }));
    loadMore.mockRejectedValue(new ApiError('auth', 'unauthorized', 401));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('historyShowMore')).toBeTruthy());

    fireEvent.click(screen.getByText('historyShowMore'));

    await waitFor(() => {
      expect(screen.getByText('authError')).toBeTruthy();
    });
  });

  it('ignores a stale "показать ещё" response that resolves after the period changed (L1)', async () => {
    const firstLoad = loadResult({ hasMore: true, coveredUntil: '2026-09-24T00:00:00.000Z' });
    loadHistory.mockResolvedValueOnce(firstLoad);
    const showMoreDeferred = deferred<ReturnType<typeof loadResult>>();
    loadMore.mockReturnValue(showMoreDeferred.promise);
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('historyShowMore')).toBeTruthy());

    // Start a "показать ещё" that we'll leave hanging.
    fireEvent.click(screen.getByText('historyShowMore'));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));

    // The user switches the period before it resolves — a fresh loadHistory
    // wins the race.
    const secondLoad = loadResult({
      runs: [run({ id: 99, repo: { owner: 'acme', name: 'fresh' } })],
      hasMore: false,
    });
    loadHistory.mockResolvedValueOnce(secondLoad);
    fireEvent.click(screen.getByRole('radio', { name: 'historyPeriod24h' }));
    await waitFor(() => expect(screen.getByText('fresh')).toBeTruthy());

    // The stale "показать ещё" resolves late — it must not overwrite the
    // newer (period=24h) result.
    showMoreDeferred.resolve(
      loadResult({ runs: [...RUNS, run({ id: 4 })], hasMore: false })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('fresh')).toBeTruthy();
    expect(screen.queryByText('core')).toBeNull();
  });

  it('re-reads the filter from the hash on a browser "hashchange" (M2)', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getByText('core')).toBeTruthy());

    loadHistory.mockClear();
    loadHistory.mockResolvedValue(loadResult());
    window.location.hash = '#/builds?view=history&period=24h&sort=started:desc';
    fireEvent(window, new Event('hashchange'));

    await waitFor(() => expect(loadHistory).toHaveBeenCalled());
    expect(loadHistory.mock.calls[0]?.[0]).toMatchObject({ period: '24h' });
  });

  it('does not re-trigger a load on a hashchange that matches the current filter (no write loop)', async () => {
    loadHistory.mockResolvedValue(loadResult());
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));

    // Same filter as current state (period defaults to 'today') -> no new load.
    fireEvent(window, new Event('hashchange'));
    await Promise.resolve();

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('filters "только мои" using the active instance login, not an empty string', async () => {
    loadHistory.mockResolvedValue(
      loadResult({
        runs: [
          run({ id: 10, actor: 'octocat', mine: false, repo: { owner: 'acme', name: 'a' } }),
          run({ id: 11, actor: 'other', mine: false, repo: { owner: 'acme', name: 'b' } }),
        ],
      })
    );
    await setInstances({
      instances: [{ ...INSTANCE, login: 'octocat' }],
      activeInstanceId: INSTANCE.id,
    });
    await setToken(INSTANCE.id, 'test-token');

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('b')).toBeTruthy());

    fireEvent.click(screen.getByRole('switch', { name: 'historyMineLabel' }));

    await waitFor(() => {
      expect(screen.getByText('a')).toBeTruthy();
      expect(screen.queryByText('b')).toBeNull();
    });
  });
});

describe('BuildsHistory: dirty run data (T054)', () => {
  it('renders both tabs when a run lacks branch/event/workflow/title/actor; it shows only in «Все запуски»', async () => {
    const dirty = {
      id: 201,
      attempt: 1,
      number: 201,
      repo: { owner: 'acme', name: 'dirtyrepo' },
      headSha: 'abc',
      htmlUrl: 'https://gitea.example/acme/dirtyrepo/actions/runs/201',
      state: 'success',
      startedAt: '2026-09-25T10:00:00.000Z',
      completedAt: '2026-09-25T10:05:00.000Z',
      mine: false,
      group: 'others',
    } as unknown as Run;
    const good = run({ id: 202, repo: { owner: 'acme', name: 'goodrepo' }, branch: 'test', event: 'push' });
    loadHistory.mockResolvedValue(loadResult({ runs: [dirty, good] }));
    window.location.hash = '#/builds?view=history';
    await configureInstance();
    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('goodrepo')).toBeTruthy());
    expect(table().queryByText('dirtyrepo')).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /historyTabAll/ }));
    await waitFor(() => expect(table().getByText('dirtyrepo')).toBeTruthy());
    expect(table().getByText('goodrepo')).toBeTruthy();
  });
});

describe('BuildsHistory: waiting run without startedAt (T057)', () => {
  it('shows a waiting run on page 1, at the top, with "в очереди" instead of a blank "Начат" cell', async () => {
    const started: Run[] = Array.from({ length: 59 }, (_, i) =>
      run({
        id: 300 + i,
        repo: { owner: 'acme', name: `repo${i}` },
        branch: 'main',
        event: 'push',
        state: 'success',
        startedAt: new Date(2026, 8, 25, 0, i).toISOString(),
        completedAt: new Date(2026, 8, 25, 0, i + 1).toISOString(),
      })
    );
    const waiting = run({
      id: 999,
      repo: { owner: 'acme', name: 'waitingrepo' },
      branch: 'main',
      event: 'push',
      state: 'waiting',
      startedAt: undefined,
      completedAt: undefined,
    });
    window.location.hash = '#/builds?view=history&kind=all';
    loadHistory.mockResolvedValue(loadResult({ runs: [...started, waiting] }));
    await configureInstance();
    const { container } = render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('waitingrepo')).toBeTruthy());
    // Top data row of page 1 (default sort: started desc) is the waiting run
    // (data rows are the clickable `tabIndex=0` ones; detail rows aren't).
    const dataRows = container.querySelectorAll('tbody tr[tabindex="0"]');
    const firstDataRow = dataRows[0]!;
    expect(within(firstDataRow as HTMLElement).getByText('waitingrepo')).toBeTruthy();
    expect(within(firstDataRow as HTMLElement).getByText('historyStartedQueued')).toBeTruthy();
  });
});
