// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Instance, PullRequest, Run, Snapshot } from '../../src/domain/types';
import { getUiState, setInstances, setSnapshot, setToken, setUiState } from '../../src/lib/storage';

// BuildsHistory (always rendered by the Builds section now, T041 re-scope)
// fetches via history-loader.ts directly -- mocked here the same way
// tests/unit/builds-history.test.tsx does, so tests below don't depend on
// network access.
const loadHistory = vi.fn();
const loadMore = vi.fn();
vi.mock('../../src/features/builds/history-loader', () => ({
  loadHistory: (...args: unknown[]) => loadHistory(...args),
  loadMore: (...args: unknown[]) => loadMore(...args),
}));

import { App } from '../../src/entrypoints/dashboard/App';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  fakeBrowser.reset();
  // fakeBrowser has no in-memory i18n implementation; make t() fall back to
  // returning the key itself (see src/lib/i18n.ts), matching other tests.
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  window.location.hash = '';
  // Default: an empty, resolved history load -- tests that specifically
  // exercise the Builds section's rendered content override this.
  loadHistory.mockResolvedValue({ runs: [], coveredUntil: undefined, hasMore: false, requests: 1 });
  loadMore.mockResolvedValue({ runs: [], coveredUntil: undefined, hasMore: false, requests: 1 });
});

const INSTANCE: Instance = {
  id: 'i_test0001',
  baseUrl: 'https://gitea.example',
  capabilities: { actions: 'org', notifications: false, orgs: [], missingScopes: [] },
};

const TOKEN = 'test-token';

