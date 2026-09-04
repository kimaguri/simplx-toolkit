import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { PlatformApiError } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
import { inventoryTool } from "../src/tools/meta/inventory.js";

/**
 * LAB-257 T210 — contract tests for the MCP inventory tool
 * (`meta.inventory`), written before verifying the implementation
 * (constitution §4), following the same fake-`PlatformClient` convention
 * `test/history.test.ts` and `test/read.test.ts` already establish for
 * this package.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const PATH = "/api/v1/meta/inventory";

const makeFakeReadClient = (responses: Record<string, unknown>): PlatformClient => {
  const get = vi.fn(async <T,>(path: string): Promise<T> => {
    if (!(path in responses)) {
      throw new Error(`fake platform client: unexpected GET ${path}`);
    }
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response as T;
  });
  const write = vi.fn(async () => {
    throw new Error("fake platform client: meta.inventory must never call write()");
  });
  const request = vi.fn(async (options: { method?: string; path: string }) => {
    if (options.method && options.method !== "GET") {
      throw new Error(`fake platform client: unexpected ${options.method} ${options.path}`);
    }
    return get(options.path);
  });
  return { get, write, request } as unknown as PlatformClient;
};

const makeContext = (client: PlatformClient, useProdProfile = false): ToolContext => ({
  profile: useProdProfile ? createProdProfile(CONNECTION) : createTestProfile(CONNECTION),
  client,
});

const VIOLATION = {
  tenantId: "tenant-acme",
  scope: "entity" as const,
  appName: "intellhouse",
  entityName: "contacts",
  path: "/fields/phone/valueType",
  message: "unknown valueType 'legacy_string'",
  knownNonTenant: false,
};

const KNOWN_NON_TENANT_VIOLATION = {
  tenantId: "tenant-host",
  scope: "app" as const,
  appName: "admin",
  path: "/menu/0/label",
  message: "missing required field",
  knownNonTenant: true,
  knownNonTenantReason: "admin/host rows are never read by any running consumer",
};

const RAW_RESPONSE = {
  violations: [VIOLATION, KNOWN_NON_TENANT_VIOLATION],
  tenantViolationCount: 1,
  knownNonTenantCount: 1,
  valueTypes: [{ valueType: "string", count: 40 }],
};

describe("meta.inventory — LAB-257 T210", () => {
  it('is registered under the contract name "meta.inventory"', () => {
    expect(inventoryTool.name).toBe("meta.inventory");
  });

  it("is a read tool — registered as kind \"read\", not \"write\"", () => {
    expect(inventoryTool.kind).toBe("read");
  });

  it("calls GET /api/v1/meta/inventory — exactly one call, no arguments needed", async () => {
    const client = makeFakeReadClient({ [PATH]: RAW_RESPONSE });

    await inventoryTool.handler(makeContext(client), undefined);

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(PATH);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("maps every field of the platform's response faithfully — violations, tenantViolationCount, knownNonTenantCount, valueTypes", async () => {
    const client = makeFakeReadClient({ [PATH]: RAW_RESPONSE });

    const result = await inventoryTool.handler(makeContext(client), undefined);

    expect(result.violations).toEqual([VIOLATION, KNOWN_NON_TENANT_VIOLATION]);
    expect(result.tenantViolationCount).toBe(1);
    expect(result.knownNonTenantCount).toBe(1);
    expect(result.valueTypes).toEqual([{ valueType: "string", count: 40 }]);
  });

  it("puts tenantViolationCount ahead of violations in the serialized result — the real number is not buried behind a long array", async () => {
    const client = makeFakeReadClient({ [PATH]: RAW_RESPONSE });

    const result = await inventoryTool.handler(makeContext(client), undefined);

    const keys = Object.keys(result);
    expect(keys.indexOf("tenantViolationCount")).toBeLessThan(keys.indexOf("violations"));
  });

  it("an empty violations list still forwards tenantViolationCount=0 explicitly — never inferred by the caller", async () => {
    const client = makeFakeReadClient({
      [PATH]: { violations: [], tenantViolationCount: 0, knownNonTenantCount: 0, valueTypes: [] },
    });

    const result = await inventoryTool.handler(makeContext(client), undefined);

    expect(result.tenantViolationCount).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeReadClient({ [PATH]: RAW_RESPONSE });

    await expect(inventoryTool.handler(makeContext(client, true), undefined)).resolves.toBeDefined();
  });

  it("on a 403 from a non-editor role, surfaces the platform's rejection unchanged — never a silent empty inventory", async () => {
    const error = new PlatformApiError(403, "Forbidden", { code: "permission_denied", message: "not a meta editor" });
    const client = makeFakeReadClient({ [PATH]: error });

    let caught: unknown;
    try {
      await inventoryTool.handler(makeContext(client), undefined);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
    expect((caught as PlatformApiError).code).toBe("permission_denied");
  });

  it("on a 503 rules-unavailable, surfaces the platform's rejection unchanged — never a silent empty inventory (the worst possible lie for a diagnostic tool)", async () => {
    const error = new PlatformApiError(503, "Service Unavailable", {
      code: "meta_rules_unavailable",
      message: "Правила проверки меты недоступны, инвентаризация невозможна",
    });
    const client = makeFakeReadClient({ [PATH]: error });

    let caught: unknown;
    try {
      await inventoryTool.handler(makeContext(client), undefined);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).code).toBe("meta_rules_unavailable");
  });
});
