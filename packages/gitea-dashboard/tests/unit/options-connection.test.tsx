// @vitest-environment happy-dom
// T024/T025 [US1] — Options page "Подключение" section.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-001..004, FR-075;
// contracts/extension-surface.md ("check-connection", optional_host_permissions).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { ConnectionSection } from '../../src/entrypoints/options/Options';
import { Toaster } from '../../src/components/ui/sonner';
import { getInstances, getToken, setInstances, setToken } from '../../src/lib/storage';
import type { ConnectionReport, Instance } from '../../src/domain/types';

/** T078: the "Сохранить"/"Проверить" feedback moved from a bare `role="status"`
 * paragraph to a sonner toast (owner complaint: saving looked like nothing
 * happened). The Toaster is normally mounted once in `Options` — mount it
 * alongside the section here so `toast.success/error(...)` actually renders
 * into the DOM the same way it does on the real page. */
function renderConnectionSection() {
  return render(
    <>
      <ConnectionSection />
      <Toaster />
    </>
  );
}

const BASE_URL_A = 'https://git.example.test';
const BASE_URL_B = 'https://other.example.test';

const INSTANCE_A: Instance = {
  id: 'i_aaaa0001',
  baseUrl: BASE_URL_A,
  capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
};

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({ version: '0.1.0' } as never);
  // fakeBrowser has no `permissions` implementation beyond stubs that throw —
  // give every test a controllable request/remove pair.
  // `request`/`remove` are overloaded (promise form + legacy callback form),
  // which collapses vi.spyOn's inferred mock type to the callback overload's
  // `void` return — cast the resolved value to satisfy that inferred type
  // while the mock still resolves `true` at runtime.
  vi.spyOn(browser.permissions, 'request').mockResolvedValue(true as never);
  vi.spyOn(browser.permissions, 'remove').mockResolvedValue(true as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // sonner's toast queue is a module-level singleton (outside React) that
  // survives `cleanup()` — a fresh `<Toaster/>` in the next test replays
  // whatever is still "active" to it (see sonner's `Observer.subscribe`),
  // which turns `optionsSaveSuccess` from earlier tests into a duplicate
  // that makes `getByText`/`queryByText` throw ("found multiple elements").
  toast.dismiss();
});

