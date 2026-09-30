// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

afterEach(() => {
  cleanup();
});

vi.mock('../../src/lib/i18n', () => ({
  t: (key: string, subs?: string | string[]) =>
    subs === undefined ? key : `${key}:${Array.isArray(subs) ? subs.join(',') : subs}`,
}));

import { List } from '../../src/ui/List';
import { StatusIcon } from '../../src/ui/StatusIcon';
import { Empty } from '../../src/ui/Empty';
import { ErrorState } from '../../src/ui/ErrorState';
import { Stale } from '../../src/ui/Stale';
import type { CiState, RunState } from '../../src/domain/types';

describe('List', () => {
  const items = ['alpha', 'beta', 'gamma'];

  it('calls onActivate for the selected item on Enter', () => {
    const onActivate = vi.fn();
    render(
      <List
        items={items}
        selectedIndex={1}
        renderItem={(item) => <span>{item}</span>}
        onActivate={onActivate}
      />
    );
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith('beta', 1);
  });

  it('calls onSelectIndex when arrow keys move the selection', () => {
    const onSelectIndex = vi.fn();
    render(
      <List
        items={items}
        selectedIndex={0}
        renderItem={(item) => <span>{item}</span>}
        onActivate={vi.fn()}
        onSelectIndex={onSelectIndex}
      />
    );
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it('exposes aria-activedescendant pointing at the selected item', () => {
    render(
      <List
        items={items}
        selectedIndex={2}
        renderItem={(item) => <span>{item}</span>}
        onActivate={vi.fn()}
      />
    );
    const listbox = screen.getByRole('listbox');
    const activeId = listbox.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const activeOption = document.getElementById(activeId!);
    expect(activeOption?.textContent).toBe('gamma');
  });
});

describe('StatusIcon', () => {
  const runStates: RunState[] = [
    'waiting',
    'blocked',
    'running',
    'success',
    'failure',
    'cancelled',
    'skipped',
  ];
  const ciStates: CiState[] = [
    'success',
    'failure',
    'error',
    'pending',
    'warning',
    'skipped',
    'none',
  ];

  it('renders a distinct accessible title for every RunState', () => {
    const titles = new Set<string>();
    for (const state of runStates) {
      const { container, unmount } = render(<StatusIcon state={state} />);
      const title = container.querySelector('title');
      expect(title).toBeTruthy();
      expect(title!.textContent).toBeTruthy();
      titles.add(title!.textContent!);
      unmount();
    }
    expect(titles.size).toBe(runStates.length);
  });

  it('renders a distinct accessible title for every CiState', () => {
    const titles = new Set<string>();
    for (const state of ciStates) {
      const { container, unmount } = render(<StatusIcon state={state} />);
      const title = container.querySelector('title');
      expect(title).toBeTruthy();
      titles.add(title!.textContent!);
      unmount();
    }
    expect(titles.size).toBe(ciStates.length);
  });

  it('marks the running state as animated', () => {
    const { container } = render(<StatusIcon state="running" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-spin')).toBe('true');
  });
});

describe('Empty', () => {
  it('renders the message and an optional action', () => {
    const onClick = vi.fn();
    render(<Empty messageKey="emptyRepos" action={{ labelKey: 'actionRetry', onClick }} />);
    expect(screen.getByText('emptyRepos')).toBeTruthy();
    fireEvent.click(screen.getByText('actionRetry'));
    expect(onClick).toHaveBeenCalled();
  });

  it('renders without an action', () => {
    render(<Empty messageKey="emptyRepos" />);
    expect(screen.getByText('emptyRepos')).toBeTruthy();
  });
});

describe('ErrorState', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('renders the message and opens options on button click', () => {
    const spy = vi
      .spyOn(fakeBrowser.runtime, 'openOptionsPage')
      .mockImplementation(async () => {});
    render(<ErrorState messageKey="errorUnreachable" />);
    expect(screen.getByText('errorUnreachable')).toBeTruthy();
    fireEvent.click(screen.getByText('errorStateOpenOptions'));
    expect(spy).toHaveBeenCalled();
  });
});

describe('Stale', () => {
  it('formats fetchedAt as HH:MM in the message', () => {
    const fetchedAt = new Date(2026, 0, 15, 9, 5, 0).toISOString();
    render(<Stale fetchedAt={fetchedAt} />);
    expect(screen.getByText('staleMessage:09:05')).toBeTruthy();
  });

  it('pads single-digit hours and minutes', () => {
    const fetchedAt = new Date(2026, 0, 15, 3, 7, 0).toISOString();
    render(<Stale fetchedAt={fetchedAt} />);
    expect(screen.getByText('staleMessage:03:07')).toBeTruthy();
  });
});
