import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformClient, PlatformApiError } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";

/**
 * LAB-257 T050 — contract tests for the platform API client, the boundary
 * every MCP tool (T045-T048's tests) is built against.
 *
 * Written BEFORE the fix (constitution §4, test-first) — the client as it
 * existed before this task discarded the response body on error and never
 * unwrapped the `data` envelope, which does not match what T045-T048's own
 * fakes assume. This file pins the corrected behavior.
 *
 * R15/R20: this client carries NO rules logic and NO version arithmetic —
 * every test below only checks that request/response bytes pass through
 * unmodified (URL, headers, body in; parsed `data` or a structured error
 * out). Nothing here computes a version, checks a rule, or reinterprets a
 * platform decision.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "svc-token-123" };

const jsonResponse = (body: unknown, init: { status?: number; statusText?: string } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    ...(init.statusText !== undefined ? { statusText: init.statusText } : {}),
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPlatformClient — carries the connection, callers never pass environment (T050)", () => {
  it("bakes baseUrl/tenantSlug/bearerToken into every request from the profile it was built from — no per-call environment parameter exists", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createPlatformClient(createTestProfile(CONNECTION));
    await client.get("/api/v1/meta/schema");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://platform.example.test/api/v1/meta/schema");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer svc-token-123");
    expect(headers["X-Tenant-Slug"]).toBe("acme");
  });

  it("works identically for a prod profile's connection — this client itself never gates by profile name, only which methods callers reach it through", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createPlatformClient(createProdProfile(CONNECTION));
    await client.get("/api/v1/meta/schema");

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer svc-token-123");
  });
});

describe("createPlatformClient — response envelope unwrapping (T050)", () => {
  it("get() unwraps the `data` field of a full { data, message } read response — matches contracts/meta-write-api.md's read examples", async () => {
    const schema = { manifest: { packageVersion: "1.0.0" }, entitySchema: {}, appSchema: {} };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: schema, message: "Meta validation rules retrieved" })));

    const client = createPlatformClient(createTestProfile(CONNECTION));
    const result = await client.get("/api/v1/meta/schema");

    expect(result).toEqual(schema);
  });

  it("write() unwraps the `data` field of a write response that carries ONLY data, no message — contracts/meta-write-api.md is explicit this is deliberate, not an omission to 'fix'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { version: 8, entityName: "contacts" } })));

    const client = createPlatformClient(createTestProfile(CONNECTION));
    const result = await client.write("/api/v1/meta/entities/t1/app1/contacts", { expectedVersion: 7, config: {} });

    expect(result).toEqual({ version: 8, entityName: "contacts" });
  });

  it("sends the write body as JSON and defaults to POST, honoring an explicit method (e.g. DELETE) when given", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => jsonResponse({ data: { entityName: "contacts", deleted: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createPlatformClient(createTestProfile(CONNECTION));

    await client.write("/api/v1/meta/entities/t1/app1/contacts", { expectedVersion: 7 }, "DELETE");

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ expectedVersion: 7 }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("createPlatformClient — surfaces the platform's own errors intact, reinterprets nothing (T050, FR-002/FR-003/FR-041)", () => {
  it("a version-conflict rejection (failed_precondition) reaches the caller with code, message, and details.params.currentVersion — the exact shape errs.failedPrecondition().withDetails() produces on the platform", async () => {
    const errorBody = {
      code: "failed_precondition",
      message: "База ушла вперёд, перечитайте описание",
      details: {
        error: "version_conflict",
        app_code: "version_conflict",
        error_id: "11111111-1111-1111-1111-111111111111",
        params: { currentVersion: 8, expectedVersion: 6 },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(errorBody, { status: 412, statusText: "Precondition Failed" })));
    const client = createPlatformClient(createTestProfile(CONNECTION));

    let caught: any;
    try {
      await client.write("/api/v1/meta/entities/t1/app1/contacts", { expectedVersion: 6, config: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect(caught.code).toBe("failed_precondition");
    expect(caught.message).toBe("База ушла вперёд, перечитайте описание");
    expect(caught.details.params.currentVersion).toBe(8);
    expect(caught.details.params.expectedVersion).toBe(6);
  });

  it("an acknowledgedDependents mismatch (or any other structured rejection) is passed through with its own details, unrelabeled and unreshaped", async () => {
    const errorBody = {
      code: "failed_precondition",
      message: "Подтверждение относилось к другой картине зависимых",
      details: { params: { acknowledgedDependents: 3, actualDependents: 5 } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(errorBody, { status: 412 })));
    const client = createPlatformClient(createTestProfile(CONNECTION));

    let caught: any;
    try {
      await client.write("/api/v1/meta/templates/contacts", { expectedVersion: 3, acknowledgedDependents: 3, config: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught.details.params).toEqual({ acknowledgedDependents: 3, actualDependents: 5 });
  });

  it("a permission_denied rejection (e.g. the production write refusal for the automatic author) surfaces its own code and message, not a generic HTTP-status message", async () => {
    const errorBody = {
      code: "permission_denied",
      message: "Автоматический автор не может писать в промышленное окружение — изменения попадают туда только продвижением",
      details: { app_code: "meta_agent_write_denied_production" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(errorBody, { status: 403 })));
    const client = createPlatformClient(createTestProfile(CONNECTION));

    let caught: any;
    try {
      await client.write("/api/v1/meta/entities/t1/app1/contacts", { config: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught.code).toBe("permission_denied");
    expect(caught.message).toContain("промышленное окружение");
  });

  it("falls back to the HTTP status text when the error body is not the expected JSON shape, rather than throwing an unrelated parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })),
    );
    const client = createPlatformClient(createTestProfile(CONNECTION));

    let caught: any;
    try {
      await client.get("/api/v1/meta/schema");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect(caught.status).toBe(500);
  });
});
