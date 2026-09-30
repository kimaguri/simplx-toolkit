// @vitest-environment happy-dom
// T044: picker only on the dashboard page (comfortable + provider); popup unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import reposSearchFixture from '../fixtures/repos-search.json';
import { ReposSection } from '../../src/features/repos/ReposSection';
import { RepoColorsProvider } from '../../src/features/repos/RepoColorsProvider';

beforeEach(async () => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => reposSearchFixture,
    }))
  );
  await fakeBrowser.storage.local.set({
    instances: {
      instances: [{ id: 'i_t', baseUrl: 'https://git.example.test', capabilities: {} }],
      activeInstanceId: 'i_t',
    },
    'token:i_t': 'test-token',
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Repo colour picker slot', () => {
  it('renders a picker per row for comfortable + provider', async () => {
    render(
      <RepoColorsProvider>
        <ReposSection density="comfortable" />
      </RepoColorsProvider>
    );
    expect((await screen.findAllByRole('button', { name: 'repoColorButton' })).length).toBeGreaterThan(0);
  });

  it('renders none for compact even with a provider', async () => {
    render(
      <RepoColorsProvider>
        <ReposSection density="compact" />
      </RepoColorsProvider>
    );
    await screen.findAllByRole('button', { name: 'reposTogglePin' });
    expect(screen.queryAllByRole('button', { name: 'repoColorButton' })).toHaveLength(0);
  });

  it('renders none for comfortable without a provider', async () => {
    render(<ReposSection density="comfortable" />);
    await screen.findAllByRole('button', { name: 'reposTogglePin' });
    expect(screen.queryAllByRole('button', { name: 'repoColorButton' })).toHaveLength(0);
  });
});
