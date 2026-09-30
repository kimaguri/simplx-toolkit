// @vitest-environment happy-dom
// T045: shared TablePagination footer + usePageSize persistence (ui.pageSize).
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { getUiState, setUiState } from '../../src/lib/storage';
import { TablePagination, usePageSize, rangeLabelArgs } from '../../src/features/TablePagination';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});
afterEach(cleanup);

describe('rangeLabelArgs', () => {
  it('computes 1-based inclusive range', () => {
    expect(rangeLabelArgs(0, 25, 60)).toEqual(['1', '25', '60']);
    expect(rangeLabelArgs(2, 25, 60)).toEqual(['51', '60', '60']);
    expect(rangeLabelArgs(0, 25, 0)).toEqual(['0', '0', '0']);
  });
});

describe('TablePagination', () => {
  function setup(over: Partial<Parameters<typeof TablePagination>[0]> = {}) {
    const props = {
      pageIndex: 0,
      pageSize: 25,
      total: 60,
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
      ...over,
    };
    render(<TablePagination {...props} />);
    return props;
  }

  it('shows range and disables Back on first page', () => {
    setup();
    expect(screen.getByTestId('pagination-range').textContent).toBe('paginationRange');
    expect((screen.getByText('paginationPrev').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('paginationNext').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Next/Back call onPageChange with neighbouring index', () => {
    const p = setup({ pageIndex: 1 });
    fireEvent.click(screen.getByText('paginationNext'));
    expect(p.onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText('paginationPrev'));
    expect(p.onPageChange).toHaveBeenCalledWith(0);
  });

  it('disables Next on last page unless canLoadMore', () => {
    setup({ pageIndex: 2 });
    expect((screen.getByText('paginationNext').closest('button') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ pageIndex: 2, canLoadMore: true });
    expect((screen.getByText('paginationNext').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('page size select offers 25/50/100', () => {
    const p = setup();
    const sel = screen.getByTestId('pagination-size') as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['25', '50', '100']);
    fireEvent.change(sel, { target: { value: '50' } });
    expect(p.onPageSizeChange).toHaveBeenCalledWith(50);
  });
});

describe('usePageSize', () => {
  it('defaults to 25, restores from ui.pageSize, persists changes', async () => {
    const { result } = renderHook(() => usePageSize());
    expect(result.current[0]).toBe(25);
    act(() => result.current[1](100));
    expect(result.current[0]).toBe(100);
    await waitFor(async () => expect((await getUiState()).pageSize).toBe(100));
    cleanup();
    await setUiState({ pageSize: 50 });
    const again = renderHook(() => usePageSize());
    await waitFor(() => expect(again.result.current[0]).toBe(50));
  });

  it('ignores an invalid stored size', async () => {
    await setUiState({ pageSize: 7 });
    const { result } = renderHook(() => usePageSize());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current[0]).toBe(25);
  });
});
