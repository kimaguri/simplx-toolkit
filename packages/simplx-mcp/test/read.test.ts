import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
// T052 does not exist yet — this import is expected to fail to resolve
// until the read tools land, which is the correct RED reason for T045
// (tool absent), not a typo in this test file.
import { getEntityTool, getSchemaTool, listAppsTool } from "../src/tools/meta/read.js";

/**
 * LAB-257 T045 — contract tests for the three MCP read tools
 * (`meta.get_schema`, `meta.list_apps`, `meta.get_entity`), written BEFORE
 * their implementation (T052, `src/tools/meta/read.ts`).
 *
 * contracts/mcp-tools.md pins two facts these tests exist to enforce:
 *
 *  1. "Тонкая обёртка... Собственной логики не несёт: правила проверяются
 *     на сервере." — none of these tools may hold a local copy of rules or
 *     invent data; every result must be traceable to a call through the
 *     injected `PlatformClient`. `get_schema` in particular must forward
 *     `GET /api/v1/meta/schema` verbatim (R16, R20) — a hand-rolled local
 *     schema would never touch the client mock and the test would catch it.
 *
 *  2. "Править агент обязан raw. Запись собранного resolved затёрла бы
 *     наследование..." — `get_entity` MUST return `raw` and `resolved` as
 *     two distinct values when the platform's own response carries them as
 *     distinct values. A tool that collapses one into the other (returns
 *     `resolved` twice, or derives `raw` from `resolved`) passes a naive
 *     "does it return raw and resolved" check but fails the one that
 *     matters: are they actually the two different things the platform
 *     sent.
 *
 * Reads are allowed on both profiles (test and prod) — unlike the write
 * tools, nothing here asserts a profile-gated rejection.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface — no HTTP fetch
 * happens in this file.
 */

const CONNECTION = {
  baseUrl: "https://platform.example.test",
  tenantSlug: "acme",
  bearerToken: "token",
};

/**
 * A `PlatformClient` double whose `get`/`request` resolve from a path ->
 * response lookup table and whose `write` always throws — a read tool
 * reaching for `write` at all is itself a bug this double catches.
 *
 * T163: `responses` holds the ALREADY-UNWRAPPED payload for each path —
 * i.e. exactly what `client.get()` resolves to in reality, per T050's
 * `platform-client.ts`, which unwraps the platform's `{ data, message }`
 * (or write-only `{ data }`) envelope itself before returning. A fake that
 * instead resolved with the raw envelope would let a tool implementation
 * that (redundantly, incorrectly) does its own `.data` unwrap pass here
 * while returning `undefined` against the real client.
 */
const makeFakeClient = (responses: Record<string, unknown>): PlatformClient => {
  const get = vi.fn(async <T,>(path: string): Promise<T> => {
    if (!(path in responses)) {
      throw new Error(`fake platform client: unexpected GET ${path}`);
    }
    return responses[path] as T;
  });
  const write = vi.fn(async () => {
    throw new Error("fake platform client: a read tool must never call write()");
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

describe("meta.get_schema — LAB-257 T045", () => {
  it('is registered under the contract name "meta.get_schema"', () => {
    expect(getSchemaTool.name).toBe("meta.get_schema");
  });

  it("fetches the rules from GET /api/v1/meta/schema and forwards them as-is — no locally re-derived schema", async () => {
    const platformSchema = {
      manifest: {
        packageVersion: "3.2.1",
        generatedAt: "2026-08-01T00:00:00.000Z",
        schemas: {
          "entity-config": { version: "3.2.1", file: "entity.schema.json" },
          "app-config": { version: "3.2.1", file: "app.schema.json" },
        },
      },
      entitySchema: { type: "object", properties: { entityName: { type: "string" } } },
      appSchema: { type: "object" },
    };
    const client = makeFakeClient({
      "/api/v1/meta/schema": platformSchema,
    });

    const result = await getSchemaTool.handler(makeContext(client), undefined);

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/schema");
    // Verbatim forward, not a reshaped/re-derived payload — this is what
    // rules out a second, drifting implementation of the schema (R16).
    expect(result).toEqual(platformSchema);
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/schema": { manifest: { packageVersion: "1.0.0", generatedAt: "x", schemas: {} }, entitySchema: {}, appSchema: {} },
    });

    await expect(getSchemaTool.handler(makeContext(client, true), undefined)).resolves.toBeDefined();
  });
});

describe("meta.list_apps — LAB-257 T045", () => {
  it('is registered under the contract name "meta.list_apps"', () => {
    expect(listAppsTool.name).toBe("meta.list_apps");
  });

  it("returns, for the given tenant, every app together with its entities' current versions — sourced through the client, not hardcoded", async () => {
    const TENANT = "tenant-acme";
    // T052: settled to a SINGLE call against GET /api/v1/meta/apps/tenant/:tenantId
    // (T159, platform/src/services/tenant-management/meta-apps-api.ts —
    // `listTenantApps`) — that handler already returns every app with its
    // own version AND its own entities with their versions in one response
    // shaped exactly `{ apps: [{ appName, version, entities }] }`, so no
    // N-call composition is needed. (Originally left open by T045/T163;
    // this fixture used a stale pre-`/tenant/`-segment, multi-call shape —
    // fixed here against the real platform response, not invented.)
    const apps = [
      {
        appName: "intellhouse",
        version: 12,
        entities: [
          { entityName: "contacts", version: 7 },
          { entityName: "deals", version: 3 },
        ],
      },
      { appName: "koreana", version: 4, entities: [{ entityName: "stock", version: 1 }] },
    ];
    const client = makeFakeClient({ [`/api/v1/meta/apps/tenant/${TENANT}`]: { apps } });

    const result = await listAppsTool.handler(makeContext(client), { tenant: TENANT });

    expect((client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(result).toEqual({
      apps: [
        { appName: "intellhouse", version: 12, entities: [{ entityName: "contacts", version: 7 }, { entityName: "deals", version: 3 }] },
        { appName: "koreana", version: 4, entities: [{ entityName: "stock", version: 1 }] },
      ],
    });
  });

  it("scopes strictly to the requested tenant — a client answering only for a different tenant makes the call fail, not silently return nothing", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/apps/tenant/some-other-tenant": { apps: [{ appName: "intellhouse", version: 1, entities: [] }] },
    });

    await expect(listAppsTool.handler(makeContext(client), { tenant: "tenant-acme" })).rejects.toThrow();
  });
});

