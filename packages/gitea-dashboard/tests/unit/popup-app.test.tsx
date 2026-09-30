// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Instance, Snapshot } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';
import {
  getUiState,
  setInstances,
  setSettings,
  setSnapshot,
  setToken,
  setUiState,
} from '../../src/lib/storage';

vi.mock('../../src/background/open-dashboard', () => ({
  openDashboard: vi.fn().mockResolvedValue(undefined),
}));

import { App } from '../../src/entrypoints/popup/App';
import { openDashboard } from '../../src/background/open-dashboard';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  fakeBrowser.reset();
  // fakeBrowser has no in-memory i18n implementation; make t() fall back to
  // returning the key itself (see src/lib/i18n.ts), matching other tests.
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  vi.mocked(openDashboard).mockClear();
  vi.mocked(openDashboard).mockResolvedValue(undefined);
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

function pr(overrides: Partial<import('../../src/domain/types').PullRequest> = {}) {
  return {
    id: 1,
    repo: { owner: 'acme', name: 'core' },
    number: 42,
    title: 'Fix the thing',
    author: 'octocat',
    updatedAt: '2024-01-01T00:00:00.000Z',
    htmlUrl: 'https://gitea.example/acme/core/pulls/42',
    draft: false,
    group: 'review' as const,
    ci: { state: 'success' as const, fetchedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

describe('popup App', () => {
  it('restores the last active tab from ui.lastTab', async () => {
    await configureInstance();
    await setUiState({ lastTab: 'builds', othersCollapsed: false });

    render(<App />);

    await waitFor(() => {
      const tab = screen.getByText('tabBuilds').closest('[role="tab"]');
      expect(tab?.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('defaults to the repos tab when nothing is stored', async () => {
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      const tab = screen.getByText('tabRepos').closest('[role="tab"]');
      expect(tab?.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('switches to the PR tab on Alt+2 and persists lastTab', async () => {
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });

    fireEvent.keyDown(window, { key: '2', altKey: true });

    await waitFor(() => {
      const tab = screen.getByText('tabPrs').closest('[role="tab"]');
      expect(tab?.getAttribute('aria-selected')).toBe('true');
    });

    await waitFor(async () => {
      expect((await getUiState()).lastTab).toBe('prs');
    });
  });

  it('renders Stale when the active snapshot has an error', async () => {
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

  it('does not render Stale when the active snapshot has no error', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos')).toBeTruthy();
    });
    expect(screen.queryByText('staleMessage')).toBeNull();
  });

  it('sends a refresh message on mount', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    render(<App />);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ type: 'refresh', reason: 'popup-open' });
    });
  });

  it('updates the view when the snapshot changes in storage', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos')).toBeTruthy();
    });
    expect(screen.queryByText('staleMessage')).toBeNull();

    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({ error: { kind: 'auth', at: new Date().toISOString() } })
    );

    await waitFor(() => {
      expect(screen.getByText('staleMessage')).toBeTruthy();
    });
  });

  it('unsubscribes from snapshot changes on unmount', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot());

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos')).toBeTruthy();
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

  it('shows the unconfigured view and hides tabs when there is no active instance', async () => {
    const openOptions = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('popupUnconfigured')).toBeTruthy();
    });
    expect(screen.queryByRole('tablist')).toBeNull();

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
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows an auth ErrorState instead of tab content in every tab', async () => {
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
    expect(screen.queryByText('tabPlaceholder')).toBeNull();

    fireEvent.keyDown(window, { key: '2', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('tabPrs').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.keyDown(window, { key: '3', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('tabBuilds').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('passes the stored snapshot to the PR tab', async () => {
    await configureInstance();
    await setSnapshot(INSTANCE.id, baseSnapshot({ prs: [pr({ id: 1, group: 'review', title: 'Review me' })] }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    fireEvent.keyDown(window, { key: '2', altKey: true });

    await waitFor(() => {
      expect(screen.getByText('Review me')).toBeTruthy();
    });
  });

  it('passes the active instance capabilities to the Builds tab', async () => {
    const unsupportedInstance: Instance = {
      ...INSTANCE,
      capabilities: { actions: 'unsupported', notifications: false, orgs: [], missingScopes: [] },
    };
    await setInstances({ instances: [unsupportedInstance], activeInstanceId: unsupportedInstance.id });
    await setToken(unsupportedInstance.id, TOKEN);
    await setSnapshot(unsupportedInstance.id, baseSnapshot());

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    fireEvent.keyDown(window, { key: '3', altKey: true });

    await waitFor(() => {
      expect(screen.getByText('buildsUnsupported')).toBeTruthy();
    });
  });

  it('hides "Остальные" in the PR tab live when settings.showOtherPrs changes in storage, without remounting', async () => {
    await configureInstance();
    await setSettings({ ...DEFAULT_SETTINGS, showOtherPrs: true });
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({
        prs: [
          pr({ id: 1, group: 'review', title: 'Review me' }),
          pr({ id: 2, group: 'other', title: 'Someone elses PR' }),
        ],
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });
    fireEvent.keyDown(window, { key: '2', altKey: true });

    // The group header is canonical shadcn markup — muted uppercase title
    // text plus a *separate* `Badge variant="secondary"` for the count — so
    // query the heading by its accessible name (which aggregates the title
    // + badge text) and check the title/count independently instead of one
    // concatenated "title (N)" string.
    await waitFor(() => {
      const heading = screen.getByRole('heading', { name: /prsGroupOther/ });
      expect(heading.textContent).toContain('prsGroupOther');
      expect(within(heading).getByText('1')).toBeTruthy();
    });

    await setSettings({ ...DEFAULT_SETTINGS, showOtherPrs: false });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /prsGroupOther/ })).toBeNull();
    });
    // Still the PR tab, no remount: the review group is untouched.
    expect(screen.getByText('Review me')).toBeTruthy();
  });

  it('shows count badges on the PR and Builds tabs (reviews / active-mine)', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({
        counts: { reviews: 12, activeMine: 3, activeOthers: 0, failedOthers: 0 },
      })
    );

    render(<App />);

    await waitFor(() => {
      const prTab = screen.getByText('tabPrs').closest('[role="tab"]') as HTMLElement;
      expect(within(prTab).getByText('12')).toBeTruthy();
    });
    const buildsTab = screen.getByText('tabBuilds').closest('[role="tab"]') as HTMLElement;
    expect(within(buildsTab).getByText('3')).toBeTruthy();
  });

  it('shows the "open in tab" button when configured', async () => {
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('popupOpenInTab')).toBeTruthy();
    });
  });

  it('has a native title attribute on the "open in tab" and settings buttons (no Radix Tooltip)', async () => {
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('popupOpenInTab').getAttribute('title')).toBe('popupOpenInTab');
    });
    expect(screen.getByLabelText('popupSettingsButton').getAttribute('title')).toBe('popupSettingsButton');
  });

  it('shows the "open in tab" button when the active snapshot has an auth error', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({ error: { kind: 'auth', at: new Date().toISOString() } })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('popupOpenInTab')).toBeTruthy();
    });
  });

  it('hides the "open in tab" button when there is no configured instance', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('popupUnconfigured')).toBeTruthy();
    });
    expect(screen.queryByLabelText('popupOpenInTab')).toBeNull();
  });

  it('opens the dashboard for the current tab and closes the popup on click', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('popupOpenInTab')).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: '2', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('tabPrs').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });

    fireEvent.click(screen.getByLabelText('popupOpenInTab'));

    await waitFor(() => {
      expect(openDashboard).toHaveBeenCalledWith('prs');
    });
    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  it('keeps the popup open and does not throw when openDashboard rejects', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.mocked(openDashboard).mockRejectedValueOnce(new Error('no active tab'));
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('popupOpenInTab')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('popupOpenInTab'));

    await waitFor(() => {
      expect(openDashboard).toHaveBeenCalledWith('repos');
    });
    // Give the rejected promise a tick to (not) surface as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeSpy).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('calls setUiState with only the changed field when switching tabs (no stale read-modify-write)', async () => {
    const setUiStateSpy = vi.spyOn(storage, 'setUiState');
    await configureInstance();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('tabRepos').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe(
        'true'
      );
    });

    fireEvent.keyDown(window, { key: '2', altKey: true });

    await waitFor(() => {
      expect(setUiStateSpy).toHaveBeenCalledWith({ lastTab: 'prs' });
    });
  });
});
