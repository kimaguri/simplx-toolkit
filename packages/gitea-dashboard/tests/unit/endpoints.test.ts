// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md (A1-A15).
// Mocks global fetch (vi.stubGlobal) and asserts, for every endpoint
// function, the exact request path + query string sent, and the parsed
// return value/shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/api/client';
import { createEndpoints } from '../../src/api/endpoints';

import versionFixture from '../fixtures/version.json';
import userFixture from '../fixtures/user.json';
import orgsFixture from '../fixtures/orgs.json';
import reposSearchFixture from '../fixtures/repos-search.json';
import issuesReviewFixture from '../fixtures/issues-search-review.json';
import issuesCreatedFixture from '../fixtures/issues-search-created.json';
import issuesOrgFixture from '../fixtures/issues-search-org.json';
import pullsOpenFixture from '../fixtures/pulls-open.json';
import statusEmptyFixture from '../fixtures/status-empty.json';
import runsActiveFixture from '../fixtures/runs-active.json';
import runsRecentFixture from '../fixtures/runs-recent.json';
import runsMineFixture from '../fixtures/runs-mine.json';
import workflowsFixture from '../fixtures/workflows.json';
import notificationsFixture from '../fixtures/notifications.json';
import runJobsFixture from '../fixtures/run-jobs.json';

const BASE_URL = 'https://git.example.test';

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const status = init.status ?? 200;
  const headerEntries = new Map(Object.entries(init.headers ?? {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headerEntries.get(name) ?? null },
    json: async () => body,
  } as unknown as Response;
}

