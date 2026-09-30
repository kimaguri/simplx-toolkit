// @vitest-environment happy-dom
// T035 (US6): "Этап" column + row expand (jobs/steps) in BuildsHistory, and
// the periodic refresh hook that drives it (`use-run-stages.ts`).
// Contract: spec.md US6 scenarios 1-4, research.md R9, tasks.md T035.
//
// `run-jobs.ts`'s loader is mocked (its own behavior is covered by
// tests/integration/run-jobs.test.ts, T033); `currentStage` is left as the
// real (pure) implementation via `importOriginal`.
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Run } from '../../src/domain/types';
import { setInstances, setToken } from '../../src/lib/storage';
import runJobsFixture from '../fixtures/run-jobs.json';

const load = vi.fn();
const loadOne = vi.fn();

vi.mock('../../src/features/builds/run-jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/builds/run-jobs')>();
  return {
    ...actual,
    createRunJobsLoader: () => ({
      load: (...args: unknown[]) => load(...args),
      loadOne: (...args: unknown[]) => loadOne(...args),
      get: () => undefined,
    }),
  };
});

const loadHistory = vi.fn();
const loadMore = vi.fn();

vi.mock('../../src/features/builds/history-loader', () => ({
  loadHistory: (...args: unknown[]) => loadHistory(...args),
  loadMore: (...args: unknown[]) => loadMore(...args),
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
  window.location.hash = '';
  load.mockReset();
  load.mockResolvedValue(new Map());
  loadOne.mockReset();
  loadHistory.mockReset();
  loadMore.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    state: 'running',
    startedAt: '2026-09-28T09:00:00.000Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

function loadResult(overrides: Record<string, unknown> = {}) {
  return {
    runs: [],
    coveredUntil: '2026-09-20T00:00:00.000Z',
    hasMore: false,
    requests: 1,
    ...overrides,
  };
}

describe('BuildsHistory "Этап" column (T035)', () => {
  it('shows the current stage text for a running row', async () => {
    const runningRun = run({ id: 1, attempt: 1, state: 'running' });
    load.mockResolvedValue(new Map([['1:1', { jobs: runJobsFixture.jobs }]]));
    loadHistory.mockResolvedValue(loadResult({ runs: [runningRun] }));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => expect(screen.getByText('build › Compile · 3/7')).toBeTruthy());
  });

  it('shows "этап недоступен" (buildsStageUnavailable) when the loader marks the run unavailable', async () => {
    const runningRun = run({ id: 2, attempt: 1, state: 'running' });
    load.mockResolvedValue(new Map([['2:1', { unavailable: true }]]));
    loadHistory.mockResolvedValue(loadResult({ runs: [runningRun] }));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => expect(screen.getByText('buildsStageUnavailable')).toBeTruthy());
  });

  it('shows "—" for a completed (non-active) row', async () => {
    const completedRun = run({ id: 3, attempt: 1, state: 'success', completedAt: '2026-09-28T09:05:00.000Z' });
    loadHistory.mockResolvedValue(loadResult({ runs: [completedRun] }));
    await configureInstance();

    render(<BuildsHistory />);

    const table = await waitFor(() => screen.getByTestId('history-runs-table'));
    await waitFor(() => expect(within(table).getByText('platform')).toBeTruthy());
    const row = within(table).getByText('platform').closest('tr') as HTMLElement;
    expect(within(row).getByText('—', { selector: 'td' })).toBeTruthy();
  });

  it('expands a running row to show jobs and steps, with the current step highlighted', async () => {
    const runningRun = run({ id: 1, attempt: 1, state: 'running' });
    load.mockResolvedValue(new Map([['1:1', { jobs: runJobsFixture.jobs }]]));
    loadHistory.mockResolvedValue(loadResult({ runs: [runningRun] }));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByText('build › Compile · 3/7')).toBeTruthy());

    const toggle = screen.getByRole('button', { name: 'buildsStageToggle' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await waitFor(() => expect(screen.getByText('lint')).toBeTruthy());
    expect(screen.getByText('build')).toBeTruthy();
    expect(screen.getAllByText('Checkout').length).toBeGreaterThan(0);

    const currentStepRow = screen.getByText('Compile').closest('li') as HTMLElement;
    expect(currentStepRow.className).toMatch(/bg-accent\/50/);

    const otherStepRow = screen.getAllByText('Install')[0]?.closest('li') as HTMLElement;
    expect(otherStepRow.className).not.toMatch(/bg-accent\/50/);
  });

  it('expanding a completed run triggers loadOne exactly once', async () => {
    const completedRun = run({ id: 5, attempt: 1, state: 'success', completedAt: '2026-09-28T09:05:00.000Z' });
    loadOne.mockResolvedValue({ jobs: runJobsFixture.jobs });
    loadHistory.mockResolvedValue(loadResult({ runs: [completedRun] }));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'buildsStageToggle' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'buildsStageToggle' }));

    await waitFor(() => expect(loadOne).toHaveBeenCalledTimes(1));
    expect(loadOne.mock.calls[0]?.[0]).toMatchObject({ id: 5, attempt: 1 });

    await waitFor(() => expect(screen.getByText('lint')).toBeTruthy());
  });

  // T042 M1: once `load()`/`loadOne` reports every job completed, the row's
  // icon reflects the derived outcome, not the (stale) `run.state`.
  it('renders the derived final state on the StatusIcon once jobs are all completed (T042 M1)', async () => {
    const stillRunningRun = run({ id: 7, attempt: 1, state: 'running' });
    load.mockResolvedValue(
      new Map([['7:1', { jobs: runJobsFixture.jobs, finalState: 'failure' }]])
    );
    loadHistory.mockResolvedValue(loadResult({ runs: [stillRunningRun] }));
    await configureInstance();

    render(<BuildsHistory />);

    const table = await waitFor(() => screen.getByTestId('history-runs-table'));
    await waitFor(() => expect(within(table).getByText('platform')).toBeTruthy());
    const row = within(table).getByText('platform').closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('img', { name: 'statusFailure' })).toBeTruthy());
  });

  // T042 M3: a row with no cached jobs at all (e.g. an active run beyond the
  // periodic loader's top-10) must call loadOne on expand too, not only
  // completed runs.
  it('expanding an active row with no cached jobs yet calls loadOne (T042 M3)', async () => {
    const activeRun = run({ id: 8, attempt: 1, state: 'running' });
    load.mockResolvedValue(new Map()); // beyond top-10: load() never touched this run
    loadOne.mockResolvedValue({ jobs: runJobsFixture.jobs });
    loadHistory.mockResolvedValue(loadResult({ runs: [activeRun] }));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'buildsStageToggle' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'buildsStageToggle' }));

    await waitFor(() => expect(loadOne).toHaveBeenCalledTimes(1));
    expect(loadOne.mock.calls[0]?.[0]).toMatchObject({ id: 8, attempt: 1 });
  });

  // T042 LOW: a completed run whose only cached entry is a stale
  // "in progress" snapshot from load() (fetched back when it was still
  // active) must show the loading state, not that stale data, until
  // loadOne's fresh answer comes back.
  it('expanding a completed run hides a stale in-progress snapshot until loadOne resolves (T042 LOW)', async () => {
    const completedRun = run({ id: 9, attempt: 1, state: 'success', completedAt: '2026-09-28T09:05:00.000Z' });
    // Simulate: this run was fetched by load() while still active, before
    // BuildsHistory's periodic refresh noticed it had finished.
    load.mockResolvedValue(new Map([['9:1', { jobs: runJobsFixture.jobs }]]));
    let resolveLoadOne: (value: unknown) => void = () => {};
    loadOne.mockReturnValue(
      new Promise((resolve) => {
        resolveLoadOne = resolve;
      })
    );
    loadHistory.mockResolvedValue(loadResult({ runs: [completedRun] }));
    await configureInstance();

    render(<BuildsHistory />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'buildsStageToggle' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'buildsStageToggle' }));

    await waitFor(() => expect(loadOne).toHaveBeenCalledTimes(1));
    // Stale jobs from `load()` must not be shown while loadOne is pending.
    expect(screen.queryByText('lint')).toBeNull();
    expect(screen.getByText('buildsStageLoading')).toBeTruthy();

    resolveLoadOne({ jobs: runJobsFixture.jobs });
    await waitFor(() => expect(screen.getByText('lint')).toBeTruthy());
  });
});

