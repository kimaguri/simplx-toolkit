// @vitest-environment happy-dom
// T055: the real BuildsHistory + the real history loader against a fake
// Gitea org with live-shaped runs (tests/fixtures/fake-gitea-org.ts) — no
// loader mock. Owner report 28.09: «Сегодня» showed 1 of 9 releases and the
// period switch changed nothing.
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { setInstances, setSettings, setToken, setUiState } from '../../src/lib/storage';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import { BuildsHistory } from '../../src/features/builds/BuildsHistory';
import { buildOrgRuns, fakeGitea, ORG, type FakeGitea } from '../fixtures/fake-gitea-org';

const NOW = new Date('2026-09-28T18:30:00Z');

let fake: FakeGitea;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  window.location.hash = '#/builds?view=history';
  fake = fakeGitea(buildOrgRuns({ now: NOW, days: 35, perDay: 200, notStartedEvery: 13, waitingHead: true }));
  vi.stubGlobal('fetch', fake.fetch);
  const inst = {
    id: 'i_live0001',
    baseUrl: 'https://git.example.test',
    login: 'me',
    capabilities: { actions: 'org' as const, notifications: false, orgs: [ORG], missingScopes: [] },
  };
  await setInstances({ instances: [inst], activeInstanceId: inst.id });
  await setToken(inst.id, 'test-token');
  await setSettings(DEFAULT_SETTINGS);
  await setUiState({ pageSize: 100 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function buildsCount(): number {
  return Number(screen.getByTestId('history-count-builds').textContent);
}

describe('BuildsHistory with the real loader (T055)', () => {
  it('«Сегодня» shows all 9 releases on the «Сборки» tab with the «релиз» badge', async () => {
    render(<BuildsHistory />);
    const table = await screen.findByTestId('history-runs-table');
    await waitFor(() => expect(within(table).getAllByText('historyKindRelease')).toHaveLength(9));
    for (const tag of ['v1.39.1', 'v1.40.0', 'v1.41.0', 'v1.41.1', 'v1.42.1', 'v1.43.0', 'v1.44.0', 'v1.45.0', 'v1.45.1']) {
      expect(within(table).getByText(tag)).toBeTruthy();
    }
  });

  it('switching to «7 дн» requests further pages immediately and shows more runs', async () => {
    render(<BuildsHistory />);
    await screen.findByTestId('history-runs-table');
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getAllByText('historyKindRelease')).toHaveLength(9));
    const todayRequests = fake.runRequests.length;
    const todayBuilds = buildsCount();

    fireEvent.click(screen.getByRole('radio', { name: 'historyPeriod7d' }));

    await waitFor(() => expect(fake.runRequests.length).toBeGreaterThan(todayRequests));
    expect(fake.runRequests[todayRequests]).toBe(`org:${ORG}?page=${todayRequests + 1}`);
    await waitFor(() => expect(buildsCount()).toBeGreaterThan(todayBuilds));
  });

  it('«Диагностика» is collapsed under the table and shows per-source numbers when opened', async () => {
    render(<BuildsHistory />);
    await screen.findByTestId('history-runs-table');
    await waitFor(() => expect(within(screen.getByTestId('history-runs-table')).getAllByText('historyKindRelease')).toHaveLength(9));

    const toggle = screen.getByRole('button', { name: /historyDiagToggle/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('history-diagnostics')).toBeNull();

    fireEvent.click(toggle);
    const panel = await screen.findByTestId('history-diagnostics');
    const row = within(panel).getByTestId(`history-diag-org:${ORG}`);
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[0]).toBe(`org:${ORG}`);
    // requests this call, pages walked, runs cached, server total
    expect(Number(cells[1])).toBeGreaterThanOrEqual(4);
    expect(Number(cells[2])).toBeGreaterThanOrEqual(4);
    expect(Number(cells[3])).toBeGreaterThan(180);
    expect(Number(cells[4])).toBe(35 * 200 + 9 + 1);
    // oldest startedAt is a real date of the day before (not 1970), not exhausted
    expect(cells[5]).toContain('2026-09-27');
    expect(cells[6]).toBe('historyDiagNo');
    expect(within(panel).getByTestId('history-diag-summary').textContent).toContain('historyDiagSummary');
  });
});
