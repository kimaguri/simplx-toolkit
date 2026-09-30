// Contract: docs/specs/001-gitea-dashboard/plan.md "Structure Decision",
// data-model.md (Snapshot incl. sectionErrors, PollState, "Опрос"),
// contracts/extension-surface.md ("Alarms", "Словарь ошибок").
//
// Uses fakeBrowser (via storage.ts, backed by wxt/testing) + fake in-memory
// sections. No real HTTP is made — the ApiClient passed to sections is a
// stub that throws if a section actually tries to use it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ApiError } from '../../src/api/client';
import type { Instance, PullRequest, Snapshot } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';
import { createPoller, type Section, type SectionContext } from '../../src/background/poller';

const INSTANCE: Instance = {
  id: 'i_test0001',
  baseUrl: 'https://gitea.example.com',
  login: 'me',
  capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
};

function fakeClientFactory(): ApiClient {
  return {
    async get() {
      throw new Error('unused stub client: this test never performs real HTTP');
    },
    async getWithMeta() {
      throw new Error('unused stub client: this test never performs real HTTP');
    },
  };
}

function createSection(
  name: Section['name'],
  impl: (ctx: SectionContext) => Promise<Partial<Snapshot>>
): Section & { calls: SectionContext[] } {
  const calls: SectionContext[] = [];
  return {
    name,
    calls,
    async run(ctx) {
      calls.push(ctx);
      return impl(ctx);
    },
  };
}

function makePr(id: number): PullRequest {
  return {
    id,
    repo: { owner: 'acme', name: 'widgets' },
    number: id,
    title: `PR ${id}`,
    author: 'someone',
    updatedAt: '2025-01-01T00:00:00.000Z',
    htmlUrl: `https://gitea.example.com/acme/widgets/pulls/${id}`,
    draft: false,
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2025-01-01T00:00:00.000Z' },
  };
}

beforeEach(async () => {
  await storage.setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await storage.setToken(INSTANCE.id, 'test-token');
});

describe('createPoller — mutex', () => {
  it('a second concurrent runCycle call returns the same in-flight promise', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const prs = createSection('prs', async () => {
      await gate;
      return { prs: [] };
    });
    const runs = createSection('runs', async () => ({ runs: [] }));
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    const p1 = poller.runCycle('base');
    const p2 = poller.runCycle('base');

    // Same promise identity proves the second call did not start a parallel
    // cycle — it just piggy-backed on the first one.
    expect(p1).toBe(p2);
    expect(poller.isRunning()).toBe(true);

    releaseGate?.();
    await p1;
    await p2;

    expect(prs.calls.length).toBe(1);
    expect(poller.isRunning()).toBe(false);
  });
});

describe('createPoller — mode coalescing', () => {
  it('base requested while fast is in flight queues one base cycle that runs after fast finishes', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const prs = createSection('prs', async () => ({ prs: [] })); // not fast: skipped by the fast cycle
    const runs = createSection('runs', async () => {
      await gate;
      return { runs: [] };
    });
    runs.fast = true;
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    const fastPromise = poller.runCycle('fast');
    const basePromise = poller.runCycle('base');

    expect(basePromise).not.toBe(fastPromise);
    // Fast cycle still gated on `runs`; the non-fast `prs` section has not
    // run yet at all (fast skips it, the queued base hasn't started).
    expect(prs.calls.length).toBe(0);

    releaseGate?.();
    await fastPromise;
    await basePromise;

    // The queued base cycle ran once, covering the non-fast `prs` section.
    expect(prs.calls.length).toBe(1);
    // `runs` (fast:true) ran once in the fast cycle and once in the queued base cycle.
    expect(runs.calls.length).toBe(2);
  });

  it('two base requests arriving during the same fast cycle share a single queued base cycle', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const prs = createSection('prs', async () => ({ prs: [] }));
    const runs = createSection('runs', async () => {
      await gate;
      return { runs: [] };
    });
    runs.fast = true;
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    const fastPromise = poller.runCycle('fast');
    const base1 = poller.runCycle('base');
    const base2 = poller.runCycle('base');

    expect(base1).toBe(base2);

    releaseGate?.();
    await fastPromise;
    await base1;
    await base2;

    // Only one queued base cycle ran, not two.
    expect(prs.calls.length).toBe(1);
  });

  it('fast requested while base is in flight returns the base promise, running no extra cycle', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const prs = createSection('prs', async () => {
      await gate;
      return { prs: [] };
    });
    const runs = createSection('runs', async () => ({ runs: [] }));
    runs.fast = true;
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    const basePromise = poller.runCycle('base');
    const fastPromise = poller.runCycle('fast');

    expect(fastPromise).toBe(basePromise);

    releaseGate?.();
    await basePromise;
    await fastPromise;

    // The base cycle already covers `runs` (fast:true) — no separate fast
    // cycle ran, so each section ran exactly once.
    expect(prs.calls.length).toBe(1);
    expect(runs.calls.length).toBe(1);
  });
});

