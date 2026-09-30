// @vitest-environment happy-dom
// T058 — Audit of empty/error/stale states across the popup (App + tabs)
// against spec.md "Edge Cases" + FR-042/FR-072. See docs/acceptance.md
// "Аудит состояний (T058)" for the full edge-case -> test mapping; this file
// only adds tests for gaps not already covered by popup-app.test.tsx,
// repos-tab.test.tsx, prs-tab.test.tsx, builds-tab.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Instance, PullRequest, Run, Snapshot } from '../../src/domain/types';
import { setInstances, setSnapshot, setToken } from '../../src/lib/storage';

import { App } from '../../src/entrypoints/popup/App';
import { Builds } from '../../src/entrypoints/popup/tabs/Builds';
import { Prs } from '../../src/entrypoints/popup/tabs/Prs';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});

const INSTANCE: Instance = {
  id: 'i_test0001',
  baseUrl: 'https://gitea.example',
  capabilities: { actions: 'org', notifications: false, orgs: [], missingScopes: [] },
};
const TOKEN = 'test-token';

async function configureInstance(instance: Instance = INSTANCE): Promise<void> {
  await setInstances({ instances: [instance], activeInstanceId: instance.id });
  await setToken(instance.id, TOKEN);
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

describe('App: configured tri-state (no flash before the unconfigured check)', () => {
  it('renders no tabs and no "unconfigured" message while the active instance/token check is still in flight', async () => {
    // configureInstance() resolves storage reads asynchronously (a real
    // microtask, not pre-resolved), so right after render() the check has not
    // settled yet — this is the gap: `configured` used to default to `true`
    // (optimistic), so the tab bar rendered immediately here.
    await configureInstance();

    render(<App />);

    // Assert synchronously, before flushing the pending microtasks.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('popupUnconfigured')).toBeNull();

    // It does resolve shortly after, to the configured view.
    await waitFor(() => {
      expect(screen.getByRole('tablist')).toBeTruthy();
    });
  });

  it('renders no tabs and no "unconfigured" message while in flight, then settles to unconfigured', async () => {
    // No instance configured at all -> eventually unconfigured, but not
    // synchronously on first render.
    render(<App />);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('popupUnconfigured')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('popupUnconfigured')).toBeTruthy();
    });
  });
});

describe('App: Gitea unreachable -> last known data stays visible next to Stale', () => {
  it('keeps showing PR tab content (not replaced by an error) alongside the Stale banner on a network error', async () => {
    await configureInstance();
    await setSnapshot(
      INSTANCE.id,
      baseSnapshot({
        error: { kind: 'network', at: new Date().toISOString() },
        prs: [pr({ id: 1, group: 'review', title: 'Review me' })],
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('staleMessage')).toBeTruthy();
    });
    // Non-auth errors must not blank out the last known data (FR-042).
    fireEvent.keyDown(window, { key: '2', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('Review me')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('App: one missing capability degrades only its own tab', () => {
  it('shows a forbidden ErrorState only in Builds while Repos/PRs keep working (actions forbidden)', async () => {
    const forbiddenInstance: Instance = {
      ...INSTANCE,
      capabilities: { actions: 'forbidden', notifications: false, orgs: [], missingScopes: [] },
    };
    await configureInstance(forbiddenInstance);
    await setSnapshot(
      forbiddenInstance.id,
      baseSnapshot({ prs: [pr({ id: 1, group: 'review', title: 'Review me' })] })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('tablist')).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: '2', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('Review me')).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: '3', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('buildsForbidden')).toBeTruthy();
    });
  });
});

describe('App: baseUrl/instance change does not mix cached data', () => {
  it('shows only the newly active instance\'s snapshot after the connection changes, never the previous one\'s', async () => {
    const instanceA: Instance = { ...INSTANCE, id: 'i_aaaaaaa1', baseUrl: 'https://a.example' };
    const instanceB: Instance = { ...INSTANCE, id: 'i_bbbbbbb1', baseUrl: 'https://b.example' };

    await configureInstance(instanceA);
    await setSnapshot(instanceA.id, baseSnapshot({ prs: [pr({ id: 1, group: 'review', title: 'PR on A' })] }));

    const first = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('tablist')).toBeTruthy();
    });
    first.unmount();

    // Simulate the user reconnecting to a different Gitea instance, with its
    // own (disjoint) cached snapshot.
    await configureInstance(instanceB);
    await setSnapshot(instanceB.id, baseSnapshot({ prs: [pr({ id: 2, group: 'review', title: 'PR on B' })] }));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('tablist')).toBeTruthy();
    });
    fireEvent.keyDown(window, { key: '2', altKey: true });

    await waitFor(() => {
      expect(screen.getByText('PR on B')).toBeTruthy();
    });
    expect(screen.queryByText('PR on A')).toBeNull();
  });
});

