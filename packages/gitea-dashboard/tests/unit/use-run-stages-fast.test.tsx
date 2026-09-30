// @vitest-environment happy-dom
// T043: 5s fast stage refresh in `useRunStages` -- only while the tab is
// visible AND I have an active (running/queued) build; only my active runs +
// explicitly expanded active runs; at most 3 stage requests in flight.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../src/domain/types';

const load = vi.fn();
const loadOne = vi.fn();

vi.mock('../../src/features/builds/run-jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/builds/run-jobs')>();
  return {
    ...actual,
    createRunJobsLoader: () => ({
      load: (...a: unknown[]) => load(...a),
      loadOne: (...a: unknown[]) => loadOne(...a),
      get: () => undefined,
    }),
  };
});

import { useRunStages } from '../../src/features/builds/use-run-stages';

function run(id: number, overrides: Partial<Run> = {}): Run {
  return {
    id,
    attempt: 1,
    number: id,
    repo: { owner: 'acme', name: 'platform' },
    branch: 'main',
    event: 'push',
    actor: 'alice',
    headSha: 'abc',
    htmlUrl: `https://gitea.example/acme/platform/actions/runs/${id}`,
    title: 't',
    workflow: 'ci.yml',
    state: 'running',
    startedAt: '2026-09-28T09:00:00.000Z',
    mine: false,
    group: 'others',
    ...overrides,
  };
}

const mineRun = (id: number): Run => run(id, { mine: true, group: 'mine', actor: 'me' });

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

const idsCalled = (): number[] => loadOne.mock.calls.map((c) => (c[0] as Run).id);

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  load.mockReset();
  load.mockResolvedValue(new Map());
  loadOne.mockReset();
  loadOne.mockResolvedValue({ jobs: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T043 useRunStages fast loop', () => {
  it('every 5s refreshes stages of my active runs only (not others)', async () => {
    const runs = [mineRun(1), run(2)];
    renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(0);
    loadOne.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(idsCalled()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(idsCalled()).toEqual([1, 1]);
  });

  it('no fast loop when I have no active builds (others only)', async () => {
    const runs = [run(2), run(3, { state: 'success' })];
    renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(0);
    loadOne.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(loadOne).not.toHaveBeenCalled();
  });

  it('no fast loop while the tab is hidden; resumes when visible again', async () => {
    setVisibility('hidden');
    const runs = [mineRun(1)];
    renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(loadOne).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(idsCalled()).toContain(1);
  });

  it('at most 3 stage requests in flight', async () => {
    const runs = [1, 2, 3, 4, 5].map(mineRun);
    let inFlight = 0;
    let maxInFlight = 0;
    loadOne.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1000));
      inFlight -= 1;
      return { jobs: [] };
    });
    renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('an expanded active run of someone else joins the fast loop while I have active builds', async () => {
    const other = run(7);
    const runs = [mineRun(1), other];
    const { result } = renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(0);
    await act(async () => {
      await result.current.loadOne(other);
    });
    loadOne.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(idsCalled().sort()).toEqual([1, 7]);
  });

  it('T048 L6: collapsing (release) drops an expanded active run from the fast loop', async () => {
    const other = run(7);
    const runs = [mineRun(1), other];
    const { result } = renderHook(() => useRunStages(runs, 'me'));
    await vi.advanceTimersByTimeAsync(0);
    await act(async () => {
      await result.current.loadOne(other);
    });
    act(() => {
      result.current.release(other);
    });
    loadOne.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(idsCalled()).toEqual([1]);
  });
});