async function configureInstance(): Promise<void> {
  await setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await setToken(INSTANCE.id, TOKEN);
}

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: [],
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'core' },
    number: 42,
    title: 'Fix the thing',
    author: 'octocat',
    updatedAt: '2024-01-01T00:00:00.000Z',
    htmlUrl: 'https://gitea.example/acme/core/pulls/42',
    draft: false,
    group: 'review',
    ci: { state: 'success', fetchedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'core' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'abc123',
    htmlUrl: 'https://gitea.example/acme/core/actions/runs/1',
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

describe('dashboard App', () => {
  it('shows the unconfigured view and no shell when there is no active instance', async () => {
    const openOptions = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('popupUnconfigured')).toBeTruthy();
    });
    expect(screen.queryByText('dashboardTitle')).toBeNull();

    fireEvent.click(screen.getByText('errorStateOpenOptions'));
    expect(openOptions).toHaveBeenCalled();
  });

  it('shows the unconfigured view when the active instance has no token', async () => {
    await setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
    // Deliberately not setting a token for the instance.

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('popupUnconfigured')).toBeTruthy();
    });
    expect(screen.queryByText('dashboardTitle')).toBeNull();
  });

  it('does not flash the shell while the configured check is in flight', async () => {
    await configureInstance();

    const { container } = render(<App />);

    // Nothing (no header, no unconfigured message) should be visible
    // synchronously, before the async instance/token check resolves.
    expect(screen.queryByText('dashboardTitle')).toBeNull();
    expect(screen.queryByText('popupUnconfigured')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });
  });

  it('shows an auth ErrorState full-width when the snapshot has an auth error', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({ error: { kind: 'auth', at: new Date().toISOString() } })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('authError')).toBeTruthy();
    });
  });

  it('renders the header title when configured', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });
  });

  it('T048 L7: follows a change of the active instance (snapshot of the new one)', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());
    const other: Instance = { ...INSTANCE, id: 'i_test0002' };
    await setToken(other.id, TOKEN);
    await setSnapshot(other.id, baseSnapshot({ error: { kind: 'auth', at: new Date().toISOString() } }));

    render(<App />);
    await waitFor(() => expect(screen.getByText('dashboardTitle')).toBeTruthy());
    expect(screen.queryByText('authError')).toBeNull();

    await setInstances({ instances: [INSTANCE, other], activeInstanceId: other.id });
    await waitFor(() => expect(screen.getByText('authError')).toBeTruthy());
  });

  it('unsubscribes from snapshot changes on unmount', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    unmount();

    // Must not throw when the snapshot changes after unmount.
    await expect(
      setSnapshot(
        INSTANCE.id,
        baseSnapshot({ error: { kind: 'server', at: new Date().toISOString() } })
      )
    ).resolves.not.toThrow();
  });

  // T011 (US2): navigation, hash routing, Alt+1..3, refresh-on-open and the
  // visibility-gated heartbeat, plus a same-data-as-popup regression check.

  it('clicking a nav item updates the hash and persists ui.lastPageSection', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /tabBuilds/ }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/builds');
    });
    await waitFor(async () => {
      expect((await getUiState()).lastPageSection).toBe('builds');
    });
  });

  it('switches the section on hashchange (browser back/forward)', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());
    window.location.hash = '#/prs';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tabPrs/ }).getAttribute('data-active')).toBe('true');
    });

    window.location.hash = '#/builds';
    fireEvent(window, new Event('hashchange'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tabBuilds/ }).getAttribute('data-active')).toBe('true');
    });
  });

  it('switches sections via Alt+1..3', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: '3', altKey: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tabBuilds/ }).getAttribute('data-active')).toBe('true');
    });

    fireEvent.keyDown(window, { key: '1', altKey: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tabRepos/ }).getAttribute('data-active')).toBe('true');
    });
  });

  it('sends refresh exactly once on mount', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    const refreshCalls = sendMessage.mock.calls.filter(
      (call) => (call[0] as unknown as { type: string }).type === 'refresh'
    );
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.[0]).toEqual({ type: 'refresh', reason: 'popup-open' });
  });

  it('sends popup-heartbeat every 5s only while visible, and never after unmount', async () => {
    vi.useFakeTimers();
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    const { unmount } = render(<App />);

    // Flush the pending storage-read microtasks (App's mount effects) without
    // relying on testing-library's setTimeout-based waitFor, which does not
    // advance under fake timers (see popup-states.test.tsx).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('dashboardTitle')).toBeTruthy();

    sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(
      sendMessage.mock.calls.filter((c) => (c[0] as unknown as { type: string }).type === 'popup-heartbeat')
    ).toHaveLength(1);
    // T043: the page marks its heartbeat so the background may run page-fast.
    expect(
      sendMessage.mock.calls.find((c) => (c[0] as unknown as { type: string }).type === 'popup-heartbeat')?.[0]
    ).toMatchObject({ page: true });

    // Tab hidden: no more heartbeats.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessage).not.toHaveBeenCalled();

    // Tab visible again: heartbeats resume.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      sendMessage.mock.calls.some((c) => (c[0] as unknown as { type: string }).type === 'popup-heartbeat')
    ).toBe(true);

    unmount();
    sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  it('navigating to the already-open section is a hash no-op (keeps view/filter params)', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());
    window.location.hash = '#/prs?view=table&ci=failure';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tabPrs/ }).getAttribute('data-active')).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: /tabPrs/ }));

    // Not a real navigation (already on "prs") -- the hash (view + filter
    // params) must be left untouched.
    expect(window.location.hash).toBe('#/prs?view=table&ci=failure');
  });

  // M3 — a non-auth snapshot error shows the <Stale> banner under the
  // header, same as the popup; an auth error keeps showing the full-width
  // ErrorState instead (no double banner).

  it('shows the Stale banner on a non-auth snapshot error', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({ error: { kind: 'network', at: new Date().toISOString() } })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('staleMessage')).toBeTruthy();
    });
  });

  it('does not show the Stale banner on an auth snapshot error', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({ error: { kind: 'auth', at: new Date().toISOString() } })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('authError')).toBeTruthy();
    });
    expect(screen.queryByText('staleMessage')).toBeNull();
  });


  // T031 (T025 defect, spec.md FR-109 / quickstart P10: "горизонтальной
  // прокрутки страницы нет"): the content column must stay shrinkable
  // (min-w-0) so a wide child (e.g. the PR table) can never force the
  // whole flex row -- and therefore the page -- wider than the viewport;
  // any horizontal scrolling must stay scoped to that child's own
  // overflow-x-auto container (see prs-table.test.tsx).
  it('keeps the main content column shrinkable so it cannot force page-level horizontal scroll (FR-109)', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    const main = document.querySelector('main');
    expect(main?.className).toContain('min-w-0');
  });


  it('the sidebar trigger collapses and expands the sidebar (data-state), and nav items keep switching sections', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');

    fireEvent.click(document.querySelector('[data-slot="sidebar-trigger"]') as HTMLElement);

    await waitFor(() => {
      expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    });

    // Nav items still switch sections while collapsed.
    fireEvent.click(screen.getByRole('button', { name: /tabBuilds/ }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/builds');
    });

    fireEvent.click(document.querySelector('[data-slot="sidebar-trigger"]') as HTMLElement);
    await waitFor(() => {
      expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    });
  });

  it('persists the sidebar collapsed state to ui.sidebarOpen and restores it on remount', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    fireEvent.click(document.querySelector('[data-slot="sidebar-trigger"]') as HTMLElement);

    await waitFor(async () => {
      expect((await getUiState()).sidebarOpen).toBe(false);
    });

    unmount();
    cleanup();

    render(<App />);

    await waitFor(() => {
      const sidebar = document.querySelector('[data-slot="sidebar"]');
      expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    });
  });

  // T041 re-scope: the Группы/Таблица and Группы/История toggles are gone
  // -- the page always shows the PR table and the Builds history list.

  function mockMatchMedia(matches: boolean): void {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null,
        }) as unknown as MediaQueryList
    );
  }

  it('always renders the PR table (no view toggle) regardless of the hash', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot({ prs: [pr()] }));
    // An old `view=groups` hash (e.g. a stale bookmark) is simply ignored.
    window.location.hash = '#/prs?view=groups';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('prsColTitle')).toBeTruthy();
    });
    expect(screen.queryByText('prsViewGroups')).toBeNull();
    expect(screen.queryByText('prsViewTable')).toBeNull();
  });

  it('always renders the Builds history list (no view toggle) regardless of the hash', async () => {
    loadHistory.mockResolvedValue({ runs: [run()], coveredUntil: undefined, hasMore: false, requests: 1 });
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot({ runs: [run()] }));
    window.location.hash = '#/builds?view=groups';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('history-runs-table')).toBeTruthy();
    });
    expect(screen.queryByText('buildsViewGroups')).toBeNull();
    expect(screen.queryByText('buildsViewHistory')).toBeNull();
  });

  it('the page content container has no max-w-6xl cap (fills the available width)', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    const main = document.querySelector('main');
    expect(main?.innerHTML).not.toContain('max-w-6xl');
  });

  it('the Репо section on the page fills the available height (flex-1/min-h-0 list container)', async () => {
    await configureInstance();
    window.location.hash = '#/repos';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('reposSearchPlaceholder')).toBeTruthy();
    });

    const fillEl = document.querySelector('.flex.min-h-0.flex-1.flex-col');
    expect(fillEl).toBeTruthy();
  });

  // H2 (T041): the desktop sidebar only mounts at >=1024px (matchMedia);
  // narrower viewports mount the bottom Tabs bar instead of the sidebar --
  // never both at once.

  it('at 900px: no sidebar, the Tabs nav is present', async () => {
    mockMatchMedia(false);
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
  });

  it('at 1280px: the sidebar is present, the Tabs nav is not', async () => {
    mockMatchMedia(true);
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="sidebar"]')).toBeTruthy();
    });
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  // T041 follow-up: a user's own sidebar toggle right after mount must not
  // be clobbered by the (possibly slow) ui.sidebarOpen load.

  it('a sidebar toggle right after mount wins over a slow ui.sidebarOpen load, and is persisted', async () => {
    const realGet = browser.storage.local.get.bind(browser.storage.local);
    vi.spyOn(browser.storage.local, 'get').mockImplementation(
      (...args: Parameters<typeof browser.storage.local.get>) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(realGet(...args)), 20);
        })
    );

    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('dashboardTitle')).toBeTruthy();
    });

    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');

    // User toggles before the delayed ui.sidebarOpen load below resolves.
    fireEvent.click(document.querySelector('[data-slot="sidebar-trigger"]') as HTMLElement);
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');

    // Give the delayed storage read (and any load-triggered state update)
    // plenty of time to resolve; the user's choice must still stand.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    expect((await getUiState()).sidebarOpen).toBe(false);
  });
});