describe('App + Builds: popup open for 30 minutes leaks no timers or storage listeners', () => {
  it('keeps the active timer count bounded over 30 minutes and returns to 0 after unmount; storage.onChanged listeners balance on unmount', async () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(browser.storage.onChanged, 'addListener');
    const removeSpy = vi.spyOn(browser.storage.onChanged, 'removeListener');

    await configureInstance();
    const running = makeRun({ id: 1, group: 'mine', state: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    await setSnapshot(INSTANCE.id, baseSnapshot({ runs: [running] }));

    const { unmount } = render(<App />);

    // Flush the pending storage-read microtasks (App's mount effect) without
    // relying on testing-library's setTimeout-based waitFor, which does not
    // advance under fake timers.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('tablist')).toBeTruthy();

    fireEvent.keyDown(window, { key: '3', altKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('option')).toBeTruthy();

    const countsOverTime: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      countsOverTime.push(vi.getTimerCount());
    }

    // Bounded: no unbounded growth across 30 one-minute ticks (only the
    // 1s duration tick + 5s heartbeat may be live at any instant).
    const max = Math.max(...countsOverTime);
    const min = Math.min(...countsOverTime);
    expect(max - min).toBeLessThanOrEqual(1);
    expect(max).toBeLessThanOrEqual(2);

    expect(addSpy.mock.calls.length).toBeGreaterThan(0);
    // Not unmounted yet: no removals should have happened just from ticking.
    expect(removeSpy.mock.calls.length).toBe(0);

    unmount();

    // All listeners registered by App (snapshot + settings subscriptions)
    // must be removed again on unmount.
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
    // No timer survives unmount (heartbeat + duration tick both cleared).
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);
});

describe('Builds tab: a run without a branch/workflow name stays readable', () => {
  it('renders a manual/scheduled run with no branch as a dash, not "undefined"/blank row', () => {
    const manual = makeRun({
      id: 5,
      group: 'mine',
      workflow: '',
      branch: undefined,
      event: 'schedule',
      state: 'success',
    });

    render(<Builds snapshot={baseSnapshot({ runs: [manual] })} />);

    const option = screen.getByRole('option');
    expect(option.textContent).not.toContain('undefined');
    expect(option.textContent).toContain('—');
    expect(option.textContent).toContain('schedule');
    expect(option.textContent).toContain('acme/core');
  });
});

function baseSnapshotRuns(runs: Run[]): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: [],
    runs,
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

describe('Builds tab: many runs stay internally scrollable (window stays responsive)', () => {
  // T082: the popup scrolls as a whole inside the tab body (App.tsx's
  // TabsContent — `min-h-0 flex-1 overflow-y-auto`), not inside each
  // individual group's List (which would otherwise double-scroll). This
  // renders Builds inside a stand-in for that tab-body scroll container and
  // asserts the container itself — not the listbox — is the bounded,
  // overflow-y:auto element, while every row still renders inside it (i.e.
  // is reachable by scrolling that one container, not clipped/lost).
  it('caps the tab body height and scrolls internally instead of growing unbounded', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      makeRun({ id: i + 1, group: 'mine', title: `run-${i}` })
    );

    const { container } = render(
      <div className="min-h-0 max-h-[580px] flex-1 overflow-y-auto">
        <Builds snapshot={baseSnapshotRuns(many)} />
      </div>
    );

    const scrollContainer = container.firstElementChild as HTMLElement;
    expect(scrollContainer.className).toContain('overflow-y-auto');
    expect(scrollContainer.className).toMatch(/max-h-\[/);

    // The group's own listbox no longer imposes a second, nested scroll area.
    const listbox = screen.getByRole('listbox', { name: 'buildsGroupMine' });
    expect(listbox.style.maxHeight).toBe('none');

    // All 50 rows are present in the (single) scroll container, not clipped.
    expect(scrollContainer.contains(listbox)).toBe(true);
    expect(screen.getAllByRole('option')).toHaveLength(50);
  });
});

describe('PRs tab: fork/no-checks/draft PR stays readable', () => {
  it('shows a draft PR with no CI checks with both the draft badge and the "no checks" status, no crash', () => {
    const forkPr = pr({
      id: 9,
      group: 'review',
      title: 'Fork contribution',
      draft: true,
      ci: { state: 'none', fetchedAt: '2024-01-01T00:00:00.000Z' },
    });

    render(<Prs snapshot={{ ...baseSnapshot(), prs: [forkPr] }} />);

    const option = screen.getByText('Fork contribution').closest('[role="option"]') as HTMLElement;
    expect(option.textContent).toContain('prsDraftBadge');
    expect(option.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('statusNone');
  });
});
