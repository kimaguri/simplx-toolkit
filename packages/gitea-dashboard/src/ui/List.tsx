import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, ReactNode, Ref } from 'react';
import { cn } from '../lib/utils';

export interface ListProps<T> {
  items: readonly T[];
  /** -1 means "no row in this list is the current selection" (used when a
   * single selection is shared across several List instances, e.g. groups
   * within one tab — see tabs/Prs.tsx, tabs/Builds.tsx). */
  selectedIndex: number;
  renderItem: (item: T, index: number, active: boolean) => ReactNode;
  onActivate: (item: T, index: number) => void;
  /** Optional: called when arrow keys request a new selection (List does not own selection state). */
  onSelectIndex?: (index: number) => void;
  /**
   * Optional: called instead of `onSelectIndex` when an arrow key is pressed
   * while already at this list's first/last row (direction -1 = ArrowUp at
   * row 0, +1 = ArrowDown at the last row). Lets a parent move the selection
   * (and DOM focus) into an adjacent List, so ↑/↓ can cross group boundaries.
   * When omitted, boundary key presses are a no-op (previous behaviour).
   */
  onBoundary?: (direction: 1 | -1) => void;
  /**
   * When true, the selected-row highlight (bg-accent) is only shown while
   * this listbox itself has keyboard focus — used when several List
   * instances share one logical selection so only the focused group shows a
   * highlight (mouse hover is unaffected). Defaults to false (always show
   * the highlight for the selected row, the original/Repos-tab behaviour).
   */
  focusOnly?: boolean;
  /** CSS max-height for the internal scroll area. `'none'` disables the
   * internal scroll (e.g. when an ancestor already scrolls the whole tab
   * body). Defaults to 320px. */
  maxHeight?: string;
  idPrefix?: string;
  'aria-label'?: string;
  /** Exposes the listbox root element to the caller, e.g. to move DOM focus
   * into it from an `onBoundary` handler. */
  containerRef?: Ref<HTMLDivElement>;
}

/**
 * Generic keyboard-selectable list. Scrolls internally (max-height + overflow-y,
 * kept as inline styles on the listbox element itself so callers/tests can
 * assert on them directly), exposes role="listbox" + aria-activedescendant,
 * and keeps the selected item scrolled into view. Selection state
 * (selectedIndex) is owned by the caller; this component only reports intent
 * via onSelectIndex / onActivate. Rows follow the shadcn command/list-item
 * convention (rounded-md px-2 py-1.5 text-sm, bg-accent on hover/selected).
 */
export function List<T>({
  items,
  selectedIndex,
  renderItem,
  onActivate,
  onSelectIndex,
  onBoundary,
  focusOnly = false,
  maxHeight = '320px',
  idPrefix = 'gd-list-item',
  containerRef,
  ...rest
}: ListProps<T>): JSX.Element {
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [hasFocus, setHasFocus] = useState(false);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const activeId =
    selectedIndex >= 0 && selectedIndex < items.length ? `${idPrefix}-${selectedIndex}` : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (selectedIndex >= items.length - 1 && onBoundary) {
        onBoundary(1);
      } else {
        const next = Math.min(selectedIndex + 1, items.length - 1);
        onSelectIndex?.(next);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (selectedIndex <= 0 && onBoundary) {
        onBoundary(-1);
      } else {
        const prev = Math.max(selectedIndex - 1, 0);
        onSelectIndex?.(prev);
      }
    } else if (event.key === 'Enter') {
      const item = items[selectedIndex];
      if (item !== undefined) {
        event.preventDefault();
        onActivate(item, selectedIndex);
      }
    }
  }

  return (
    <div
      ref={containerRef}
      role="listbox"
      tabIndex={0}
      aria-activedescendant={activeId}
      aria-label={rest['aria-label']}
      onKeyDown={handleKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={() => setHasFocus(false)}
      className="outline-none"
      style={{ maxHeight, overflowY: 'auto' }}
    >
      {items.map((item, index) => {
        const active = index === selectedIndex;
        const highlighted = active && (!focusOnly || hasFocus);
        return (
          <div
            key={index}
            id={`${idPrefix}-${index}`}
            role="option"
            aria-selected={active}
            ref={active ? activeRef : undefined}
            onClick={() => onActivate(item, index)}
            className={cn(
              'cursor-default rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
              highlighted && 'bg-accent text-accent-foreground'
            )}
          >
            {renderItem(item, index, active)}
          </div>
        );
      })}
    </div>
  );
}