describe('createPoller — per-section errors', () => {
  it('a failing section writes sectionErrors while other sections still update the snapshot', async () => {
    const newPrs = [makePr(1)];
    const prs = createSection('prs', async () => ({ prs: newPrs }));
    const runs = createSection('runs', async () => {
      throw new ApiError('server', 'workflow runs endpoint is down');
    });
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(INSTANCE.id);
    expect(snapshot?.sectionErrors?.runs?.kind).toBe('server');
    expect(snapshot?.prs).toEqual(newPrs);
    // Only one of two network sections failed — this is not a whole-cycle
    // network outage, so no top-level snapshot.error is set.
    expect(snapshot?.error).toBeUndefined();
  });
});

describe('createPoller — whole-cycle network outage', () => {
  it('keeps previous prs/runs/fetchedAt and sets error.kind="network" when every network section fails', async () => {
    const prevSnapshot: Snapshot = {
      fetchedAt: '2025-06-01T00:00:00.000Z',
      prs: [makePr(7)],
      runs: [],
      counts: { reviews: 1, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    };
    await storage.setSnapshot(INSTANCE.id, prevSnapshot);

    const prs = createSection('prs', async () => {
      throw new ApiError('unreachable', 'dns failure');
    });
    const runs = createSection('runs', async () => {
      throw new ApiError('unreachable', 'dns failure');
    });
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory });

    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(INSTANCE.id);
    expect(snapshot?.prs).toEqual(prevSnapshot.prs);
    expect(snapshot?.runs).toEqual(prevSnapshot.runs);
    expect(snapshot?.fetchedAt).toBe(prevSnapshot.fetchedAt);
    expect(snapshot?.error?.kind).toBe('network');
  });
});

describe('createPoller — auth pause', () => {
  it('a 401 anywhere pauses the poller, stops the cycle, and blocks further fetches until resume()', async () => {
    let authShouldFail = true;
    const authSection = createSection('prs', async () => {
      if (authShouldFail) throw new ApiError('auth', 'bad token');
      return { prs: [] };
    });
    const laterSection = createSection('runs', async () => ({ runs: [] }));
    const poller = createPoller({
      sections: [authSection, laterSection],
      clientFactory: fakeClientFactory,
    });

    await poller.runCycle('base');

    let snapshot = await storage.getSnapshot(INSTANCE.id);
    let pollState = await storage.getPollState(INSTANCE.id);
    expect(snapshot?.error?.kind).toBe('auth');
    expect(pollState?.pausedForAuth).toBe(true);
    // The cycle stopped right after the auth error — later sections never ran.
    expect(laterSection.calls.length).toBe(0);

    // While paused, runCycle must be a no-op: no further fetches at all.
    await poller.runCycle('base');
    expect(authSection.calls.length).toBe(1);
    expect(laterSection.calls.length).toBe(0);

    await poller.resume();
    pollState = await storage.getPollState(INSTANCE.id);
    expect(pollState?.pausedForAuth).toBe(false);

    // Once the token is fixed and the poller resumed, cycles run normally
    // again — including sections after the one that used to fail.
    authShouldFail = false;
    await poller.runCycle('base');
    expect(authSection.calls.length).toBe(2);
    expect(laterSection.calls.length).toBe(1);
  });
});

describe('createPoller — backoff', () => {
  it('backs off 60→120→240→480→600 on repeated network/server failures and resets to 0 on success', async () => {
    let currentTimeMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const now = () => new Date(currentTimeMs);
    let shouldFail = true;

    const prs = createSection('prs', async () => {
      if (shouldFail) throw new ApiError('unreachable', 'down');
      return { prs: [] };
    });
    const runs = createSection('runs', async () => {
      if (shouldFail) throw new ApiError('unreachable', 'down');
      return { runs: [] };
    });
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory, now });

    const expectedSequence = [60, 120, 240, 480, 600, 600];
    for (const expectedBackoff of expectedSequence) {
      await poller.runCycle('base');
      const pollState = await storage.getPollState(INSTANCE.id);
      expect(pollState?.backoffSec).toBe(expectedBackoff);
      currentTimeMs += expectedBackoff * 1000;
    }

    shouldFail = false;
    await poller.runCycle('base');
    const finalState = await storage.getPollState(INSTANCE.id);
    expect(finalState?.backoffSec).toBe(0);
  });

  it('skips the cycle body (no fetch) while now < nextAllowedAt, and resumes once the backoff elapses', async () => {
    let currentTimeMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const now = () => new Date(currentTimeMs);

    const prs = createSection('prs', async () => {
      throw new ApiError('unreachable', 'down');
    });
    const runs = createSection('runs', async () => {
      throw new ApiError('unreachable', 'down');
    });
    const poller = createPoller({ sections: [prs, runs], clientFactory: fakeClientFactory, now });

    await poller.runCycle('base');
    expect(prs.calls.length).toBe(1);
    const pollState = await storage.getPollState(INSTANCE.id);
    expect(pollState?.backoffSec).toBe(60);

    // Same instant: still within the backoff window — must not fetch again.
    await poller.runCycle('base');
    expect(prs.calls.length).toBe(1);

    // Advance past nextAllowedAt: the cycle runs (and fails) again.
    currentTimeMs += 60_000;
    await poller.runCycle('base');
    expect(prs.calls.length).toBe(2);
  });
});
