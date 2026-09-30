// @vitest-environment happy-dom
// T051 (FR-109): the document never scrolls; only the table area does.
// jsdom/happy-dom has no layout, so this pins the height-chain classes.
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { PullRequest, Snapshot } from '../../src/domain/types';
import { PrsTable } from '../../src/features/prs/PrsTable';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  window.location.hash = '';
});
afterEach(cleanup);

const prs: PullRequest[] = [
  {
    id: 1,
    repo: { owner: 'acme', name: 'platform' },
    number: 1,
    title: 'Add feature',
    author: 'alice',
    updatedAt: '2026-09-20T10:00:00.000Z',
    htmlUrl: 'https://gitea.example/acme/platform/pulls/1',
    draft: false,
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2026-09-20T10:00:00.000Z' },
  },
];

function classesOf(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

describe('PrsTable height chain (FR-109)', () => {
  it('root clips, table wrapper scrolls internally, filters and footer do not shrink', () => {
    const snapshot = { prs, counts: { reviews: 0, activeMine: 0 }, fetchedAt: '2026-09-20T10:00:00.000Z' } as unknown as Snapshot;
    const { container } = render(<PrsTable snapshot={snapshot} settings={DEFAULT_SETTINGS} />);
    const root = container.firstElementChild as HTMLElement;
    expect(classesOf(root)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-hidden']));

    const tableContainer = container.querySelector('[data-slot="table-container"]');
    const scroller = tableContainer?.parentElement ?? null;
    expect(classesOf(scroller)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-auto']));

    expect(classesOf(root.firstElementChild)).toContain('shrink-0'); // filters bar
    expect(classesOf(root.lastElementChild)).toContain('shrink-0'); // pagination footer
    // no document-level fixed heights leaking into the section
    expect(classesOf(root)).not.toContain('min-h-screen');
  });
});