describe('createEndpoints', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function lastRequest(): { path: string; search: URLSearchParams } {
    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string];
    const parsed = new URL(url);
    return { path: parsed.pathname, search: parsed.searchParams };
  }

  function lastUrl(): string {
    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string];
    return url;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeEndpoints() {
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });
    return createEndpoints(client);
  }

  it('A1 version(): GET /version, returns {version}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(versionFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.version();

    expect(lastUrl()).toBe('https://git.example.test/api/v1/version');
    expect(result).toEqual(versionFixture);
  });

  it('A2 currentUser(): GET /user, returns {id, login}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(userFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.currentUser();

    expect(lastUrl()).toBe('https://git.example.test/api/v1/user');
    expect(result).toEqual(userFixture);
  });

  it('A3 userOrgs(): GET /user/orgs?limit=50, returns org list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(orgsFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.userOrgs();

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/user/orgs');
    expect(search.get('limit')).toBe('50');
    expect(result).toEqual(orgsFixture);
  });

  it('A4 searchRepos(q, limit): GET /repos/search?q=...&sort=updated&order=desc&limit=..., unwraps {ok,data}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reposSearchFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.searchRepos('platform', 20);

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/repos/search');
    expect(search.get('q')).toBe('platform');
    expect(search.get('sort')).toBe('updated');
    expect(search.get('order')).toBe('desc');
    expect(search.get('limit')).toBe('20');
    expect(result).toEqual(reposSearchFixture.data);
  });

  it('A4 searchRepos(""): omits the q param entirely when the query is empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse(reposSearchFixture));
    const endpoints = makeEndpoints();

    await endpoints.searchRepos('', 20);

    const { search } = lastRequest();
    expect(search.has('q')).toBe(false);
  });

  it('A4 ownRepos(userId): GET /repos/search?uid=<id>&exclusive=true&limit=20, unwraps {ok,data}, drops has_actions:false', async () => {
    const kept1 = reposSearchFixture.data[0];
    const dropped = { ...reposSearchFixture.data[1], has_actions: false };
    const kept2: Record<string, unknown> = { ...reposSearchFixture.data[2] };
    delete kept2.has_actions; // has_actions absent -> treated as enabled

    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: [kept1, dropped, kept2] }));
    const endpoints = makeEndpoints();

    const result = await endpoints.ownRepos(1);

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/repos/search');
    expect(search.get('uid')).toBe('1');
    expect(search.get('exclusive')).toBe('true');
    expect(search.get('limit')).toBe('20');
    expect(result).toEqual([kept1, kept2]);
  });

  it('A5 searchPrs("review"): type=pulls&state=open&review_requested=true&limit=50, no q, returns {items,totalCount}', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(issuesReviewFixture, { headers: { 'X-Total-Count': '2' } })
    );
    const endpoints = makeEndpoints();

    const result = await endpoints.searchPrs('review');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/repos/issues/search');
    expect(search.get('type')).toBe('pulls');
    expect(search.get('state')).toBe('open');
    expect(search.get('review_requested')).toBe('true');
    expect(search.get('limit')).toBe('50');
    expect(search.has('q')).toBe(false);
    expect(search.has('created')).toBe(false);
    expect(search.has('owner')).toBe(false);
    expect(result).toEqual({ items: issuesReviewFixture, totalCount: 2 });
  });

  it('A6 searchPrs("created"): created=true, no q, no review_requested', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(issuesCreatedFixture, { headers: { 'X-Total-Count': '1' } })
    );
    const endpoints = makeEndpoints();

    const result = await endpoints.searchPrs('created');

    const { search } = lastRequest();
    expect(search.get('created')).toBe('true');
    expect(search.has('review_requested')).toBe(false);
    expect(search.has('q')).toBe(false);
    expect(result).toEqual({ items: issuesCreatedFixture, totalCount: 1 });
  });

  it('A7 searchPrs({owner}): owner=<org>, no q, no review_requested/created', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(issuesOrgFixture, { headers: { 'X-Total-Count': '1' } })
    );
    const endpoints = makeEndpoints();

    const result = await endpoints.searchPrs({ owner: 'acme' });

    const { search } = lastRequest();
    expect(search.get('owner')).toBe('acme');
    expect(search.has('review_requested')).toBe(false);
    expect(search.has('created')).toBe(false);
    expect(search.has('q')).toBe(false);
    expect(result).toEqual({ items: issuesOrgFixture, totalCount: 1 });
  });

  it('A8 openPulls(owner, repo): GET /repos/{o}/{r}/pulls?state=open&sort=recentupdate&limit=50, encodes segments', async () => {
    fetchMock.mockResolvedValue(jsonResponse(pullsOpenFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.openPulls('acme', 'a repo');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/repos/acme/a%20repo/pulls');
    expect(search.get('state')).toBe('open');
    expect(search.get('sort')).toBe('recentupdate');
    expect(search.get('limit')).toBe('50');
    expect(result).toEqual(pullsOpenFixture);
  });

  it('A9 combinedStatus(owner, repo, sha): GET /repos/{o}/{r}/commits/{sha}/status, encodes segments', async () => {
    fetchMock.mockResolvedValue(jsonResponse(statusEmptyFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.combinedStatus('acme', 'platform', 'abc/def');

    const { path } = lastRequest();
    expect(path).toBe('/api/v1/repos/acme/platform/commits/abc%2Fdef/status');
    expect(result).toEqual(statusEmptyFixture);
  });

  it('A10 orgActiveRuns(org): GET /orgs/{org}/actions/runs with three repeated status= params + limit=50', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runsActiveFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.orgActiveRuns('acme');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/orgs/acme/actions/runs');
    expect(search.getAll('status')).toEqual(['queued', 'waiting', 'in_progress']);
    expect(search.get('limit')).toBe('50');
    expect(result).toEqual(runsActiveFixture);
  });

  it('A11 orgRecentRuns(org): GET /orgs/{org}/actions/runs?limit=50, no status filter', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runsRecentFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.orgRecentRuns('acme');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/orgs/acme/actions/runs');
    expect(search.get('limit')).toBe('50');
    expect(search.has('status')).toBe(false);
    expect(result).toEqual(runsRecentFixture);
  });

  it('A12 repoRuns(owner, repo, limit): GET /repos/{o}/{r}/actions/runs?limit=<n>, defaults to 10', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runsRecentFixture));
    const endpoints = makeEndpoints();

    const resultDefault = await endpoints.repoRuns('acme', 'platform');
    expect(lastRequest().search.get('limit')).toBe('10');
    expect(lastRequest().path).toBe('/api/v1/repos/acme/platform/actions/runs');
    expect(resultDefault).toEqual(runsRecentFixture);

    await endpoints.repoRuns('acme', 'platform', 20);
    expect(lastRequest().search.get('limit')).toBe('20');
  });

  it('A15 orgMyRuns(org, login): GET /orgs/{org}/actions/runs?actor=<login>&limit=30', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runsMineFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.orgMyRuns('acme', 'me');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/orgs/acme/actions/runs');
    expect(search.get('actor')).toBe('me');
    expect(search.get('limit')).toBe('30');
    expect(result).toEqual(runsMineFixture);
  });

  it('A13 repoWorkflows(owner, repo): GET /repos/{o}/{r}/actions/workflows, returns workflow list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(workflowsFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.repoWorkflows('acme', 'platform');

    const { path } = lastRequest();
    expect(path).toBe('/api/v1/repos/acme/platform/actions/workflows');
    expect(result).toEqual(workflowsFixture.workflows);
  });

  it('A14 notifications(since): GET /notifications?since=<iso>&limit=50', async () => {
    fetchMock.mockResolvedValue(jsonResponse(notificationsFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.notifications('2026-09-25T00:00:00Z');

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/notifications');
    expect(search.get('since')).toBe('2026-09-25T00:00:00Z');
    expect(search.get('limit')).toBe('50');
    expect(result).toEqual(notificationsFixture);
  });

  it('002 R9 runJobs(owner, repo, runId): GET /repos/{o}/{r}/actions/runs/{run}/jobs?limit=50, returns job list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(runJobsFixture));
    const endpoints = makeEndpoints();

    const result = await endpoints.runJobs('acme', 'platform', 42);

    const { path, search } = lastRequest();
    expect(path).toBe('/api/v1/repos/acme/platform/actions/runs/42/jobs');
    expect(search.get('limit')).toBe('50');
    expect(result).toEqual(runJobsFixture.jobs);
  });
});
