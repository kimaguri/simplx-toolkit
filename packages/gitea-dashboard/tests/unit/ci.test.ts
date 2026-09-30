// Contract: docs/specs/001-gitea-dashboard/data-model.md "CiStatus" (R7 in research.md).
import { describe, expect, it } from 'vitest';
import { isFinal, toCiStatus } from '../../src/domain/ci';
import type { ApiCombinedStatus } from '../../src/api/types';
import statusSuccessFixture from '../fixtures/status-success.json';
import statusWarningFixture from '../fixtures/status-warning.json';
import statusEmptyFixture from '../fixtures/status-empty.json';

const NOW = '2026-09-26T09:05:00Z';

describe('toCiStatus', () => {
  it('maps total_count:0 to none even when Gitea reports state:"pending" (empty response quirk)', () => {
    const fixture = statusEmptyFixture as ApiCombinedStatus;
    expect(fixture.state).toBe('pending');
    expect(fixture.total_count).toBe(0);

    const status = toCiStatus(fixture, NOW);

    expect(status.state).toBe('none');
    expect(status.fetchedAt).toBe(NOW);
  });

  it('maps a genuine success status straight through', () => {
    const status = toCiStatus(statusSuccessFixture as ApiCombinedStatus, NOW);
    expect(status.state).toBe('success');
    expect(status.fetchedAt).toBe(NOW);
  });

  it('maps warning straight through (shown as warning, not failure)', () => {
    const status = toCiStatus(statusWarningFixture as ApiCombinedStatus, NOW);
    expect(status.state).toBe('warning');
  });

  it('maps error to error (UI shows it as a failure)', () => {
    const combined: ApiCombinedStatus = { state: 'error', total_count: 1, statuses: [{}] };
    expect(toCiStatus(combined, NOW).state).toBe('error');
  });

  it('maps failure to failure', () => {
    const combined: ApiCombinedStatus = { state: 'failure', total_count: 1, statuses: [{}] };
    expect(toCiStatus(combined, NOW).state).toBe('failure');
  });

  it('maps skipped to skipped (UI shows "no checks")', () => {
    const combined: ApiCombinedStatus = { state: 'skipped', total_count: 1, statuses: [{}] };
    expect(toCiStatus(combined, NOW).state).toBe('skipped');
  });

  it('maps a genuine pending status (total_count > 0) to pending', () => {
    const combined: ApiCombinedStatus = { state: 'pending', total_count: 1, statuses: [{}] };
    expect(toCiStatus(combined, NOW).state).toBe('pending');
  });
});

describe('isFinal', () => {
  it('is false for pending (not final — will be re-checked, FR-022)', () => {
    expect(isFinal({ state: 'pending', fetchedAt: NOW })).toBe(false);
  });

  it.each(['success', 'failure', 'error', 'warning', 'skipped', 'none'] as const)(
    'is true for %s',
    (state) => {
      expect(isFinal({ state, fetchedAt: NOW })).toBe(true);
    }
  );
});
