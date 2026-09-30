// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md ("Коды ответа →
// диагностика"), contracts/extension-surface.md (ConnectionReport, "Словарь
// ошибок"), research.md R1-R3.
//
// Mocks global fetch per URL pathname and asserts the diagnosis
// `checkConnection` produces for each probe outcome. No real HTTP.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConnection } from '../../src/background/connection';
import { getInstances, instanceId, setInstances } from '../../src/lib/storage';
import type { Instance } from '../../src/domain/types';

const BASE_URL = 'https://git.example.test';
const TOKEN = 'test-token';

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function notJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return jsonResponse({}, status);
}

function makeFetchMock(handlers: Record<string, Handler>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const handler = handlers[url.pathname];
    if (!handler) {
      throw new Error(`unexpected request to ${url.pathname}`);
    }
    return handler();
  });
}

const USER = { id: 1, login: 'me' };
const VERSION = { version: '1.27.3' };
const ORGS_ONE = [{ username: 'acme' }];
const EMPTY_RUNS = { total_count: 0, workflow_runs: [] };
const REPOS_SEARCH_ONE = {
  ok: true,
  data: [{ full_name: 'acme/platform', owner: { login: 'acme' }, name: 'platform' }],
};

describe('checkConnection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(handlers: Record<string, Handler>): void {
    fetchMock.mockImplementation(makeFetchMock(handlers).getMockImplementation()!);
  }

  it('success: login, version 1.27.3, actions:"org", never leaks the token', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
      '/api/v1/orgs/acme/actions/runs': () => jsonResponse(EMPTY_RUNS),
      '/api/v1/notifications': () => jsonResponse([]),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report).toEqual({
      ok: true,
      login: 'me',
      version: '1.27.3',
      actions: 'org',
      missingScopes: [],
      messageKey: 'diag_ok',
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('invalid URL -> bad-url, no request is ever sent', async () => {
    const report = await checkConnection('not a url', TOKEN);

    expect(report.ok).toBe(false);
    expect(report.kind).toBe('bad-url');
    expect(report.messageKey).toBe('diag_bad_url');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('401 on /user -> auth', async () => {
    stub({ '/api/v1/user': () => statusResponse(401) });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(false);
    expect(report.kind).toBe('auth');
    expect(report.messageKey).toBe('diag_auth');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('fetch throws -> unreachable', async () => {
    stub({
      '/api/v1/user': () => {
        throw new TypeError('network down');
      },
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(false);
    expect(report.kind).toBe('unreachable');
    expect(report.messageKey).toBe('diag_unreachable');
  });

  it('200 non-JSON body on /user -> not-gitea', async () => {
    stub({ '/api/v1/user': () => notJsonResponse() });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(false);
    expect(report.kind).toBe('not-gitea');
    expect(report.messageKey).toBe('diag_not_gitea');
  });

  it('403 on /user/orgs -> scope, missingScopes includes read:organization', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => statusResponse(403),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(false);
    expect(report.kind).toBe('scope');
    expect(report.messageKey).toBe('diag_scope');
    expect(report.missingScopes).toEqual(['read:organization']);
  });

  it('404 on org-runs and repo-runs -> actions:"unsupported"', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
      '/api/v1/orgs/acme/actions/runs': () => statusResponse(404),
      '/api/v1/repos/search': () => jsonResponse(REPOS_SEARCH_ONE),
      '/api/v1/repos/acme/platform/actions/runs': () => statusResponse(404),
      '/api/v1/notifications': () => jsonResponse([]),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(true);
    expect(report.actions).toBe('unsupported');
  });

  it('403 on org-runs, 200 on repo-runs -> actions:"repo"', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
      '/api/v1/orgs/acme/actions/runs': () => statusResponse(403),
      '/api/v1/repos/search': () => jsonResponse(REPOS_SEARCH_ONE),
      '/api/v1/repos/acme/platform/actions/runs': () => jsonResponse(EMPTY_RUNS),
      '/api/v1/notifications': () => jsonResponse([]),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(true);
    expect(report.actions).toBe('repo');
  });

  it('403 on both org-runs and repo-runs -> actions:"forbidden"', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
      '/api/v1/orgs/acme/actions/runs': () => statusResponse(403),
      '/api/v1/repos/search': () => jsonResponse(REPOS_SEARCH_ONE),
      '/api/v1/repos/acme/platform/actions/runs': () => statusResponse(403),
      '/api/v1/notifications': () => jsonResponse([]),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(true);
    expect(report.actions).toBe('forbidden');
  });

  it('no orgs -> falls back to repo probe; ok repo-runs -> actions:"repo"', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse([]),
      '/api/v1/repos/search': () => jsonResponse(REPOS_SEARCH_ONE),
      '/api/v1/repos/acme/platform/actions/runs': () => jsonResponse(EMPTY_RUNS),
      '/api/v1/notifications': () => jsonResponse([]),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(true);
    expect(report.actions).toBe('repo');
  });

  it('403 on notifications -> not fatal, missingScopes includes read:notification', async () => {
    stub({
      '/api/v1/user': () => jsonResponse(USER),
      '/api/v1/version': () => jsonResponse(VERSION),
      '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
      '/api/v1/orgs/acme/actions/runs': () => jsonResponse(EMPTY_RUNS),
      '/api/v1/notifications': () => statusResponse(403),
    });

    const report = await checkConnection(BASE_URL, TOKEN);

    expect(report.ok).toBe(true);
    expect(report.messageKey).toBe('diag_ok');
    expect(report.missingScopes).toEqual(['read:notification']);
  });

  // M5 review fix: manual "Проверить подключение" of a URL that isn't (yet)
  // the active/saved instance must never hijack `activeInstanceId` — that
  // would silently stop the poller (it has no token for the new instance).
  describe('persist option (M5 fix)', () => {
    const OTHER_URL = 'https://other.example.test';
    let activeId: string;
    let ACTIVE_INSTANCE: Instance;

    beforeEach(async () => {
      activeId = await instanceId(OTHER_URL);
      ACTIVE_INSTANCE = {
        id: activeId,
        baseUrl: OTHER_URL,
        login: 'someone-else',
        capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
        checkedAt: '2020-01-01T00:00:00.000Z',
      };
    });

    function stubOk(): void {
      stub({
        '/api/v1/user': () => jsonResponse(USER),
        '/api/v1/version': () => jsonResponse(VERSION),
        '/api/v1/user/orgs': () => jsonResponse(ORGS_ONE),
        '/api/v1/orgs/acme/actions/runs': () => jsonResponse(EMPTY_RUNS),
        '/api/v1/notifications': () => jsonResponse([]),
      });
    }

    it('persist:false, checking a different/unsaved URL -> instances and activeInstanceId unchanged', async () => {
      await setInstances({ instances: [ACTIVE_INSTANCE], activeInstanceId: ACTIVE_INSTANCE.id });
      stubOk();

      const report = await checkConnection(BASE_URL, TOKEN, { persist: false });

      expect(report.ok).toBe(true);
      const { instances, activeInstanceId } = await getInstances();
      expect(activeInstanceId).toBe(ACTIVE_INSTANCE.id);
      expect(instances).toEqual([ACTIVE_INSTANCE]);
    });

    it('persist:false, checking the current active instance URL -> its capabilities refresh, active unchanged', async () => {
      await setInstances({ instances: [ACTIVE_INSTANCE], activeInstanceId: ACTIVE_INSTANCE.id });
      stubOk();

      const report = await checkConnection(OTHER_URL, TOKEN, { persist: false });

      expect(report.ok).toBe(true);
      const { instances, activeInstanceId } = await getInstances();
      expect(activeInstanceId).toBe(ACTIVE_INSTANCE.id);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.id).toBe(ACTIVE_INSTANCE.id);
      expect(instances[0]?.login).toBe('me');
      expect(instances[0]?.capabilities.actions).toBe('org');
    });

    it('persist:true (default) -> checked instance becomes active, as before', async () => {
      await setInstances({ instances: [ACTIVE_INSTANCE], activeInstanceId: ACTIVE_INSTANCE.id });
      stubOk();

      const report = await checkConnection(BASE_URL, TOKEN, { persist: true });

      expect(report.ok).toBe(true);
      const { instances, activeInstanceId } = await getInstances();
      expect(activeInstanceId).not.toBe(ACTIVE_INSTANCE.id);
      expect(instances.some((i) => i.baseUrl === BASE_URL)).toBe(true);
    });
  });
});