describe("meta.get_entity — LAB-257 T045", () => {
  it('is registered under the contract name "meta.get_entity"', () => {
    expect(getEntityTool.name).toBe("meta.get_entity");
  });

  it("returns raw and resolved as the two DISTINCT values the platform sent — never collapsing one into the other", async () => {
    const TENANT = "tenant-acme";
    const APP = "intellhouse";
    const ENTITY = "contacts";
    // raw is what's stored — basedOn + overrides, deliberately thin.
    const raw = { entityName: "contacts", basedOn: "contacts", overrides: { fields: { inn: { required: true } } } };
    // resolved is the assembled view — template fields folded in, refs
    // resolved — and is intentionally shaped very differently from raw so a
    // tool that accidentally copies one into the other is unmistakable.
    const resolved = {
      entityName: "contacts",
      fields: { name: { type: "string" }, inn: { type: "string", required: true } },
      list: { columns: ["name", "inn"] },
    };
    const client = makeFakeClient({
      [`/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`]: { entityName: ENTITY, version: 7, basedOn: "contacts", resolved, raw },
    });

    const result = await getEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY });

    expect(result).toEqual({ entityName: ENTITY, version: 7, basedOn: "contacts", resolved, raw });
    // The load-bearing assertion: the two views must stay distinct objects
    // with distinct content — this is what makes "edit raw, never resolved"
    // possible for the agent in the first place.
    expect((result as { raw: unknown; resolved: unknown }).raw).not.toEqual((result as { raw: unknown; resolved: unknown }).resolved);
    expect(client.get).toHaveBeenCalledWith(`/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`);
  });

  it("still returns raw and resolved as two distinct values when the entity has no basedOn (no template applied yet)", async () => {
    // Guards against an implementation that only keeps raw/resolved
    // distinct when a template is involved — the contract makes no such
    // exception, and the current platform phase may not resolve templates
    // at all yet (per T018), so raw === resolved is also a legitimate
    // platform answer this tool must still forward faithfully as TWO keys,
    // not silently drop one.
    const TENANT = "tenant-acme";
    const APP = "intellhouse";
    const ENTITY = "warehouse";
    const config = { entityName: "warehouse", fields: { code: { type: "string" } } };
    const client = makeFakeClient({
      [`/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`]: { entityName: ENTITY, version: 1, resolved: config, raw: config },
    });

    const result = await getEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY });

    expect(result).toMatchObject({ raw: config, resolved: config });
    expect(Object.prototype.hasOwnProperty.call(result, "raw")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "resolved")).toBe(true);
  });

  it("propagates a not-found from the platform instead of swallowing it", async () => {
    const client = makeFakeClient({}); // no path registered -> fake client throws, simulating a 404 upstream

    await expect(
      getEntityTool.handler(makeContext(client), { tenant: "tenant-acme", app: "intellhouse", entity: "does-not-exist" }),
    ).rejects.toThrow();
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const raw = { entityName: "contacts" };
    const client = makeFakeClient({
      "/api/v1/meta/entities/tenant-acme/intellhouse/contacts": { entityName: "contacts", version: 1, resolved: raw, raw },
    });

    await expect(
      getEntityTool.handler(makeContext(client, true), { tenant: "tenant-acme", app: "intellhouse", entity: "contacts" }),
    ).resolves.toBeDefined();
  });
});
