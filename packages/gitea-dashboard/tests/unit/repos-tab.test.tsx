// @vitest-environment happy-dom
// T029 [US2] — Repos popup tab.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-010..014.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import reposSearchFixture from '../fixtures/repos-search.json';
import { Repos } from '../../src/entrypoints/popup/tabs/Repos';
import type { Instance } from '../../src/domain/types';

const INSTANCE_ID = 'i_test';
const BASE_URL = 'https://git.example.test';

// React 19 (unlike Preact) schedules the re-render that follows an
// out-of-act state update (e.g. the async instance-load effect's
// `setEndpoints`) across extra microtask turns. A single large
// `vi.advanceTimersByTimeAsync(ms)` call only drains microtasks between
// already-scheduled timer callbacks, so it can run to completion before that
// re-render (and the debounce `setTimeout` it creates) has had a chance to
// happen. Advancing in small increments forces a microtask-queue flush after
// every step, giving pending promise chains room to progress. Total elapsed
// fake time and observed behavior are unchanged — only the flushing
// mechanics differ.
async function advanceTimersInSteps(totalMs: number, stepMs = 10): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - elapsed));
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

const instance: Instance = {
  id: INSTANCE_ID,
  baseUrl: BASE_URL,
  capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
};

async function setUpInstance(pins: Array<{ owner: string; name: string }> = []) {
  await fakeBrowser.storage.local.set({
    instances: { instances: [instance], activeInstanceId: INSTANCE_ID },
    [`token:${INSTANCE_ID}`]: 'test-token',
  });
  await fakeBrowser.storage.sync.set({
    [`pins:${INSTANCE_ID}`]: pins,
  });
}

describe('Repos tab', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    fetchMock = vi.fn(async () => jsonResponse(reposSearchFixture));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('autofocuses the search input', async () => {
    await setUpInstance();
    render(<Repos />);

    const input = await screen.findByRole('textbox');
    expect(document.activeElement).toBe(input);
  });

  it('debounces the search request by ~200ms', async () => {
    vi.useFakeTimers();
    try {
      await setUpInstance();
      render(<Repos />);

      // Initial mount: instance load (microtasks) + 200ms debounce for the
      // empty-query search.
      await advanceTimersInSteps(250);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const input = screen.getByRole('textbox') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'c' } });
      fireEvent.input(input, { target: { value: 'co' } });
      fireEvent.input(input, { target: { value: 'cor' } });

      // Still within the debounce window: no new request yet.
      await advanceTimersInSteps(150);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await advanceTimersInSteps(100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const lastUrl = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0] as string;
      expect(new URL(lastUrl).searchParams.get('q')).toBe('cor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows pinned repos first, opens the selected repo on Enter, its PRs on Ctrl+Enter, and its Actions on Shift+Enter', async () => {
    await setUpInstance([{ owner: 'acme', name: 'core' }]);
    render(<Repos />);

    // acme/core is pinned, so it must be the first item even though
    // acme/platform has a later updated_at in the fixture.
    const items = await screen.findAllByRole('option');
    expect(items[0]?.textContent).toContain('acme/core');

    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://git.example.test/acme/core',
    });

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://git.example.test/acme/core/pulls',
    });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://git.example.test/acme/core/actions',
    });
  });

  it('toggles the pin on Ctrl+P and prevents the default action', async () => {
    await setUpInstance([{ owner: 'acme', name: 'core' }]);
    render(<Repos />);

    await screen.findAllByRole('option');
    const input = screen.getByRole('textbox');

    const notPrevented = fireEvent.keyDown(input, { key: 'p', ctrlKey: true });
    expect(notPrevented).toBe(false);

    const pins = await fakeBrowser.storage.sync.get(`pins:${INSTANCE_ID}`);
    expect(pins[`pins:${INSTANCE_ID}`]).toEqual([]);
  });

  it('toggling a pin does not refetch and keeps the current selection', async () => {
    await setUpInstance([{ owner: 'acme', name: 'core' }]);
    render(<Repos />);

    const options = await screen.findAllByRole('option');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Select the second item (acme/platform, since acme/core is pinned first).
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');

    const pinButtons = screen.getAllByRole('button', { name: 'reposTogglePin' });
    fireEvent.click(pinButtons[1] as HTMLButtonElement);

    // Pin toggle re-renders the merged list, but must not re-run the search.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const optionsAfter = screen.getAllByRole('option');
    expect(optionsAfter[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('gives the privacy and pin icons an accessible title', async () => {
    await setUpInstance([{ owner: 'acme', name: 'core' }]);
    render(<Repos />);

    await screen.findAllByRole('option');

    const pinIcons = screen.getAllByRole('img', { name: /reposPinned|reposUnpinned/ });
    expect(pinIcons.length).toBeGreaterThan(0);
    for (const icon of pinIcons) {
      expect(icon.querySelector('title')?.textContent).toMatch(/reposPinned|reposUnpinned/);
    }
  });
});
