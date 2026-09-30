// @vitest-environment happy-dom
// T055 [US6] — Options page "Охват" section.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-034/035, data-model.md
// "Settings" (scope.excludeOrgs/excludeRepos/includeRepos, repoModeLimit).
//
// T078: organizations moved to shadcn Checkbox (a labelable
// `<button role="checkbox" aria-checked>`, toggled with `fireEvent.click`
// and asserted via `aria-checked` instead of `.checked`); exclude/include/
// pinned repos render as `Badge` chips with an "X" icon button (queried by
// its `aria-label`, same text the old plain-text button used) instead of a
// `<li>` + visible-text button; save feedback is a sonner toast instead of
// an inline `role="status"` paragraph.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { ScopeSection } from '../../src/entrypoints/options/Scope';
import { Toaster } from '../../src/components/ui/sonner';
import { getPins, getSettings, setInstances, setPins, setSettings } from '../../src/lib/storage';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import type { Instance } from '../../src/domain/types';

const INSTANCE_ORG: Instance = {
  id: 'i_scope01',
  baseUrl: 'https://git.example.test',
  capabilities: {
    actions: 'org',
    notifications: true,
    orgs: ['acme', 'other-org'],
    missingScopes: [],
  },
};

const INSTANCE_REPO_MODE: Instance = {
  id: 'i_scope02',
  baseUrl: 'https://git.example.test',
  capabilities: {
    actions: 'repo',
    notifications: true,
    orgs: ['acme'],
    missingScopes: [],
  },
};

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // sonner's toast queue is a module-level singleton that survives
  // `cleanup()` — a fresh `<Toaster/>` in the next test replays whatever is
  // still "active", which would turn `optionsSaveSuccess` into a duplicate
  // and make `getByText`/`queryByText` throw ("found multiple elements").
  toast.dismiss();
});

async function setActiveInstance(instance: Instance): Promise<void> {
  await setInstances({ instances: [instance], activeInstanceId: instance.id });
}

function renderScopeSection() {
  return render(
    <>
      <ScopeSection />
      <Toaster />
    </>
  );
}

async function clickSave(): Promise<void> {
  fireEvent.click(screen.getByText('optionsSaveButton'));
  await Promise.resolve();
  await Promise.resolve();
}

describe('ScopeSection (T055)', () => {
  it('renders orgs from capabilities.orgs, all checked by default', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();

    const acme = await screen.findByLabelText('acme');
    const other = screen.getByLabelText('other-org');
    expect(acme.getAttribute('aria-checked')).toBe('true');
    expect(other.getAttribute('aria-checked')).toBe('true');
  });

  it('unchecking an org adds it to excludeOrgs on save', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();

    const acme = await screen.findByLabelText('acme');
    fireEvent.click(acme);
    await clickSave();

    const settings = await getSettings();
    expect(settings.scope.excludeOrgs).toEqual(['acme']);
  });

  it('rejects an invalid repo pattern for excludeRepos', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();
    await screen.findByLabelText('acme');

    const inputs = screen.getAllByPlaceholderText('optionsScopeAddRepoPlaceholder');
    fireEvent.input(inputs[0]!, { target: { value: 'not-a-repo' } });
    fireEvent.click(screen.getByText('optionsScopeAddButton_exclude'));

    expect(screen.getByText('optionsScopeInvalidRepo')).toBeTruthy();
    await clickSave();
    const settings = await getSettings();
    expect(settings.scope.excludeRepos).toEqual([]);
  });

  it('accepts a valid repo pattern for includeRepos and persists it', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();
    await screen.findByLabelText('acme');

    const inputs = screen.getAllByPlaceholderText('optionsScopeAddRepoPlaceholder');
    // exclude input is first, include input is second (render order).
    fireEvent.input(inputs[1]!, { target: { value: 'foo/bar' } });
    fireEvent.click(screen.getByText('optionsScopeAddButton_include'));

    expect(screen.getByText('foo/bar')).toBeTruthy();
    await clickSave();

    const settings = await getSettings();
    expect(settings.scope.includeRepos).toEqual(['foo/bar']);
  });

  it('removing an included repo chip drops it before save', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();
    await screen.findByLabelText('acme');

    const inputs = screen.getAllByPlaceholderText('optionsScopeAddRepoPlaceholder');
    fireEvent.input(inputs[1]!, { target: { value: 'foo/bar' } });
    fireEvent.click(screen.getByText('optionsScopeAddButton_include'));
    expect(screen.getByText('foo/bar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'optionsScopeRemoveButton' }));
    expect(screen.queryByText('foo/bar')).toBeNull();

    await clickSave();
    const settings = await getSettings();
    expect(settings.scope.includeRepos).toEqual([]);
  });

  it('unpinning removes the repo from pins storage immediately', async () => {
    await setActiveInstance(INSTANCE_ORG);
    await setPins(INSTANCE_ORG.id, [{ owner: 'acme', name: 'core' }]);
    renderScopeSection();

    const unpinButton = await screen.findByRole('button', { name: 'optionsScopeUnpinButton' });
    fireEvent.click(unpinButton);

    await waitFor(async () => {
      const pins = await getPins(INSTANCE_ORG.id);
      expect(pins).toEqual([]);
    });
  });

  it('shows a candidate-repo counter and warning when the repo-mode limit is exceeded', async () => {
    await setActiveInstance(INSTANCE_REPO_MODE);
    await setPins(
      INSTANCE_REPO_MODE.id,
      Array.from({ length: 25 }, (_, i) => ({ owner: 'acme', name: `repo${i}` }))
    );
    await setSettings({
      ...DEFAULT_SETTINGS,
      scope: {
        ...DEFAULT_SETTINGS.scope,
        includeRepos: Array.from({ length: 10 }, (_, i) => `other/repo${i}`),
      },
      repoModeLimit: 30,
    });

    renderScopeSection();

    await waitFor(() => {
      expect(screen.getByText('optionsScopeRepoModeWarning')).toBeTruthy();
    });
  });

  it('does not warn when under the repo-mode limit', async () => {
    await setActiveInstance(INSTANCE_REPO_MODE);
    await setPins(INSTANCE_REPO_MODE.id, [{ owner: 'acme', name: 'core' }]);

    renderScopeSection();
    await screen.findByText(/optionsScopeRepoModeCounter/);

    expect(screen.queryByText('optionsScopeRepoModeWarning')).toBeNull();
  });

  it('shows a "Сохранено" toast after a successful save (T078)', async () => {
    await setActiveInstance(INSTANCE_ORG);
    renderScopeSection();
    await screen.findByLabelText('acme');

    await clickSave();

    expect(await screen.findByText('optionsSaveSuccess')).toBeTruthy();
  });
});
