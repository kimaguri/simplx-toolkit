import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
import { rollbackTool, versionsTool } from "../src/tools/meta/history.js";

/**
 * LAB-257 T055 — contract tests for the two MCP history tools
 * (`meta.versions`, `meta.rollback`), written before verifying the
 * implementation (constitution §4). No dedicated test task exists for
 * these in tasks.md the way T045/T046/T047 covered the entity/app tool
 * set — written here per the same test-first convention `read.test.ts` /
 * `templates.test.ts` already establish for this package, and verified
 * against the platform's real handlers directly
 * (`platform/.worktrees/lab-257-meta-in-database/src/services/tenant-
 * management/{meta-entities-api.ts,meta-apps-api.ts}`), not assumed:
 *
 *   - `getEntityVersionsByName`: GET /api/v1/meta/entities/{t}/{a}/{e}/versions
 *   - `getAppVersions`:          GET /api/v1/meta/apps/{t}/{a}/versions
 *   - `rollbackEntityMetaByName`: POST /api/v1/meta/entities/{t}/{a}/{e}/rollback
 *   - `rollbackAppMetaById`:      POST /api/v1/meta/apps/{t}/{a}/rollback
 *
 * `meta.rollback` is a WRITE tool — every test below drives it through a
 * fake `PlatformClient` exactly as the sibling write tools do, and a
 * separate describe block proves it is rejected by `WriteCapableProfile`
 * at compile time is NOT this file's job (that's `test/profiles.type-
 * test.ts`'s pattern) — this file proves the RUNTIME behavior only.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const makeFakeReadClient = (responses: Record<string, unknown>): PlatformClient => {
  const get = vi.fn(async <T,>(path: string): Promise<T> => {
    if (!(path in responses)) {
      throw new Error(`fake platform client: unexpected GET ${path}`);
    }
    return responses[path] as T;
  });
  const write = vi.fn(async () => {
    throw new Error("fake platform client: meta.versions must never call write()");
  });
  const request = vi.fn(async (options: { method?: string; path: string }) => {
    if (options.method && options.method !== "GET") {
      throw new Error(`fake platform client: unexpected ${options.method} ${options.path}`);
    }
    return get(options.path);
  });
  return { get, write, request } as unknown as PlatformClient;
};

type WriteResponder = (body: unknown, method: string) => unknown;

const makeFakeWriteClient = (write: Record<string, WriteResponder>): PlatformClient => {
  const get = vi.fn(async () => {
    throw new Error("fake platform client: meta.rollback must never call get()");
  });
  const writeFn = vi.fn(async (path: string, body: unknown, method = "POST") => {
    const responder = write[path];
    if (!responder) {
      throw new Error(`fake platform client: unexpected ${method} ${path}`);
    }
    return responder(body, method);
  });
  const request = vi.fn(async (options: { method?: string; path: string; body?: unknown }) => {
    if (!options.method || options.method === "GET") return get();
    return writeFn(options.path, options.body, options.method);
  });
  return { get, write: writeFn, request } as unknown as PlatformClient;
};

const makeContext = (client: PlatformClient, useProdProfile = false): ToolContext => ({
  profile: useProdProfile ? createProdProfile(CONNECTION) : createTestProfile(CONNECTION),
  client,
});

const ENTITY_HISTORY_ENTRY = {
  id: "ver-1",
  tenant_id: "tenant-acme",
  meta_type: "entity" as const,
  meta_id: "entity-row-1",
  entity_name: "contacts",
  from_version: 4,
  to_version: 5,
  previous_config: { fields: { name: {} } },
  new_config: { fields: { name: {}, phone: {} } },
  change_source: "admin_ui",
  change_reason: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: "user-1",
  versioning_scheme: "entity",
  versioningScheme: "entity" as const,
  isSchemeBoundary: false,
};

const LEGACY_HISTORY_ENTRY = {
  ...ENTITY_HISTORY_ENTRY,
  id: "ver-legacy-1",
  to_version: 2,
  versioning_scheme: "legacy_app",
  versioningScheme: "legacy_app" as const,
  isSchemeBoundary: true,
};

describe("meta.versions — LAB-257 T055", () => {
  it('is registered under the contract name "meta.versions"', () => {
    expect(versionsTool.name).toBe("meta.versions");
  });

  it("reads entity history from GET /api/v1/meta/entities/{tenant}/{app}/{entity}/versions when entity is given", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/entities/tenant-acme/intellhouse/contacts/versions": [ENTITY_HISTORY_ENTRY, LEGACY_HISTORY_ENTRY],
    });

    const result = await versionsTool.handler(makeContext(client), {
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
    });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/entities/tenant-acme/intellhouse/contacts/versions");
    expect(result).toEqual([ENTITY_HISTORY_ENTRY, LEGACY_HISTORY_ENTRY]);
  });

  it("reads app history from GET /api/v1/meta/apps/{tenant}/{app}/versions when entity is OMITTED", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/apps/tenant-acme/intellhouse/versions": [ENTITY_HISTORY_ENTRY],
    });

    const result = await versionsTool.handler(makeContext(client), { tenant: "tenant-acme", app: "intellhouse" });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/apps/tenant-acme/intellhouse/versions");
    expect(result).toEqual([ENTITY_HISTORY_ENTRY]);
  });

  it("forwards versioningScheme AND isSchemeBoundary on every entry, untouched, including the mixed casing", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/entities/tenant-acme/intellhouse/contacts/versions": [ENTITY_HISTORY_ENTRY, LEGACY_HISTORY_ENTRY],
    });

    const result = await versionsTool.handler(makeContext(client), {
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
    });

    expect(result[0]?.versioningScheme).toBe("entity");
    expect(result[0]?.isSchemeBoundary).toBe(false);
    expect(result[1]?.versioningScheme).toBe("legacy_app");
    expect(result[1]?.isSchemeBoundary).toBe(true);
    // The rest of the row stays snake_case — not tidied into one convention.
    expect(result[0]).toHaveProperty("entity_name");
    expect(result[0]).toHaveProperty("previous_config");
  });

  it("appends limit/offset as query params only when given", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/apps/tenant-acme/intellhouse/versions?limit=10&offset=5": [],
    });

    await versionsTool.handler(makeContext(client), { tenant: "tenant-acme", app: "intellhouse", limit: 10, offset: 5 });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/apps/tenant-acme/intellhouse/versions?limit=10&offset=5");
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeReadClient({ "/api/v1/meta/apps/tenant-acme/intellhouse/versions": [] });
    await expect(
      versionsTool.handler(makeContext(client, true), { tenant: "tenant-acme", app: "intellhouse" }),
    ).resolves.toBeDefined();
  });

  it("reads template history from GET /api/v1/meta/templates/{templateKey}/versions when templateKey is given — no tenant/app/entity needed", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/templates/contacts-base/versions": [ENTITY_HISTORY_ENTRY],
    });

    const result = await versionsTool.handler(makeContext(client), { templateKey: "contacts-base" });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates/contacts-base/versions");
    expect(result).toEqual([ENTITY_HISTORY_ENTRY]);
  });

  it("templateKey takes precedence — tenant/app/entity are ignored when templateKey is also given", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/templates/contacts-base/versions": [ENTITY_HISTORY_ENTRY],
    });

    await versionsTool.handler(makeContext(client), {
      templateKey: "contacts-base",
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
    });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates/contacts-base/versions");
  });

  it("appends limit/offset for template history too", async () => {
    const client = makeFakeReadClient({
      "/api/v1/meta/templates/contacts-base/versions?limit=10&offset=5": [],
    });

    await versionsTool.handler(makeContext(client), { templateKey: "contacts-base", limit: 10, offset: 5 });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates/contacts-base/versions?limit=10&offset=5");
  });

  it("works on the prod profile for template history too — reads are never profile-gated", async () => {
    const client = makeFakeReadClient({ "/api/v1/meta/templates/contacts-base/versions": [] });
    await expect(
      versionsTool.handler(makeContext(client, true), { templateKey: "contacts-base" }),
    ).resolves.toBeDefined();
  });
});

describe("meta.rollback — LAB-257 T055", () => {
  it('is registered under the contract name "meta.rollback"', () => {
    expect(rollbackTool.name).toBe("meta.rollback");
  });

  it("rolls back an entity via POST /api/v1/meta/entities/{tenant}/{app}/{entity}/rollback when entity is given, forwarding expectedVersion and returning the server's response verbatim", async () => {
    const PATH = "/api/v1/meta/entities/tenant-acme/intellhouse/contacts/rollback";
    const client = makeFakeWriteClient({
      [PATH]: (body: any) => {
        expect(body).toMatchObject({ targetVersionId: "ver-1", expectedVersion: 5, changeReason: "откат опечатки" });
        return { newVersion: 6, unknownComponents: [] };
      },
    });

    const result = await rollbackTool.handler(makeContext(client), {
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
      targetVersionId: "ver-1",
      expectedVersion: 5,
      changeReason: "откат опечатки",
    });

    expect(result).toEqual({ newVersion: 6, unknownComponents: [] });
  });

  it("rolls back an app description via POST /api/v1/meta/apps/{tenant}/{app}/rollback when entity is OMITTED", async () => {
    const PATH = "/api/v1/meta/apps/tenant-acme/intellhouse/rollback";
    const client = makeFakeWriteClient({
      [PATH]: (body: any) => {
        expect(body).toMatchObject({ targetVersionId: "ver-app-1", expectedVersion: 5 });
        return { newVersion: 6, unknownComponents: [] };
      },
    });

    const result = await rollbackTool.handler(makeContext(client), {
      tenant: "tenant-acme",
      app: "intellhouse",
      targetVersionId: "ver-app-1",
      expectedVersion: 5,
    });

    expect(result).toEqual({ newVersion: 6, unknownComponents: [] });
  });

  it("surfaces the server's unknownComponents warnings (computed against the RESTORED config) without filtering them", async () => {
    const PATH = "/api/v1/meta/entities/tenant-acme/intellhouse/contacts/rollback";
    const client = makeFakeWriteClient({
      [PATH]: () => ({
        newVersion: 6,
        unknownComponents: [{ path: "/views/detail/sections/0", message: "unknown component RetiredWidget" }],
      }),
    });

    const result = await rollbackTool.handler(makeContext(client), {
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
      targetVersionId: "ver-1",
      expectedVersion: 5,
    });

    expect(result.unknownComponents).toEqual([{ path: "/views/detail/sections/0", message: "unknown component RetiredWidget" }]);
  });

  it("on a version conflict, surfaces the server's rejection unchanged — no local retry, no reshaping", async () => {
    const PATH = "/api/v1/meta/entities/tenant-acme/intellhouse/contacts/rollback";
    class PlatformError extends Error {
      code = "failed_precondition";
      details = { params: { currentVersion: 8, expectedVersion: 5 } };
    }
    const client = makeFakeWriteClient({
      [PATH]: () => {
        throw new PlatformError("stale");
      },
    });

    let caught: any;
    try {
      await rollbackTool.handler(makeContext(client), {
        tenant: "tenant-acme",
        app: "intellhouse",
        entity: "contacts",
        targetVersionId: "ver-1",
        expectedVersion: 5,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught?.details?.params?.currentVersion).toBe(8);
  });

  it("rolls back a template via POST /api/v1/meta/templates/{templateKey}/rollback when templateKey is given, forwarding acknowledgedDependents", async () => {
    const PATH = "/api/v1/meta/templates/contacts-base/rollback";
    const client = makeFakeWriteClient({
      [PATH]: (body: any) => {
        expect(body).toMatchObject({
          targetVersionId: "ver-tpl-1",
          expectedVersion: 3,
          acknowledgedDependents: 7,
          changeReason: "откат шаблона",
        });
        return { newVersion: 4, unknownComponents: [] };
      },
    });

    const result = await rollbackTool.handler(makeContext(client), {
      templateKey: "contacts-base",
      targetVersionId: "ver-tpl-1",
      expectedVersion: 3,
      acknowledgedDependents: 7,
      changeReason: "откат шаблона",
    });

    expect(result).toEqual({ newVersion: 4, unknownComponents: [] });
  });

  it("templateKey takes precedence for rollback too — tenant/app/entity are ignored", async () => {
    const PATH = "/api/v1/meta/templates/contacts-base/rollback";
    const client = makeFakeWriteClient({
      [PATH]: () => ({ newVersion: 4, unknownComponents: [] }),
    });

    await rollbackTool.handler(makeContext(client), {
      templateKey: "contacts-base",
      tenant: "tenant-acme",
      app: "intellhouse",
      entity: "contacts",
      targetVersionId: "ver-tpl-1",
      expectedVersion: 3,
      acknowledgedDependents: 7,
    });

    expect(client.write).toHaveBeenCalledWith(PATH, expect.anything());
  });

  it("rejects a template rollback missing acknowledgedDependents WITHOUT calling the platform — never computes or defaults it", async () => {
    const client = makeFakeWriteClient({});

    await expect(
      rollbackTool.handler(makeContext(client), {
        templateKey: "contacts-base",
        targetVersionId: "ver-tpl-1",
        expectedVersion: 3,
      }),
    ).rejects.toThrow(/acknowledgedDependents/);

    expect(client.write).not.toHaveBeenCalled();
  });

  it("on a stale acknowledgement, surfaces the server's meta_template_ack_dependents_stale rejection unchanged", async () => {
    const PATH = "/api/v1/meta/templates/contacts-base/rollback";
    class PlatformError extends Error {
      code = "meta_template_ack_dependents_stale";
      details = { params: { actualDependents: 9, acknowledgedDependents: 7 } };
    }
    const client = makeFakeWriteClient({
      [PATH]: () => {
        throw new PlatformError("stale ack");
      },
    });

    let caught: any;
    try {
      await rollbackTool.handler(makeContext(client), {
        templateKey: "contacts-base",
        targetVersionId: "ver-tpl-1",
        expectedVersion: 3,
        acknowledgedDependents: 7,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe("meta_template_ack_dependents_stale");
    expect(caught?.details?.params?.actualDependents).toBe(9);
  });

  it("is a write tool — registered as kind \"write\", not \"read\"", () => {
    expect(rollbackTool.kind).toBe("write");
  });
});
