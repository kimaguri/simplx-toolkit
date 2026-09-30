// @vitest-environment happy-dom
// T045: history table pagination + fetching the next API page on reaching the last loaded page.
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Run } from '../../src/domain/types';
import { setInstances, setToken } from '../../src/lib/storage';

const loadHistory = vi.fn();
const loadMore = vi.fn();
vi.mock('../../src/features/builds/history-loader', () => ({
  loadHistory: (...a: unknown[]) => loadHistory(...a),
  loadMore: (...a: unknown[]) => loadMore(...a),
}));
import { BuildsHistory } from '../../src/features/builds/BuildsHistory';

beforeEach(async () => {
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
  window.location.hash = '';
  loadHistory.mockReset();
  loadMore.mockReset();
  const inst = {
    id: 'i_test0001',
    baseUrl: 'https://gitea.example',
    capabilities: { actions: 'org' as const, notifications: false, orgs: [], missingScopes: [] },
  };
  await setInstances({ instances: [inst], activeInstanceId: inst.id });
  await setToken(inst.id, 'test-token');
});
afterEach(cleanup);

function runs(n: number, from = 1): Run[] {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i,
    attempt: 1,
    number: from + i,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'abc',
    htmlUrl: `https://gitea.example/acme/platform/actions/runs/${from + i}`,
    title: 'push: main',
    workflow: 'ci.yml',
    state: 'success' as const,
    startedAt: new Date(Date.UTC(2026, 8, 25) - (from + i) * 60000).toISOString(),
    completedAt: new Date(Date.UTC(2026, 8, 25) - (from + i) * 60000 + 1000).toISOString(),
    mine: false,
    group: 'others' as const,
  }));
}
const res = (r: Run[], hasMore: boolean) => ({
  runs: r,
  coveredUntil: '2026-09-20T00:00:00.000Z',
  hasMore,
  requests: 1,
});
const rowCount = () => document.querySelectorAll('[data-testid="history-runs-table"] tbody tr[tabindex="0"]').length;

describe('BuildsHistory pagination', () => {
  it('shows 25 of 60 loaded runs and pages forward without fetching', async () => {
    loadHistory.mockResolvedValue(res(runs(60), false));
    render(<BuildsHistory />);
    await waitFor(() => expect(rowCount()).toBe(25));
    fireEvent.click(screen.getByText('paginationNext'));
    fireEvent.click(screen.getByText('paginationNext'));
    expect(rowCount()).toBe(10);
    expect((screen.getByText('paginationNext').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('reaching the last loaded page with hasMore fetches the next API page', async () => {
    loadHistory.mockResolvedValue(res(runs(30), true));
    loadMore.mockResolvedValue(res(runs(70), false));
    render(<BuildsHistory />);
    await waitFor(() => expect(rowCount()).toBe(25));
    fireEvent.click(screen.getByText('paginationNext'));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
    // after more rows arrive Next is available again and page 2 is full
    await waitFor(() => expect(rowCount()).toBe(25));
    expect((screen.getByText('paginationNext').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not fetch when everything is loaded', async () => {
    loadHistory.mockResolvedValue(res(runs(30), false));
    render(<BuildsHistory />);
    await waitFor(() => expect(rowCount()).toBe(25));
    fireEvent.click(screen.getByText('paginationNext'));
    expect(rowCount()).toBe(5);
    expect(loadMore).not.toHaveBeenCalled();
  });
});
