// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md (A5-A9),
// data-model.md ("PullRequest", "prHeads:<instanceId>", "statusCache:<instanceId>"),
// research.md R7-R9.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL pathname
// (like tests/unit/connection.test.ts). No real HTTP is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createPoller } from '../../src/background/poller';
import { applyBadge } from '../../src/background/poller/badge';
import { prsSection } from '../../src/background/poller/prs';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

import issuesReviewFixture from '../fixtures/issues-search-review.json';
import issuesCreatedFixture from '../fixtures/issues-search-created.json';
import pullsOpenFixture from '../fixtures/pulls-open.json';
import pullsOpenIncludeRepoFixture from '../fixtures/pulls-open-include-repo.json';
import statusEmptyFixture from '../fixtures/status-empty.json';
import statusSuccessFixture from '../fixtures/status-success.json';

const BASE_URL = 'https://git.example.test';

// -- fixed test world (fixtures/README.md): me (id 1), alice (2), bob (3);
// orgs acme (10), umbrella (11); repos acme/platform, acme/core,
// umbrella/web, me/dotfiles. --

const INSTANCE: Instance = {
  id: 'i_prstest1',
  baseUrl: BASE_URL,
  login: 'me',
  capabilities: { actions: 'org', notifications: true, orgs: ['acme', 'umbrella'], missingScopes: [] },
};

// "Other" PR candidates returned by owner=<org>/owner=<login> (A7). Kept
// separate from the fixture files so each scenario can shape exclusion
// coverage precisely.
const ORG_ACME_OTHERS = [
  {
    id: 3001,
    number: 9,
    title: 'Merge release branch',
    user: { login: 'bob' },
    updated_at: '2026-09-26T06:20:00Z',
    html_url: 'https://git.example.test/acme/platform/pulls/9',
    repository: { full_name: 'acme/platform' },
    pull_request: { draft: false },
  },
  {
    id: 3002,
    number: 55,
    title: 'Excluded-repo PR',
    user: { login: 'bob' },
    updated_at: '2026-09-26T05:00:00Z',
    html_url: 'https://git.example.test/acme/core/pulls/55',
    repository: { full_name: 'acme/core' },
    pull_request: { draft: false },
  },
];

const ORG_UMBRELLA_OTHERS = [
  {
    id: 3003,
    number: 5,
    title: 'Excluded-org PR',
    user: { login: 'alice' },
    updated_at: '2026-09-25T22:00:00Z',
    html_url: 'https://git.example.test/umbrella/web/pulls/5',
    repository: { full_name: 'umbrella/web' },
    pull_request: { draft: false },
  },
];

// A pending (non-final) combined status for PR #7 (acme/core) — total_count>0
// distinguishes it from status-empty.json's "no checks" (total_count:0).
const STATUS_PENDING = {
  state: 'pending',
  sha: 'd3adbeefcafe00000000000000000000000002',
  total_count: 1,
  statuses: [{ id: 1, status: 'pending', context: 'ci/ci.yml' }],
};

type Handler = () => unknown;

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const headerEntries = new Map(Object.entries(headers));
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headerEntries.get(name) ?? null },
    json: async () => body,
  } as unknown as Response;
}

function emptyPulls(): unknown[] {
  return [];
}

