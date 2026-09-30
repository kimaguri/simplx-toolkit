// T055: the history loader against a realistic org (shapes observed on the
// owner's Gitea 1.27.3, see tests/fixtures/fake-gitea-org.ts): ~200 runs a
// day over 5 repos, 50 per page, total_count, tag runs with head_branch
// null. Owner report 28.09: «Сегодня» showed 1 of 9 releases, switching the
// period changed nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHistory, loadMore } from '../../src/features/builds/history-loader';
import { classifyRun } from '../../src/domain/history';
import type { Instance, Run } from '../../src/domain/types';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';
import { buildOrgRuns, fakeGitea, ORG, TODAY_RELEASES, type FakeGitea } from '../fixtures/fake-gitea-org';

const NOW = new Date('2026-09-28T18:30:00Z');
const TODAY_START_MS = Date.parse('2026-09-27T19:00:00Z');

const INSTANCE: Instance = {
  id: 'i_realistic',
  baseUrl: 'https://git.example.test',
  login: 'me',
  capabilities: { actions: 'org', notifications: true, orgs: [ORG], missingScopes: [] },
};

async function setUp(fake: FakeGitea, pins: { owner: string; name: string }[] = []): Promise<void> {
  vi.stubGlobal('fetch', fake.fetch);
  await storage.setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await storage.setToken(INSTANCE.id, 'test-token');
  await storage.setSettings(DEFAULT_SETTINGS);
  await storage.setPins(INSTANCE.id, pins);
}

function releaseTags(runs: Run[]): string[] {
  return runs.filter((r) => classifyRun(r) === 'release').map((r) => `${r.repo.name}@${r.branch}`).sort();
}

const EXPECTED_TAGS = TODAY_RELEASES.map((r) => `${r.repo}@${r.tag}`).sort();

function minutesLater(min: number): Date {
  return new Date(NOW.getTime() + min * 60 * 1000);
}

describe('history loader on a realistic org (T055)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('«Сегодня» returns every release of every repo, «7 дн»/«30 дн» page deeper', async () => {
    const fake = fakeGitea(buildOrgRuns({ now: NOW, days: 35, perDay: 200 }));
    await setUp(fake);

    const today = await loadHistory({ period: 'today', now: NOW });
    expect(releaseTags(today.runs)).toEqual(EXPECTED_TAGS);
    expect(today.runs.every((r) => Date.parse(r.startedAt!) >= TODAY_START_MS)).toBe(true);
    expect(today.runs.length).toBeGreaterThan(180);
    expect(today.hasMore).toBe(false);
    const todayPages = fake.runRequests.length;
    expect(todayPages).toBeGreaterThanOrEqual(4);

    const week = await loadHistory({ period: '7d', now: minutesLater(1) });
    const newPages = fake.runRequests.slice(todayPages);
    expect(newPages.length).toBeGreaterThan(0);
    expect(newPages[0]).toBe(`org:${ORG}?page=${todayPages + 1}`);
    expect(week.runs.length).toBeGreaterThan(today.runs.length);

    const month = await loadHistory({ period: '30d', now: minutesLater(2) });
    expect(month.runs.length).toBeGreaterThan(week.runs.length);
    expect(month.hasMore).toBe(true);
    const more = await loadMore({ period: '30d', now: minutesLater(3) });
    expect(more.runs.length).toBeGreaterThan(month.runs.length);
  });

  it('never-started runs (epoch started_at) do not stop paging: all 9 releases, 7d pages deeper', async () => {
    const fake = fakeGitea(buildOrgRuns({ now: NOW, days: 35, perDay: 200, notStartedEvery: 13, waitingHead: true }));
    await setUp(fake);

    const today = await loadHistory({ period: 'today', now: NOW });
    expect(fake.runRequests.length).toBeGreaterThanOrEqual(4);
    expect(releaseTags(today.runs)).toEqual(EXPECTED_TAGS);
    // The waiting run on top is current, not 1970.
    expect(today.runs.some((r) => r.state === 'blocked')).toBe(true);
    expect(new Date(today.coveredUntil).getTime()).toBeLessThanOrEqual(TODAY_START_MS);

    const before = fake.runRequests.length;
    const week = await loadHistory({ period: '7d', now: minutesLater(1) });
    expect(fake.runRequests.length).toBeGreaterThan(before);
    expect(week.runs.length).toBeGreaterThan(today.runs.length);
  });

  it('with a pinned repo of the org, the org source still delivers every repo', async () => {
    const fake = fakeGitea(buildOrgRuns({ now: NOW, days: 10, perDay: 200, notStartedEvery: 13 }));
    await setUp(fake, [{ owner: ORG, name: 'simplx-apps' }]);

    const today = await loadHistory({ period: 'today', now: NOW });
    expect(releaseTags(today.runs)).toEqual(EXPECTED_TAGS);
  });

  it('a source cached as exhausted is refreshed after the TTL: new runs show up', async () => {
    const small = buildOrgRuns({ now: NOW, days: 30, perDay: 1, releases: false });
    const fake = fakeGitea(small);
    await setUp(fake);

    const first = await loadHistory({ period: '30d', now: NOW });
    expect(first.hasMore).toBe(false);
    const before = fake.runRequests.length;

    const later = minutesLater(10);
    const newRun = {
      ...small[0]!,
      id: 99_999,
      run_number: 99_999,
      head_branch: null,
      path: 'docker-build.yml@refs/tags/v9.9.9',
      started_at: minutesLater(8).toISOString(),
      completed_at: minutesLater(9).toISOString(),
    };
    fake.setRuns([newRun, ...small]);

    const again = await loadHistory({ period: 'today', now: later });
    expect(fake.runRequests.length).toBeGreaterThan(before);
    expect(again.runs.map((r) => r.id)).toContain(99_999);
  });

  it('a refetched run (same id and attempt) replaces its cached copy: waiting -> started', async () => {
    const runs = buildOrgRuns({ now: NOW, days: 3, perDay: 200, waitingHead: true });
    const fake = fakeGitea(runs);
    await setUp(fake);

    const first = await loadHistory({ period: 'today', now: NOW });
    const waitingId = runs[0]!.id;
    expect(first.runs.find((r) => r.id === waitingId)?.state).toBe('blocked');

    const startedAt = minutesLater(2).toISOString();
    fake.setRuns([
      { ...runs[0]!, status: 'completed', conclusion: 'success', started_at: startedAt, completed_at: minutesLater(6).toISOString() },
      ...runs.slice(1),
    ]);
    const again = await loadHistory({ period: 'today', now: minutesLater(10) });
    const updated = again.runs.find((r) => r.id === waitingId);
    expect(updated?.state).toBe('success');
    expect(updated?.startedAt).toBe(startedAt);
  });
});
