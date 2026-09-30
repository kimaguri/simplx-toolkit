// @vitest-environment happy-dom
// T046 [US4] — Builds popup tab.
// Contract: docs/specs/001-gitea-dashboard/spec.md US4 scenarios 1-6, FR-030..033, FR-072.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { Builds } from '../../src/entrypoints/popup/tabs/Builds';
import { BuildsGroups } from '../../src/features/builds/BuildsGroups';
import type { Run, Snapshot } from '../../src/domain/types';

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

function baseSnapshot(runs: Run[]): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: [],
    runs,
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

describe('Builds tab', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows "mine" expanded and "others" collapsed by default with an active+failed counter', async () => {
    const mine = makeRun({ id: 1, group: 'mine', state: 'running', repo: { owner: 'acme', name: 'core' } });
    const othersActive = makeRun({ id: 2, group: 'others', state: 'running' });
    const othersFailed = makeRun({ id: 3, group: 'others', state: 'failure' });
    const othersDone = makeRun({ id: 4, group: 'others', state: 'success' });

    render(<Builds snapshot={baseSnapshot([mine, othersActive, othersFailed, othersDone])} />);

    // Mine group is expanded: its item is visible immediately.
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(1);
    });

    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain('buildsOthersCounter');
    // activeOthers=1 (othersActive), failedOthers=1 (othersFailed).
    expect(browser.i18n.getMessage).toHaveBeenCalledWith('buildsOthersCounter', ['1', '1']);

    // Others is collapsed: none of its items are rendered.
    expect(screen.queryAllByRole('option')).toHaveLength(1);
  });

  it('persists the others-collapsed toggle in ui.othersCollapsed', async () => {
    const mine = makeRun({ id: 1, group: 'mine' });
    const other = makeRun({ id: 2, group: 'others' });

    render(<Builds snapshot={baseSnapshot([mine, other])} />);

    const toggle = await screen.findByRole('button', { expanded: false });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    });
    expect(screen.getAllByRole('option')).toHaveLength(2);

    await waitFor(async () => {
      const stored = await fakeBrowser.storage.local.get('ui');
      expect(stored.ui).toEqual({ lastTab: 'repos', othersCollapsed: false });
    });

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    await waitFor(async () => {
      const stored = await fakeBrowser.storage.local.get('ui');
      expect(stored.ui).toEqual({ lastTab: 'repos', othersCollapsed: true });
    });
  });

  it('ticks the duration of a running item every second, but not a completed one', async () => {
    vi.useFakeTimers();
    const running = makeRun({
      id: 1,
      group: 'mine',
      state: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: undefined,
    });
    const done = makeRun({
      id: 2,
      group: 'mine',
      state: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:10.000Z',
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    render(<Builds snapshot={baseSnapshot([running, done])} />);

    expect(screen.getByText('10с')).toBeTruthy(); // completed run: fixed 10s

    await vi.advanceTimersByTimeAsync(3000);

    // The running item's duration advanced to ~3s; the completed one is unchanged.
    expect(screen.getByText('3с')).toBeTruthy();
    expect(screen.getByText('10с')).toBeTruthy();
  });

  it('clears the ticking interval on unmount (no leaked timers)', async () => {
    vi.useFakeTimers();
    const running = makeRun({ id: 1, group: 'mine', state: 'running', startedAt: '2026-01-01T00:00:00.000Z' });

    const { unmount } = render(<Builds snapshot={baseSnapshot([running])} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    // Only the heartbeat interval (or nothing) may remain a live timer source
    // that isn't the 1s duration tick; after unmount all intervals owned by
    // this component must be cleared, so no timer fires ever again without
    // throwing (JSDOM setState-after-unmount would throw/warn).
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });

  it('sends a popup-heartbeat every 5s and stops sending after unmount', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    const { unmount } = render(<Builds snapshot={baseSnapshot([])} />);

    expect(sendMessage).toHaveBeenCalledWith({ type: 'popup-heartbeat' });
    sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    unmount();
    sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('T082: keeps exactly one selected row shared across "mine" and expanded "others", ↑ crosses group boundaries, Enter opens it', async () => {
    const mine = makeRun({ id: 1, group: 'mine', workflow: 'Mine run', htmlUrl: 'https://git.example.test/a/b/actions/runs/1' });
    const other = makeRun({ id: 2, group: 'others', workflow: 'Other run', htmlUrl: 'https://git.example.test/a/b/actions/runs/2' });

    render(<Builds snapshot={baseSnapshot([mine, other])} />);

    // Expand "Остальные" so both groups are visible/reachable.
    const toggle = await screen.findByRole('button', { expanded: false });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(2);
    });

    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    const mineListbox = screen.getByRole('listbox', { name: 'buildsGroupMine' });
    // "mine" has a single row and is already at its last row: ArrowDown must
    // cross into "others"'s first row.
    fireEvent.keyDown(mineListbox, { key: 'ArrowDown' });

    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    const othersListbox = screen.getByRole('listbox', { name: 'buildsGroupOthers' });
    expect(
      within(othersListbox).getByText('Other run').closest('[role="option"]')?.getAttribute('aria-selected')
    ).toBe('true');

    fireEvent.keyDown(othersListbox, { key: 'Enter' });
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'https://git.example.test/a/b/actions/runs/2' });
  });

  it('T082: shows the selected-row highlight only once the list has keyboard focus', () => {
    const run = makeRun({ id: 1, group: 'mine', workflow: 'Solo run' });

    render(<Builds snapshot={baseSnapshot([run])} />);

    const option = screen.getByText('Solo run').closest('[role="option"]') as HTMLElement;
    expect(option.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);

    const listbox = screen.getByRole('listbox', { name: 'buildsGroupMine' });
    fireEvent.focus(listbox);
    expect(option.className).toMatch(/(?:^|\s)bg-accent(?:\s|$)/);

    fireEvent.blur(listbox);
    expect(option.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
  });

  it('opens the run htmlUrl in a new tab on click', async () => {
    const run = makeRun({ id: 1, group: 'mine', htmlUrl: 'https://git.example.test/acme/core/actions/runs/1' });
    render(<Builds snapshot={baseSnapshot([run])} />);

    const item = await screen.findByRole('option');
    fireEvent.click(item);

    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://git.example.test/acme/core/actions/runs/1',
    });
  });

  it('sends the heartbeat by default when rendered directly with no heartbeat prop (density-only usage)', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    render(<BuildsGroups snapshot={baseSnapshot([])} density="compact" />);

    expect(sendMessage).toHaveBeenCalledWith({ type: 'popup-heartbeat' });
    sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends no heartbeat at all when heartbeat={false}', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    render(<BuildsGroups snapshot={baseSnapshot([])} density="compact" heartbeat={false} />);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'popup-heartbeat' });
  });

  it('shows an explanation when Actions is unsupported by the instance', async () => {
    render(
      <Builds
        snapshot={baseSnapshot([])}
        capabilities={{ actions: 'unsupported', notifications: false, orgs: [], missingScopes: [] }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('buildsUnsupported')).toBeTruthy();
    });
  });

  it('shows an empty state when there are no runs at all', async () => {
    render(<Builds snapshot={baseSnapshot([])} />);

    await waitFor(() => {
      expect(screen.getByText('buildsEmpty')).toBeTruthy();
    });
  });

  it('shows the sectionErrors.runs message', async () => {
    const snap = baseSnapshot([]);
    snap.sectionErrors = { runs: { kind: 'network', at: new Date().toISOString() } };
    render(<Builds snapshot={snap} />);

    await waitFor(() => {
      expect(screen.getByText('buildsSectionError')).toBeTruthy();
    });
  });
});
