// @vitest-environment happy-dom
// T057: BuildsGroups (popup/dashboard "Сборки" groups) — a waiting/blocked
// run with no `startedAt` yet must show at the TOP of its group immediately
// (not sink to the bottom like a run that started at epoch used to).
// Contract: docs/specs/002-fullpage-dashboard/tasks.md T057.
import { render, screen, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import type { Run, Snapshot } from '../../src/domain/types';
import { BuildsGroups } from '../../src/features/builds/BuildsGroups';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});

afterEach(() => {
  cleanup();
});

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    number: 1,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'me',
    headSha: 'deadbeef',
    htmlUrl: 'https://git.example.test/acme/platform/actions/runs/1',
    title: 'push: main',
    workflow: 'ci.yml',
    state: 'success',
    startedAt: '2026-09-26T09:00:00.000Z',
    completedAt: '2026-09-26T09:05:00.000Z',
    mine: true,
    group: 'mine',
    ...overrides,
  };
}

function snapshotWith(runs: Run[]): Snapshot {
  return {
    fetchedAt: '2026-09-26T10:00:00.000Z',
    prs: [],
    runs,
    counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
  };
}

describe('BuildsGroups: waiting run without startedAt (T057)', () => {
  it('shows the waiting run at the top of "Мои и закреплённые" immediately, above a running run with a real time', () => {
    const runningWithTime = run({
      id: 1,
      workflow: 'ci.yml',
      state: 'running',
      startedAt: '2026-09-26T09:00:00.000Z',
      completedAt: undefined,
    });
    const waitingNoTime = run({
      id: 2,
      workflow: 'lint.yml',
      state: 'waiting',
      startedAt: undefined,
      completedAt: undefined,
    });

    render(
      <BuildsGroups
        snapshot={snapshotWith([runningWithTime, waitingNoTime])}
        density="compact"
        heartbeat={false}
      />
    );

    const mineList = within(screen.getByRole('listbox', { name: 'buildsGroupMine' }));
    const options = mineList.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(within(options[0]!).getByText('lint.yml')).toBeTruthy();
    expect(within(options[1]!).getByText('ci.yml')).toBeTruthy();
  });
});
