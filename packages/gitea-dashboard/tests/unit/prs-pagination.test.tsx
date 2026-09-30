// @vitest-environment happy-dom
// T045: PR table client-side pagination.
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { PullRequest, Snapshot } from '../../src/domain/types';
import { getUiState, setUiState } from '../../src/lib/storage';
import { PrsTable } from '../../src/features/prs/PrsTable';

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
  window.location.hash = '';
});
afterEach(cleanup);

function prs(n: number): PullRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    repo: { owner: 'acme', name: 'platform' },
    number: i + 1,
    title: `PR title ${String(i + 1).padStart(3, '0')}`,
    author: 'alice',
    updatedAt: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(),
    htmlUrl: `https://gitea.example/acme/platform/pulls/${i + 1}`,
    draft: false,
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2026-09-20T10:00:00.000Z' },
  }));
}
function snap(n: number): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    prs: prs(n),
    runs: [],
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}
const rowCount = () => document.querySelectorAll('tbody tr[tabindex="0"]').length;

describe('PrsTable pagination', () => {
  it('renders 25 rows of 60 by default with range footer', () => {
    render(<PrsTable snapshot={snap(60)} />);
    expect(rowCount()).toBe(25);
    expect(screen.getByTestId('pagination-range')).toBeTruthy();
  });

  it('Next shows the following page; last page has the remainder', () => {
    render(<PrsTable snapshot={snap(60)} />);
    const first = document.querySelector('tbody tr')!.textContent;
    fireEvent.click(screen.getByText('paginationNext'));
    expect(document.querySelector('tbody tr')!.textContent).not.toBe(first);
    fireEvent.click(screen.getByText('paginationNext'));
    expect(rowCount()).toBe(10);
  });

  it('changing page size to 50 shows 50 rows and persists ui.pageSize', async () => {
    render(<PrsTable snapshot={snap(60)} />);
    fireEvent.change(screen.getByTestId('pagination-size'), { target: { value: '50' } });
    expect(rowCount()).toBe(50);
    await waitFor(async () => expect((await getUiState()).pageSize).toBe(50));
  });

  it('restores persisted page size', async () => {
    await setUiState({ pageSize: 50 });
    render(<PrsTable snapshot={snap(60)} />);
    await waitFor(() => expect(rowCount()).toBe(50));
  });

  it('resets to page 1 when the search changes', () => {
    render(<PrsTable snapshot={snap(60)} />);
    fireEvent.click(screen.getByText('paginationNext'));
    fireEvent.change(screen.getByPlaceholderText('prsFilterSearchPlaceholder'), {
      target: { value: 'PR title' },
    });
    expect(rowCount()).toBe(25);
    expect(document.querySelector('tbody tr')!.textContent).toContain('PR title');
    expect((screen.getByText('paginationPrev').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets to page 1 when sort changes', () => {
    render(<PrsTable snapshot={snap(60)} />);
    fireEvent.click(screen.getByText('paginationNext'));
    fireEvent.click(screen.getByText('prsColTitle'));
    expect((screen.getByText('paginationPrev').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
