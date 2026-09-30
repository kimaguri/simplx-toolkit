// Minimal read-only Gitea API client.
// Contract: docs/specs/001-gitea-dashboard/contracts/gitea-api.md (header, "Коды ответа")
// and docs/specs/001-gitea-dashboard/contracts/extension-surface.md "Словарь ошибок"
// (ApiError.kind).
//
// Rules enforced here:
// - GET only — the returned client exposes no other verb.
// - Every request is forced under `<baseUrl>/api/v1`; a path that would
//   resolve outside that origin is rejected before fetch() is ever called.
// - At most 4 concurrent requests per client (shared semaphore).
// - 15s timeout via AbortController -> kind 'unreachable'.
// - The Authorization header value (the token) never appears in a thrown
//   ApiError's message.

import type { ApiErrorKind } from '../domain/types';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
}

export type QueryValue = string | number | boolean;
export type QueryParams = Record<string, QueryValue | QueryValue[] | undefined>;

export interface ApiClient {
  get<T>(path: string, query?: QueryParams): Promise<T>;
  getWithMeta<T>(path: string, query?: QueryParams): Promise<{ data: T; totalCount?: number }>;
}

const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Semaphore: at most `limit` concurrent holders per client.
// ---------------------------------------------------------------------------

function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
  }

  function release(): void {
    active -= 1;
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  return { acquire, release };
}

// ---------------------------------------------------------------------------
// URL building — same-origin only, GET-only.
// ---------------------------------------------------------------------------

function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
  // Reject anything that isn't a plain, origin-relative path *before*
  // touching the network: a leading "//" is a protocol-relative reference
  // (changes host), and anything not starting with "/" (e.g. an absolute
  // "https://evil.test/x") is not a same-origin path either.
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('refusing to build a request outside the configured baseUrl origin');
  }

  const base = new URL(baseUrl);
  const trimmedBasePath = base.pathname.replace(/\/$/, '');
  const url = new URL(`${base.origin}${trimmedBasePath}/api/v1${path}`);

  if (url.origin !== base.origin) {
    // Defense in depth; unreachable given the construction above, but keeps
    // the invariant explicit.
    throw new Error('resolved URL origin does not match baseUrl origin');
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined) {
            continue;
          }
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// fetch + timeout + error mapping
// ---------------------------------------------------------------------------

async function doFetch(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch {
    // Covers both network failures (fetch rejects with TypeError) and our
    // own timeout-triggered abort — both surface as "can't reach the host".
    throw new ApiError('unreachable', 'the request could not be completed');
  } finally {
    clearTimeout(timer);
  }
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'server';
}

async function parseResponse<T>(res: Response): Promise<{ data: T; totalCount?: number }> {
  if (!res.ok) {
    throw new ApiError(
      statusToKind(res.status),
      `request failed with status ${res.status}`,
      res.status
    );
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new ApiError('not-json', 'expected a JSON response body', res.status);
  }

  const totalCountHeader = res.headers.get('X-Total-Count');
  const totalCount = totalCountHeader === null ? undefined : Number(totalCountHeader);

  return { data, totalCount };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createClient({ baseUrl, token }: ClientOptions): ApiClient {
  const semaphore = createSemaphore(MAX_CONCURRENT);

  async function run<T>(
    path: string,
    query: QueryParams | undefined
  ): Promise<{ data: T; totalCount?: number }> {
    const url = buildUrl(baseUrl, path, query);
    await semaphore.acquire();
    try {
      const res = await doFetch(url, token);
      return await parseResponse<T>(res);
    } finally {
      semaphore.release();
    }
  }

  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      const { data } = await run<T>(path, query);
      return data;
    },
    async getWithMeta<T>(path: string, query?: QueryParams) {
      return run<T>(path, query);
    },
  };
}
