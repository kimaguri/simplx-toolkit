// @vitest-environment happy-dom
// T054 [US6] — Options page "Опрос и бейдж" / "Уведомления" sections.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-034/035/040/050/060,
// data-model.md "Settings" (defaults + validation ranges).
//
// T078: sections moved to shadcn Card/Select/Switch. Radix Select renders
// its trigger as a labelable <button role="combobox"> and its options as
// `role="option"` inside a portal — `getByLabelText` still finds the
// trigger (a native <button> is a labelable element), but choosing a value
// now means opening the trigger and clicking the option instead of firing a
// native `change` event. Radix Switch is a labelable <button role="switch">
// toggled with a plain click. Save feedback moved from an inline
// `role="status"` paragraph to a sonner toast — the Toaster is mounted
// alongside each section, same as it is once in the real `Options` page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { PollingSection } from '../../src/entrypoints/options/PollingSection';
import { NotificationsSection } from '../../src/entrypoints/options/NotificationsSection';
import { Toaster } from '../../src/components/ui/sonner';
import { getSettings, setSettings } from '../../src/lib/storage';
import { DEFAULT_SETTINGS } from '../../src/domain/types';

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

function fillNumber(labelKey: string, value: string): void {
  const input = screen.getByLabelText(labelKey) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

/** Opens a shadcn/Radix Select by its trigger's accessible label, then picks
 * the option whose visible text is `optionLabelKey`. */
function chooseSelectOption(triggerLabelKey: string, optionLabelKey: string): void {
  const trigger = screen.getByLabelText(triggerLabelKey);
  fireEvent.click(trigger);
  const option = screen.getByRole('option', { name: optionLabelKey });
  fireEvent.click(option);
}

function toggleSwitch(labelKey: string): void {
  fireEvent.click(screen.getByLabelText(labelKey));
}

async function clickSave(container: Element): Promise<void> {
  const scope = within(container as HTMLElement);
  fireEvent.click(scope.getByText('optionsSaveButton'));
  // getSettings/setSettings/sendMessage are async; wait for the save to
  // finish (a toast — success or error — appears once it settles). Toasts
  // render into a sonner portal outside `container`, so this waits on the
  // whole document rather than the section's own DOM.
  await waitFor(() => {
    const status =
      screen.queryByText('optionsSaveSuccess') ??
      screen.queryByText('optionsPollIntervalError');
    const alert = scope.queryAllByRole('alert');
    expect(Boolean(status) || alert.length > 0).toBe(true);
  });
}

describe('PollingSection (T054)', () => {
  it('renders defaults', async () => {
    render(<PollingSection />);
    await screen.findByLabelText('optionsPollIntervalLabel');
    expect((screen.getByLabelText('optionsPollIntervalLabel') as HTMLInputElement).value).toBe(
      '60'
    );
    expect(screen.getByLabelText('optionsBadgeModeLabel').textContent).toContain(
      'optionsBadgeMode_reviews'
    );
    expect(
      (screen.getByLabelText('optionsRecentWindowLabel') as HTMLInputElement).value
    ).toBe('24');
    expect(
      (screen.getByLabelText('optionsRedBadgeWindowLabel') as HTMLInputElement).value
    ).toBe('30');
    expect(screen.getByLabelText('optionsShowOtherPrsLabel').getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('rejects an interval below 30 and does not persist it', async () => {
    const { container } = render(
      <>
        <PollingSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsPollIntervalLabel');

    fillNumber('optionsPollIntervalLabel', '20');
    await clickSave(container);

    expect(screen.getAllByText('optionsPollIntervalError').length).toBeGreaterThan(0);
    const settings = await getSettings();
    expect(settings.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec);
  });

  it('persists a valid interval change and notifies the background', async () => {
    const sendMessageSpy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: true } as never);
    const { container } = render(
      <>
        <PollingSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsPollIntervalLabel');

    fillNumber('optionsPollIntervalLabel', '90');
    await clickSave(container);

    const settings = await getSettings();
    expect(settings.pollIntervalSec).toBe(90);
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'settings-changed' });
    expect(screen.queryByText('optionsPollIntervalError')).toBeNull();
  });

  it('rejects an out-of-range recent window and red badge window', async () => {
    const { container } = render(
      <>
        <PollingSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsRecentWindowLabel');

    fillNumber('optionsRecentWindowLabel', '200');
    fillNumber('optionsRedBadgeWindowLabel', '3');
    await clickSave(container);

    expect(screen.getByText('optionsRecentWindowError')).toBeTruthy();
    expect(screen.getByText('optionsRedBadgeWindowError')).toBeTruthy();
    const settings = await getSettings();
    expect(settings.recentWindowHours).toBe(DEFAULT_SETTINGS.recentWindowHours);
    expect(settings.redBadgeWindowMin).toBe(DEFAULT_SETTINGS.redBadgeWindowMin);
  });

  it('changes badge mode and showOtherPrs', async () => {
    const { container } = render(
      <>
        <PollingSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsBadgeModeLabel');

    chooseSelectOption('optionsBadgeModeLabel', 'optionsBadgeMode_builds');
    toggleSwitch('optionsShowOtherPrsLabel');
    await clickSave(container);

    const settings = await getSettings();
    expect(settings.badgeMode).toBe('builds');
    expect(settings.showOtherPrs).toBe(false);
  });

  it('does not clobber existing scope/notify settings on save', async () => {
    await setSettings({
      ...DEFAULT_SETTINGS,
      scope: { ...DEFAULT_SETTINGS.scope, excludeOrgs: ['acme'] },
      notify: { ...DEFAULT_SETTINGS.notify, comments: true },
    });
    const { container } = render(
      <>
        <PollingSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsPollIntervalLabel');

    fillNumber('optionsPollIntervalLabel', '90');
    await clickSave(container);

    const settings = await getSettings();
    expect(settings.scope.excludeOrgs).toEqual(['acme']);
    expect(settings.notify.comments).toBe(true);
  });
});

describe('NotificationsSection (T054)', () => {
  it('renders defaults', async () => {
    render(<NotificationsSection />);
    await screen.findByLabelText('optionsNotifyBuildFailedLabel');
    expect(screen.getByLabelText('optionsNotifyBuildFailedLabel').textContent).toContain(
      'optionsNotifyBuildFailed_mine'
    );
    expect(
      screen.getByLabelText('optionsNotifyBuildSucceededLabel').getAttribute('aria-checked')
    ).toBe('false');
    expect(
      screen.getByLabelText('optionsNotifyReviewRequestedLabel').getAttribute('aria-checked')
    ).toBe('true');
    expect(
      screen.getByLabelText('optionsNotifyCommentsLabel').getAttribute('aria-checked')
    ).toBe('false');
  });

  it('persists notify toggles and sends settings-changed', async () => {
    const sendMessageSpy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: true } as never);
    const { container } = render(
      <>
        <NotificationsSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsNotifyBuildFailedLabel');

    chooseSelectOption('optionsNotifyBuildFailedLabel', 'optionsNotifyBuildFailed_all');
    toggleSwitch('optionsNotifyBuildSucceededLabel');
    toggleSwitch('optionsNotifyReviewRequestedLabel');
    toggleSwitch('optionsNotifyCommentsLabel');
    await clickSave(container);

    const settings = await getSettings();
    expect(settings.notify).toEqual({
      buildFailed: 'all',
      buildSucceededMyPr: true,
      reviewRequested: false,
      comments: true,
    });
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'settings-changed' });
  });

  it('shows a "Сохранено" toast after a successful save (T078)', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const { container } = render(
      <>
        <NotificationsSection />
        <Toaster />
      </>
    );
    await screen.findByLabelText('optionsNotifyBuildFailedLabel');

    await clickSave(container);

    expect(await screen.findByText('optionsSaveSuccess')).toBeTruthy();
  });
});