/** Routes by pathname + query (for the owner= disambiguation on A7). */
function makeFetchMock(
  routes: Array<{ match: (url: URL) => boolean; handler: Handler; headers?: Record<string, string> }>
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = routes.find((r) => r.match(url));
    if (!route) {
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    return jsonResponse(route.handler(), route.headers);
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function baseRoutes(): Array<{
  match: (url: URL) => boolean;
  handler: Handler;
  headers?: Record<string, string>;
}> {
  return [
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('review_requested') === 'true',
      handler: () => issuesReviewFixture,
      headers: { 'X-Total-Count': '2' },
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('created') === 'true',
      handler: () => issuesCreatedFixture,
      headers: { 'X-Total-Count': '1' },
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'acme',
      handler: () => ORG_ACME_OTHERS,
      headers: { 'X-Total-Count': '2' },
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'umbrella',
      handler: () => ORG_UMBRELLA_OTHERS,
      headers: { 'X-Total-Count': '1' },
    },
    {
      match: (u) => path(u) === '/repos/issues/search' && u.searchParams.get('owner') === 'me',
      handler: () => [],
      headers: { 'X-Total-Count': '0' },
    },
    {
      match: (u) => path(u) === '/repos/acme/platform/pulls',
      handler: () => pullsOpenFixture.filter((p) => p.number === 12 || p.number === 9),
    },
    {
      match: (u) => path(u) === '/repos/acme/core/pulls',
      handler: () => pullsOpenFixture.filter((p) => p.number === 7),
    },
    {
      match: (u) => path(u) === '/repos/me/dotfiles/pulls',
      handler: () => pullsOpenFixture.filter((p) => p.number === 21),
    },
    {
      match: (u) => path(u) === '/repos/umbrella/web/pulls',
      handler: emptyPulls,
    },
    {
      match: (u) => path(u) === '/repos/acme/platform/commits/d3adbeefcafe00000000000000000000000001/status',
      handler: () => statusSuccessFixture,
    },
    {
      match: (u) => path(u) === '/repos/acme/core/commits/d3adbeefcafe00000000000000000000000002/status',
      handler: () => STATUS_PENDING,
    },
    {
      match: (u) => path(u) === '/repos/me/dotfiles/commits/d3adbeefcafe00000000000000000000000003/status',
      handler: () => statusEmptyFixture,
    },
  ];
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    scope: { ...DEFAULT_SETTINGS.scope, ...overrides.scope },
  };
}

async function setUp(settings: Settings): Promise<void> {
  await storage.setInstances({ instances: [INSTANCE], activeInstanceId: INSTANCE.id });
  await storage.setToken(INSTANCE.id, 'test-token');
  await storage.setSettings(settings);
}

