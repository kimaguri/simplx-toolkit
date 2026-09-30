// @vitest-environment happy-dom
// T058: BuildsHistory no longer only loads on mount/filter change — it also
// (1) merges live `snapshot:<id>` runs in immediately via `onSnapshotChanged`
// (respecting period/filters/tab through the existing derived pipeline), and
// (2) tops up the head of history every 60s while visible (`refreshHead`),
// immediately on regaining visibility, and once right after a mount/filter
// load (so a page reload is never stale by more than ~60s) — making 0
// requests while hidden. Loader functions are mocked; only the merge/
// scheduling behavior in BuildsHistory.tsx itself is under test here (the
// real `refreshHead` budget/TTL logic is covered by
// tests/integration/history-refresh-head.test.ts).
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { setInstances, setSnapshot, setToken } from '../../src/lib/storage';
import type { Run, Snapshot } from '../../src/domain/types';

const loadHistory = vi.fn();
const loadMore = vi.fn();
const refreshHead = vi.fn();

vi.mock('../../src/features/builds/history-loader', () => ({
  loadHistory: (...args: unknown[]) => loadHistory(...args),
  loadMore: (...args: unknown[]) => loadMore(...args),
  refreshHead: (...args: unknown[]) => refreshHead(...args),
}));

import { BuildsHistory } from '../../src/features/builds/BuildsHistory';

const INSTANCE = {
  id: 'i_refresh01',
  baseUrl: 'https://gitea.example',
  login: 'me',
  capabilities: { actions: 'org' as const, notifications: false, orgs: [], missingScopes: [] },
};

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'test',
    event: 'push',
    actor: 'alice',
    headSha: 'abc123',
    htmlUrl: 'https://gitea.example/acme/platform/actions/runs/1',
    title: 'push: test',
    workflow: 'ci.yml',
    state: 'success',
    startedAt: '2026-09-29T09:00:00.000Z',
    completedAt: '2026-09-29T09:05:00.000Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

function loadResult(overrides: Record<string, unknown> = {}) {
  return {
    runs: [run()],
    coveredUntil: '2026-09-29T00:00:00.000Z',
    hasMore: false,
    requests: 1,
    ...overrides,
  };
}

function snapshotWith(runs: Run[]): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: [],
    runs,
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

function table() {
  return within(screen.getByTestId('history-runs-table'));
}

async function configureInstance(): Promise<void> {
  await setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await setToken(INSTANCE.id, 'test-token');
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  window.location.hash = '#/builds?view=history&kind=all';
  loadHistory.mockReset().mockResolvedValue(loadResult());
  loadMore.mockReset();
  refreshHead.mockReset().mockResolvedValue({ runs: [], coveredUntil: '2026-09-29T00:00:00.000Z', hasMore: false, requests: 0 });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BuildsHistory: live snapshot merge (T058)', () => {
  it('a new run appearing in the snapshot shows in the table without a reload', async () => {
    await configureInstance();
    render(<BuildsHistory />);
    await waitFor(() => expect(table().getByText('platform')).toBeTruthy());
    expect(table().queryByText('livebuild')).toBeNull();

    const liveRun = run({ id: 999, repo: { owner: 'acme', name: 'livebuild' }, state: 'running', startedAt: '2026-09-29T09:30:00.000Z', completedAt: undefined });
    await setSnapshot(INSTANCE.id, snapshotWith([liveRun]));

    await waitFor(() => expect(table().getByText('livebuild')).toBeTruthy());
  });

  it('merges the current snapshot once on mount, without waiting for a change event', async () => {
    await setSnapshot(INSTANCE.id, snapshotWith([run({ id: 998, repo: { owner: 'acme', name: 'alreadythere' }, state: 'running', startedAt: '2026-09-29T09:30:00.000Z', completedAt: undefined })]));
    await configureInstance();

    render(<BuildsHistory />);

    await waitFor(() => expect(table().getByText('alreadythere')).toBeTruthy());
  });
});

describe('BuildsHistory: periodic head refresh (T058)', () => {
  it('while visible, refreshes the head every 60s and merges a newly appeared server run', async () => {
    vi.useFakeTimers();
    await configureInstance();
    render(<BuildsHistory />);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshHead).toHaveBeenCalledTimes(1); // once right after the mount load

    refreshHead.mockResolvedValue({
      runs: [run({ id: 2, repo: { owner: 'acme', name: 'freshbuild' } })],
      coveredUntil: '2026-09-29T00:00:00.000Z',
      hasMore: false,
      requests: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(table().getByText('freshbuild')).toBeTruthy();
  });

  it('makes 0 head-refresh requests while the tab is hidden', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
    await configureInstance();
    render(<BuildsHistory />);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadHistory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000);

    expect(refreshHead).not.toHaveBeenCalled();
  });

  it('a mount with an existing (fresh) cache still triggers one head-refresh call (never stale by more than ~60s)', async () => {
    await configureInstance();
    render(<BuildsHistory />);

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshHead).toHaveBeenCalledTimes(1));
    expect(refreshHead.mock.calls[0]?.[0]).toMatchObject({ period: 'today' });
  });

  it('preserves the current page index and expanded row across a head-refresh merge', async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 30 }, (_, i) =>
      run({ id: 10 + i, repo: { owner: 'acme', name: `repo${i}` }, startedAt: `2026-09-29T00:${String(i).padStart(2, '0')}:00.000Z`, completedAt: `2026-09-29T00:${String(i + 1).padStart(2, '0')}:00.000Z` })
    );
    loadHistory.mockResolvedValue(loadResult({ runs: many }));
    await configureInstance();
    render(<BuildsHistory />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('history-runs-table')).toBeTruthy();
    expect(refreshHead).toHaveBeenCalledTimes(1);

    // Expand the first row (page 1), then move to page 2 (25/page default).
    const toggle = screen.getAllByRole('button', { name: 'buildsStageToggle' })[0]!;
    fireEvent.click(toggle);
    await vi.advanceTimersByTimeAsync(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'paginationNext' }));
    await vi.advanceTimersByTimeAsync(0);
    const rangeBeforeRefresh = screen.getByTestId('pagination-range').textContent;
    expect(rangeBeforeRefresh).not.toBe(null);

    // Older than every `many` run (2026-09-29T00:0x) -> sorts to the bottom,
    // so it doesn't reorder the already-expanded top row (this test is about
    // page/expanded-row *preservation*, not sort order).
    refreshHead.mockResolvedValue({
      runs: [
        run({
          id: 999,
          repo: { owner: 'acme', name: 'newontick' },
          startedAt: '2026-09-28T23:00:00.000Z',
          completedAt: '2026-09-28T23:05:00.000Z',
        }),
      ],
      coveredUntil: '2026-09-29T00:00:00.000Z',
      hasMore: false,
      requests: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshHead).toHaveBeenCalledTimes(2);

    // Still on page 2 (not reset to page 1 by the merge)...
    expect(screen.getByTestId('pagination-range').textContent).toBe(rangeBeforeRefresh);

    // ...and the row expanded back on page 1 is still expanded once we
    // navigate back to it (a fresh page-1 render, so this checks the
    // `expandedKey` state itself, not a stale detached DOM node).
    fireEvent.click(screen.getByRole('button', { name: 'paginationPrev' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getAllByRole('button', { name: 'buildsStageToggle' })[0]!.getAttribute('aria-expanded')).toBe('true');
  });
});