function fillUrl(value: string): void {
  const input = screen.getByLabelText('optionsUrlLabel') as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

function fillToken(value: string): HTMLInputElement {
  const input = screen.getByLabelText('optionsTokenLabel') as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  return input;
}

async function clickSave(): Promise<void> {
  fireEvent.click(screen.getByText('optionsSaveButton'));
  // The click handler runs several awaits (permissions.request, storage,
  // instanceId's crypto.subtle.digest); wait for its final, observable
  // effect instead of guessing a fixed number of microtask ticks.
  await waitFor(() => {
    expect(
      screen.queryByText('optionsSaveSuccess') ?? screen.queryByText('optionsPermissionDenied')
    ).toBeTruthy();
  });
}

describe('Options ConnectionSection — save (T025)', () => {
  it('requests exactly <origin>/* and stores the token only in storage.local', async () => {
    renderConnectionSection();

    fillUrl(BASE_URL_A);
    fillToken('test-token');
    await clickSave();

    expect(browser.permissions.request).toHaveBeenCalledWith({
      origins: [`${BASE_URL_A}/*`],
    });
    expect(browser.permissions.request).toHaveBeenCalledTimes(1);

    const { instances, activeInstanceId } = await getInstances();
    expect(activeInstanceId).toBeTruthy();
    const token = await getToken(activeInstanceId!);
    expect(token).toBe('test-token');
    expect(instances.find((i) => i.id === activeInstanceId)?.baseUrl).toBe(BASE_URL_A);

    // The token must never land in storage.sync.
    const sync = await fakeBrowser.storage.sync.get(null);
    expect(JSON.stringify(sync)).not.toContain('test-token');
  });

  it('denied permission: nothing is saved', async () => {
    vi.spyOn(browser.permissions, 'request').mockResolvedValue(false as never);
    renderConnectionSection();

    fillUrl(BASE_URL_A);
    fillToken('test-token');
    await clickSave();

    const { instances, activeInstanceId } = await getInstances();
    expect(activeInstanceId).toBeUndefined();
    expect(instances).toEqual([]);

    const local = await fakeBrowser.storage.local.get(null);
    expect(JSON.stringify(local)).not.toContain('test-token');
    expect(screen.getByText('optionsPermissionDenied')).toBeTruthy();
  });

  it('changing the origin removes the previous one', async () => {
    await setInstances({ instances: [INSTANCE_A], activeInstanceId: INSTANCE_A.id });
    await setToken(INSTANCE_A.id, 'old-token');

    renderConnectionSection();

    // The section loads the active instance's baseUrl on mount.
    await screen.findByDisplayValue(BASE_URL_A);
    fillUrl(BASE_URL_B);
    await clickSave();

    expect(browser.permissions.request).toHaveBeenCalledWith({
      origins: [`${BASE_URL_B}/*`],
    });
    expect(browser.permissions.remove).toHaveBeenCalledWith({
      origins: [`${BASE_URL_A}/*`],
    });

    const { activeInstanceId, instances } = await getInstances();
    expect(instances.find((i) => i.id === activeInstanceId)?.baseUrl).toBe(BASE_URL_B);
  });

  it('changing the origin removes the previous instance token from storage', async () => {
    await setInstances({ instances: [INSTANCE_A], activeInstanceId: INSTANCE_A.id });
    await setToken(INSTANCE_A.id, 'old-token');

    renderConnectionSection();

    await screen.findByDisplayValue(BASE_URL_A);
    fillUrl(BASE_URL_B);
    await clickSave();

    // The old instance id is no longer the active one, and its token must be
    // gone from storage.local entirely (not just superseded).
    expect(await getToken(INSTANCE_A.id)).toBeUndefined();
  });

  it('saving the same origin again does not remove its own token', async () => {
    await setInstances({ instances: [INSTANCE_A], activeInstanceId: INSTANCE_A.id });
    await setToken(INSTANCE_A.id, 'old-token');

    renderConnectionSection();

    await screen.findByDisplayValue(BASE_URL_A);
    await clickSave();

    expect(await getToken(INSTANCE_A.id)).toBe('old-token');
  });

  it('auto-checks after save and only sends settings-changed once the check resolves (real capabilities before the poller restarts)', async () => {
    const report: ConnectionReport = {
      ok: true,
      login: 'octocat',
      version: '1.27.3',
      actions: 'org',
      missingScopes: [],
      messageKey: 'diag_ok',
    };
    const sendMessageSpy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockImplementation(async (message: unknown) => {
        const type = (message as { type: string }).type;
        if (type === 'check-connection') return report as never;
        if (type === 'settings-changed') return { ok: true } as never;
        throw new Error(`unexpected message ${type}`);
      });

    renderConnectionSection();
    fillUrl(BASE_URL_A);
    fillToken('test-token');
    await clickSave();

    await waitFor(() => expect(screen.queryByText('diag_ok')).toBeTruthy());

    const relevantCalls = sendMessageSpy.mock.calls
      .map(([message]) => (message as unknown as { type: string }).type)
      .filter((type) => type === 'check-connection' || type === 'settings-changed');
    expect(relevantCalls).toEqual(['check-connection', 'settings-changed']);

    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'check-connection',
      baseUrl: BASE_URL_A,
      token: 'test-token',
      persist: true,
    });
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'settings-changed' });

    // The report from the auto-check is rendered, same as a manual Check.
    expect(screen.getByText('diag_ok')).toBeTruthy();
    expect(screen.getByText('optionsLoginLabel')).toBeTruthy();
    expect(screen.getByText('optionsActionsMode_org')).toBeTruthy();
  });

  it('never renders the stored token back, and the field disappears after saving one', async () => {
    renderConnectionSection();

    expect(screen.queryByLabelText('optionsTokenLabel')).toBeTruthy();
    fillUrl(BASE_URL_A);
    fillToken('super-secret-token');
    await clickSave();

    // Token field is gone (replaced by the "saved" indicator) and the token
    // text is nowhere in the DOM.
    expect(screen.queryByLabelText('optionsTokenLabel')).toBeNull();
    expect(document.body.innerHTML).not.toContain('super-secret-token');
    expect(screen.getByText('optionsTokenSaved')).toBeTruthy();
  });
});

describe('Options ConnectionSection — check (T024)', () => {
  it('renders the diagnosis report via the background message', async () => {
    const report: ConnectionReport = {
      ok: true,
      login: 'octocat',
      version: '1.27.3',
      actions: 'org',
      missingScopes: [],
      messageKey: 'diag_ok',
    };
    const sendMessageSpy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue(report as never);

    renderConnectionSection();
    fillUrl(BASE_URL_A);
    fillToken('test-token');

    fireEvent.click(screen.getByText('optionsCheckButton'));
    await waitFor(() => expect(screen.queryByText('diag_ok')).toBeTruthy());

    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'check-connection',
      baseUrl: BASE_URL_A,
      token: 'test-token',
      persist: false,
    });

    expect(screen.getByText('diag_ok')).toBeTruthy();
    expect(screen.getByText('optionsLoginLabel')).toBeTruthy();
    expect(screen.getByText('optionsVersionValueLabel')).toBeTruthy();
    expect(screen.getByText('optionsActionsMode_org')).toBeTruthy();
  });

  it('renders missing scopes from a scope-diagnosis report', async () => {
    const report: ConnectionReport = {
      ok: false,
      kind: 'scope',
      actions: 'unsupported',
      missingScopes: ['read:organization'],
      messageKey: 'diag_scope',
    };
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(report as never);

    renderConnectionSection();
    fillUrl(BASE_URL_A);
    fillToken('test-token');
    fireEvent.click(screen.getByText('optionsCheckButton'));
    await waitFor(() => expect(screen.queryByText('diag_scope')).toBeTruthy());

    expect(screen.getByText('diag_scope')).toBeTruthy();
    expect(screen.getByText('optionsMissingScopesLabel')).toBeTruthy();
  });
});