describe('poller-prs integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let setBadgeTextSpy: ReturnType<typeof vi.spyOn>;
  let setBadgeColorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setBadgeTextSpy = vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    setBadgeColorSpy = vi
      .spyOn(browser.action, 'setBadgeBackgroundColor')
      .mockResolvedValue(undefined);
  });

  it('groups PRs, merges CI + conflict, respects scope, sets prTotals + badge, and re-fetches nothing on an unchanged cycle', async () => {
    const settings = settingsWith({
      showOtherPrs: true,
      scope: { excludeRepos: ['acme/core'], excludeOrgs: ['umbrella'], includeRepos: [] },
    });
    await setUp(settings);

    fetchMock.mockImplementation(makeFetchMock(baseRoutes()).getMockImplementation()!);

    const poller = createPoller({ sections: [prsSection], clientFactory: createClient });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(INSTANCE.id);
    expect(snapshot).toBeDefined();

    const byNumber = (n: number, repo: string) =>
      snapshot!.prs.find((pr) => pr.number === n && pr.repo.name === repo);

    // Grouping: review wins, mine (created), other (owner= candidates).
    const reviewPr = byNumber(12, 'platform');
    expect(reviewPr?.group).toBe('review');
    const draftReviewPr = byNumber(7, 'core');
    expect(draftReviewPr?.group).toBe('review');
    expect(draftReviewPr?.draft).toBe(true);
    const minePr = byNumber(21, 'dotfiles');
    expect(minePr?.group).toBe('mine');
    const otherPr = byNumber(9, 'platform');
    expect(otherPr?.group).toBe('other');

    // scope.excludeRepos / excludeOrgs are respected in the final list.
    expect(byNumber(55, 'core')).toBeUndefined(); // acme/core excluded
    expect(byNumber(5, 'web')).toBeUndefined(); // umbrella org excluded

    // CI merged: success, conflict (mergeable:false), status-empty -> none.
    expect(reviewPr?.ci.state).toBe('success');
    expect(draftReviewPr?.mergeable).toBe(false);
    expect(draftReviewPr?.ci.state).toBe('pending');
    expect(minePr?.ci.state).toBe('none');

    // counts.reviews + prTotals from X-Total-Count.
    expect(snapshot!.counts.reviews).toBe(2);
    expect(snapshot!.prTotals).toEqual({ review: 2, mine: 1, other: 3 });

    // A7 requested for each org in capabilities.orgs AND owner=<login>.
    const searchUrls = (fetchMock.mock.calls as [string][])
      .map(([u]) => new URL(u))
      .filter((u: URL) => path(u) === '/repos/issues/search');
    const owners = searchUrls.map((u: URL) => u.searchParams.get('owner'));
    expect(owners).toEqual(expect.arrayContaining(['acme', 'umbrella', 'me']));

    // Badge: reviews mode (default), text = counts.reviews, neutral (no redUntil).
    await applyBadge(settings, snapshot!, new Date('2026-09-26T10:00:00Z'));
    expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: '2' });
    expect(setBadgeColorSpy).toHaveBeenCalledWith({ color: '#6a737d' });

    // Second cycle, unchanged data: no A8 (/pulls) or A9 (/status) requests,
    // except the still-pending sha (acme/core #7), which stays outstanding.
    fetchMock.mockClear();
    await poller.runCycle('base');

    const secondCycleUrls = (fetchMock.mock.calls as [string][]).map(([u]) => new URL(String(u)));
    const pullsCalls = secondCycleUrls.filter((u: URL) => path(u).endsWith('/pulls'));
    const finalStatusCalls = secondCycleUrls.filter(
      (u: URL) => path(u) === '/repos/acme/platform/commits/d3adbeefcafe00000000000000000000000001/status'
    );
    const noneStatusCalls = secondCycleUrls.filter(
      (u: URL) => path(u) === '/repos/me/dotfiles/commits/d3adbeefcafe00000000000000000000000003/status'
    );
    const pendingStatusCalls = secondCycleUrls.filter(
      (u: URL) => path(u) === '/repos/acme/core/commits/d3adbeefcafe00000000000000000000000002/status'
    );

    expect(pullsCalls).toHaveLength(0); // R9: unchanged updated_at -> no A8
    expect(finalStatusCalls).toHaveLength(0); // final status -> not re-requested
    expect(noneStatusCalls).toHaveLength(0); // 'none' is final -> not re-requested
    expect(pendingStatusCalls).toHaveLength(1); // still pending -> re-requested (FR-022)
  });

  it('T065: includeRepos (outside orgs) feed A8 open PRs into the "other" group (excluding me), and A8 doubles as the prHeads fetch', async () => {
    const settings = settingsWith({
      showOtherPrs: true,
      scope: { excludeRepos: [], excludeOrgs: [], includeRepos: ['bob/side'] },
    });
    await setUp(settings);

    const routes = [
      ...baseRoutes(),
      {
        match: (u: URL) => path(u) === '/repos/bob/side/pulls',
        handler: () => pullsOpenIncludeRepoFixture,
      },
      {
        match: (u: URL) =>
          path(u) === '/repos/bob/side/commits/d3adbeefcafe00000000000000000000000004/status',
        handler: () => statusEmptyFixture,
      },
    ];
    fetchMock.mockImplementation(makeFetchMock(routes).getMockImplementation()!);

    const poller = createPoller({ sections: [prsSection], clientFactory: createClient });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(INSTANCE.id);
    expect(snapshot).toBeDefined();

    const bySide = (n: number) =>
      snapshot!.prs.find((pr) => pr.repo.owner === 'bob' && pr.repo.name === 'side' && pr.number === n);

    // Bob's PR shows up as "other"; mine (from the same includeRepo) is excluded.
    expect(bySide(3)?.group).toBe('other');
    expect(bySide(3)?.headSha).toBe('d3adbeefcafe00000000000000000000000004'); // A8 fed prHeads too
    expect(bySide(4)).toBeUndefined();

    // A8 for the includeRepo is requested exactly once per cycle.
    const sideCalls = (fetchMock.mock.calls as [string][])
      .map(([u]) => new URL(String(u)))
      .filter((u: URL) => path(u) === '/repos/bob/side/pulls');
    expect(sideCalls).toHaveLength(1);
  });

  it('T065: includeRepos are ignored (no A8 call, no "other" PRs) when showOtherPrs is false', async () => {
    const settings = settingsWith({
      showOtherPrs: false,
      scope: { excludeRepos: [], excludeOrgs: [], includeRepos: ['bob/side'] },
    });
    await setUp(settings);

    // No /repos/bob/side/pulls route: any request to it throws (unexpected request).
    fetchMock.mockImplementation(makeFetchMock(baseRoutes()).getMockImplementation()!);

    const poller = createPoller({ sections: [prsSection], clientFactory: createClient });
    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(INSTANCE.id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.prs.some((pr) => pr.repo.owner === 'bob' && pr.repo.name === 'side')).toBe(false);

    const sideCalls = (fetchMock.mock.calls as [string][])
      .map(([u]) => new URL(String(u)))
      .filter((u: URL) => path(u) === '/repos/bob/side/pulls');
    expect(sideCalls).toHaveLength(0);
  });
});
