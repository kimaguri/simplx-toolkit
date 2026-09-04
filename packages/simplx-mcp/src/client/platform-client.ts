import type { PlatformConnection } from "../profiles/types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface PlatformRequestOptions {
  readonly method?: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
}

export interface PlatformClient {
  readonly request: <T>(options: PlatformRequestOptions) => Promise<T>;
  readonly get: <T>(path: string) => Promise<T>;
  readonly write: <T>(path: string, body: unknown, method?: Exclude<HttpMethod, "GET">) => Promise<T>;
}

/** The shape of an Encore `APIError` as it crosses the wire (see
 * `platform/src/lib/errs/index.ts` — `APIError.withDetails(...)`): a
 * `code`/`message` pair plus whatever `details` the platform attached
 * (version-conflict `params`, acknowledgedDependents mismatch `params`,
 * rule-violation locations, etc). Not every field is guaranteed present —
 * a non-Encore 5xx (e.g. a proxy error page) has neither. */
interface PlatformErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
}

/**
 * Thrown for any non-2xx platform response. Carries the platform's OWN
 * `code`/`message`/`details` exactly as received — this client never
 * reinterprets, renames, or re-derives a rejection (R15/R16/R20): a version
 * conflict's `currentVersion`, a rule violation's location, a production
 * write refusal's reason all reach the caller through `details`/`code`
 * unchanged. `status`/`statusText` are the raw HTTP fallback for the rare
 * response that isn't the platform's own JSON error envelope.
 */
export class PlatformApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, statusText: string, body?: PlatformErrorBody) {
    const code = typeof body?.code === "string" ? body.code : undefined;
    const message = typeof body?.message === "string" ? body.message : `platform request failed: ${status} ${statusText}`;
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
    if (body?.details !== undefined) this.details = body.details;
  }
}

/** Parses a response body as JSON, returning `undefined` instead of
 * throwing when the body is empty or not valid JSON (e.g. a proxy's plain
 * -text error page) — the caller decides what to fall back to. */
const tryParseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Every meta endpoint response — read or write, success or the general
 * `ApiResponse<T>` envelope — carries the actual payload under `data`
 * (contracts/meta-write-api.md: write responses deliberately carry ONLY
 * `data`, without `message`, so this holds for both). Unwrapping it here is
 * transport-level normalization, not application logic: every tool would
 * otherwise repeat the identical `res.data` line. */
const unwrapData = <T>(body: unknown): T => {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
};

/**
 * Thin wrapper around the SimplX platform REST API. Holds no state beyond
 * the connection it was built from and contains no application logic — every
 * tool call ends up here as one HTTP request carrying the platform's bearer
 * token via the existing service-to-service token mechanics (gateway/auth.ts
 * `AuthParams`: `Authorization: Bearer <token>` + `X-Tenant-Slug` fallback
 * tenant resolution — see T050's report for what was found and reused).
 * Whether a caller is *allowed* to reach {@link PlatformClient.write} is
 * decided by the profile/tool-registry layer, not here — this client itself
 * never inspects `connection` for a profile name and exposes both methods
 * unconditionally (see `profiles.type-test.ts`'s "still lets a prod profile
 * run through the read-only client" case).
 */
export const createPlatformClient = (connection: PlatformConnection): PlatformClient => {
  const request = async <T>(options: PlatformRequestOptions): Promise<T> => {
    const url = new URL(options.path, connection.baseUrl);
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.bearerToken}`,
        "X-Tenant-Slug": connection.tenantSlug,
        "Content-Type": "application/json",
      },
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    const body = await tryParseJson(response);

    if (!response.ok) {
      throw new PlatformApiError(response.status, response.statusText, body as PlatformErrorBody | undefined);
    }

    return unwrapData<T>(body);
  };

  const get = <T>(path: string): Promise<T> => request<T>({ path, method: "GET" });

  const write = <T>(path: string, body: unknown, method: Exclude<HttpMethod, "GET"> = "POST"): Promise<T> =>
    request<T>({ path, method, body });

  return { request, get, write };
};
