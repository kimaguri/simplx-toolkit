// T048 review defects M1 (queued base is in-flight) and M2 (page-fast keeps fetchedAt).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { Instance, Snapshot } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';
import { createPoller, type Section } from '../../src/background/poller';

const INSTANCE: Instance = {
  id: 'i_t0480001',
  baseUrl: 'https://gitea.example.com',
  login: 'me',
  capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
};
const stubClient = (): ApiClient => ({
  async get() {
    throw new Error('unused');
  },
  async getWithMeta() {
    throw new Error('unused');
  },
});

beforeEach(async () => {
  await storage.setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await storage.setToken(INSTANCE.id, 'test-token');
});

describe('M1: queued base counts as in-flight', () => {
  it('a fast request while the queued base cycle runs shares it (no parallel cycle, one onCycleComplete per cycle)', async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    const section: Section = {
      name: 'runs',
      fast: true,
      async run(ctx) {
        runs.push(ctx.mode);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => gates.push(r));
        active -= 1;
        return { runs: [] };
      },
    };
    const onCycleComplete = vi.fn();
    const poller = createPoller({ sections: [section], clientFactory: stubClient, onCycleComplete });

    const fast1 = poller.runCycle('fast');
    const base = poller.runCycle('base'); // queued behind fast
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]!(); // fast finishes -> queued base starts
    await vi.waitFor(() => expect(runs).toEqual(['fast', 'base']));
    const late = poller.runCycle('page-fast'); // arrives while queued base is running
    await new Promise((r) => setTimeout(r, 20));
    expect(maxActive).toBe(1);
    expect(runs).toEqual(['fast', 'base']);
    gates[1]!();
    await Promise.all([fast1, base, late]);
    expect(onCycleComplete).toHaveBeenCalledTimes(2);
  });
});

describe('M2: page-fast does not advance fetchedAt', () => {
  it('keeps prev.fetchedAt after a page-fast cycle that refreshed runs', async () => {
    const prev: Snapshot = {
      fetchedAt: '2026-09-26T09:00:00.000Z',
      prs: [],
      runs: [],
      counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    };
    await storage.setSnapshot(INSTANCE.id, prev);
    const section: Section = { name: 'runs', fast: true, run: async () => ({ runs: [] }) };
    const poller = createPoller({
      sections: [section],
      clientFactory: stubClient,
      now: () => new Date('2026-09-26T10:00:00.000Z'),
    });
    await poller.runCycle('page-fast');
    const snap = await storage.getSnapshot(INSTANCE.id);
    expect(snap?.fetchedAt).toBe(prev.fetchedAt);
    await poller.runCycle('fast');
    expect((await storage.getSnapshot(INSTANCE.id))?.fetchedAt).toBe('2026-09-26T10:00:00.000Z');
  });
});
