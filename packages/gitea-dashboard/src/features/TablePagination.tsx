// T045 (FR-120): shared footer for client-side paginated tables (PR table,
// builds history) + `usePageSize` hook persisting the size in ui.pageSize.
// Dashboard-only: never imported by popup code paths.
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { t } from '../lib/i18n';
import { getUiState, setUiState } from '../lib/storage';
import { Button } from '../components/ui/button';

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export function rangeLabelArgs(pageIndex: number, pageSize: number, total: number): [string, string, string] {
  if (total === 0) return ['0', '0', '0'];
  const from = pageIndex * pageSize + 1;
  const to = Math.min(total, (pageIndex + 1) * pageSize);
  return [String(from), String(to), String(total)];
}

function isPageSize(n: unknown): n is number {
  return typeof n === 'number' && (PAGE_SIZES as readonly number[]).includes(n);
}

/** Page size state, restored from and persisted to ui.pageSize. */
export function usePageSize(): [number, (size: number) => void] {
  const [size, setSize] = useState<number>(DEFAULT_PAGE_SIZE);
  useEffect(() => {
    let alive = true;
    void getUiState().then((ui) => {
      if (alive && isPageSize(ui.pageSize)) setSize(ui.pageSize);
    });
    return () => {
      alive = false;
    };
  }, []);
  const update = useCallback((next: number) => {
    setSize(next);
    void setUiState({ pageSize: next });
  }, []);
  return [size, update];
}

export interface TablePaginationProps {
  pageIndex: number;
  pageSize: number;
  total: number;
  onPageChange: (index: number) => void;
  onPageSizeChange: (size: number) => void;
  /** More data can still be fetched from the server (history): keeps Next enabled on the last page. */
  canLoadMore?: boolean;
  loading?: boolean;
}

export function TablePagination({
  pageIndex,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  canLoadMore = false,
  loading = false,
}: TablePaginationProps): JSX.Element {
  const lastIndex = Math.max(0, Math.ceil(total / pageSize) - 1);
  const hasNext = pageIndex < lastIndex || canLoadMore;
  return (
    <div className="flex shrink-0 items-center justify-end gap-3 pt-2 text-sm text-muted-foreground">
      <label className="flex items-center gap-2">
        <span>{t('paginationPageSize')}</span>
        <select
          data-testid="pagination-size"
          className="h-8 rounded-md border bg-background px-2 text-foreground"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <span data-testid="pagination-range" className="tabular-nums">
        {t('paginationRange', rangeLabelArgs(pageIndex, pageSize, total))}
      </span>
      <Button type="button" variant="outline" size="sm" disabled={pageIndex <= 0} onClick={() => onPageChange(pageIndex - 1)}>
        {t('paginationPrev')}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={!hasNext || loading} onClick={() => onPageChange(pageIndex + 1)}>
        {t('paginationNext')}
      </Button>
    </div>
  );
}
