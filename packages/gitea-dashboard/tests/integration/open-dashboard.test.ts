// Contract: docs/specs/002-fullpage-dashboard/contracts/page-surface.md ("Кнопка
// в окне"). Research: docs/specs/002-fullpage-dashboard/research.md R1 — one
// dashboard tab per browser, reused instead of duplicated.
//
// `fakeBrowser` (wxt/testing/fake-browser) has no `runtime.getContexts`
// (Chrome ≥ 116 MV3 API, absent from webextension-polyfill types and from
// @webext-core/fake-browser) -- it is added/removed per-test as a plain
// function on `browser.runtime`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { openDashboard } from '../../src/background/open-dashboard';

const DASHBOARD_URL = 'chrome-extension://test-extension-id/dashboard.html';

function setGetContexts(impl: ((filter: unknown) => Promise<unknown[]>) | undefined) {
  (browser.runtime as unknown as { getContexts?: unknown }).getContexts = impl;
}

afterEach(() => {
  setGetContexts(undefined);
});

describe('openDashboard', () => {
  it('creates a new tab with the section hash when no dashboard context exists', async () => {
    setGetContexts(vi.fn().mockResolvedValue([]));
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');

    await openDashboard('prs');

    expect(createSpy).toHaveBeenCalledWith({ url: `${DASHBOARD_URL}#/prs` });
  });

  it('focuses the existing tab and window instead of creating a new one', async () => {
    setGetContexts(
      vi.fn().mockResolvedValue([
        { tabId: 7, windowId: 3, documentUrl: `${DASHBOARD_URL}#/repos` },
      ]),
    );
    const updateTabSpy = vi.spyOn(fakeBrowser.tabs, 'update').mockResolvedValue({} as never);
    const updateWindowSpy = vi.spyOn(fakeBrowser.windows, 'update').mockResolvedValue({} as never);
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');

    await openDashboard('prs');

    expect(updateTabSpy).toHaveBeenCalledWith(7, { active: true });
    expect(updateWindowSpy).toHaveBeenCalledWith(3, { focused: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('ignores contexts with a different URL (options/popup) and creates a new tab', async () => {
    setGetContexts(
      vi.fn().mockResolvedValue([
        { tabId: 1, windowId: 1, documentUrl: 'chrome-extension://test-id/popup.html' },
        { tabId: 2, windowId: 1, documentUrl: 'chrome-extension://test-id/options.html' },
      ]),
    );
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');
    const updateTabSpy = vi.spyOn(fakeBrowser.tabs, 'update');

    await openDashboard('builds');

    expect(updateTabSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith({ url: `${DASHBOARD_URL}#/builds` });
  });

  it('falls back to scanning all TAB contexts when the strict documentUrls filter matches nothing (hash mismatch)', async () => {
    const getContexts = vi.fn().mockImplementation((filter: { documentUrls?: string[] }) => {
      if (filter.documentUrls) {
        // Chrome matched documentUrls exactly (hash included) -> no hit,
        // even though a dashboard tab with a different hash is open.
        return Promise.resolve([]);
      }
      return Promise.resolve([
        { tabId: 9, windowId: 5, documentUrl: `${DASHBOARD_URL}#/builds?view=history` },
      ]);
    });
    setGetContexts(getContexts);
    const updateTabSpy = vi.spyOn(fakeBrowser.tabs, 'update').mockResolvedValue({} as never);
    const updateWindowSpy = vi.spyOn(fakeBrowser.windows, 'update').mockResolvedValue({} as never);
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');

    await openDashboard('repos');

    expect(updateTabSpy).toHaveBeenCalledWith(9, { active: true });
    expect(updateWindowSpy).toHaveBeenCalledWith(5, { focused: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('falls back to tabs.create when getContexts is unavailable', async () => {
    setGetContexts(undefined);
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');

    await openDashboard('repos');

    expect(createSpy).toHaveBeenCalledWith({ url: `${DASHBOARD_URL}#/repos` });
  });

  it('never creates a duplicate tab across 10 consecutive calls when one already exists', async () => {
    setGetContexts(
      vi.fn().mockResolvedValue([
        { tabId: 4, windowId: 2, documentUrl: `${DASHBOARD_URL}#/prs?view=table` },
      ]),
    );
    vi.spyOn(fakeBrowser.tabs, 'update').mockResolvedValue({} as never);
    vi.spyOn(fakeBrowser.windows, 'update').mockResolvedValue({} as never);
    const createSpy = vi.spyOn(fakeBrowser.tabs, 'create');

    for (let i = 0; i < 10; i += 1) {
      await openDashboard('prs');
    }

    expect(createSpy).not.toHaveBeenCalled();
  });
});
