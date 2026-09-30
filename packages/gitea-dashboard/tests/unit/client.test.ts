// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md (header, "Коды ответа")
// and contracts/extension-surface.md "Словарь ошибок" (ApiError.kind).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from '../../src/api/client';

const BASE_URL = 'https://gitea.example.com';

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

function notJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
  } as unknown as Response;
}

describe('createClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends Authorization: token <t> and Accept: application/json headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await client.get('/user');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token test-token');
    expect(headers.Accept).toBe('application/json');
  });

  it('builds the URL as baseUrl + /api/v1 + path', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await client.get('/repos/search');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gitea.example.com/api/v1/repos/search');
  });

  it('exposes only get/getWithMeta — no other HTTP verb, method override throws', () => {
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    expect(Object.keys(client).sort()).toEqual(['get', 'getWithMeta']);
    const withPost = client as unknown as Record<string, (path: string) => unknown>;
    expect(() => withPost.post!('/x')).toThrow();
    expect(() => withPost.put!('/x')).toThrow();
    expect(() => withPost.delete!('/x')).toThrow();
  });

  it('refuses a request whose resolved URL origin differs from baseUrl (protocol-relative path)', async () => {
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('//evil.test/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request whose resolved URL origin differs from baseUrl (absolute URL path)', async () => {
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('https://evil.test/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits concurrency to 4; a 5th call waits until one resolves', async () => {
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });
    const deferred: Array<(res: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deferred.push(resolve);
        })
    );

    const calls = [1, 2, 3, 4, 5].map((n) => client.get(`/x${n}`));

    // Flush microtasks so the semaphore has a chance to dispatch the first 4.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    deferred[0]!(jsonResponse({}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(5);

    deferred.slice(1).forEach((resolve) => resolve(jsonResponse({})));
    await Promise.all(calls);
  });

  it('times out after 15s via AbortController and reports kind "unreachable"', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        })
    );
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    const pending = client.get('/slow');
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('maps a fetch rejection to kind "unreachable"', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('maps 401 to kind "auth"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps 403 to kind "forbidden"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('maps 404 to kind "not-found"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'not-found', status: 404 });
  });

  it('maps 5xx to kind "server"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'server', status: 503 });
  });

  it('maps a 200 response with a non-JSON body to kind "not-json"', async () => {
    fetchMock.mockResolvedValue(notJsonResponse(200));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toMatchObject({ kind: 'not-json' });
  });

  it('rejects with an instance of ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await expect(client.get('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('never leaks the token in the ApiError message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = createClient({ baseUrl: BASE_URL, token: 'super-secret-token' });

    expect.assertions(2);
    try {
      await client.get('/x');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).not.toContain('super-secret-token');
    }
  });

  it('serializes array query params as repeated keys and drops undefined values', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    await client.get('/orgs/simplx/actions/runs', {
      status: ['queued', 'waiting'],
      limit: 50,
      actor: undefined,
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://gitea.example.com/api/v1/orgs/simplx/actions/runs?status=queued&status=waiting&limit=50'
    );
  });

  it('getWithMeta returns {data, totalCount} read from X-Total-Count', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ id: 1 }], { headers: { 'X-Total-Count': '123' } })
    );
    const client = createClient({ baseUrl: BASE_URL, token: 'test-token' });

    const result = await client.getWithMeta<Array<{ id: number }>>('/repos/search');

    expect(result).toEqual({ data: [{ id: 1 }], totalCount: 123 });
  });
});