describe('useRunStages refresh interval (T035)', () => {
  it('refreshes via load() on mount and every 20s while visible, and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    loadHistory.mockResolvedValue(loadResult({ runs: [] }));
    await configureInstance();

    const { unmount } = render(<BuildsHistory />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = load.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(load.mock.calls.length).toBeGreaterThan(callsAfterMount);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  // T042 M2: no refresh at all (not even the mount-time one) while hidden.
  it('never calls load() while the tab is hidden, including the initial refresh', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    loadHistory.mockResolvedValue(loadResult({ runs: [] }));
    await configureInstance();

    const { unmount } = render(<BuildsHistory />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });

    expect(load).not.toHaveBeenCalled();
    unmount();
    setVisibility('visible');
  });

  // T042 M2: regaining visibility triggers an immediate refresh, not just
  // the next 20s tick.
  it('refreshes immediately when the tab becomes visible again', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    loadHistory.mockResolvedValue(loadResult({ runs: [] }));
    await configureInstance();

    const { unmount } = render(<BuildsHistory />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);

    unmount();
  });

  // T042 M2: a slow in-flight load() must not overlap with a concurrent
  // visibilitychange-triggered refresh — only one call is in flight at once.
  it('never overlaps a second load() while one is still in flight', async () => {
    vi.useFakeTimers();
    loadHistory.mockResolvedValue(loadResult({ runs: [] }));
    let resolveLoad: (value: unknown) => void = () => {};
    load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    await configureInstance();

    const { unmount } = render(<BuildsHistory />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);

    // Tab hides then comes back while the first load() is still pending —
    // must not start a second overlapping call.
    setVisibility('hidden');
    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad(new Map());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    setVisibility('hidden');
    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(2);

    unmount();
  });
});
