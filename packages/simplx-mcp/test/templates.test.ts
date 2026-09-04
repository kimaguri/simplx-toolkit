import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
import { getTemplateTool, listTemplatesTool, templateDependentsTool } from "../src/tools/meta/templates.js";

/**
 * LAB-257 T090 — contract tests for the three MCP template READ tools
 * (`meta.list_templates`, `meta.get_template`, `meta.template_dependents`).
 * `meta.write_template` already has its spec (`test/write.test.ts`, T046) —
 * this file does not duplicate it.
 *
 * No dedicated test task exists for these three in tasks.md the way T045/
 * T046/T047 covered the entity/app tool set — written here, before the
 * implementation, per the same test-first convention (constitution §4)
 * `read.test.ts`/`inspect.test.ts` already establish for this package.
 *
 * Verified against the platform's real handlers directly
 * (`platform/.worktrees/lab-257-meta-in-database/src/services/tenant-
 * management/meta-templates-api.ts`), not against assumption:
 *   - `listTemplates`: GET /api/v1/meta/templates -> { templates: [{ templateKey, displayName, version }] }
 *   - `getTemplate`: GET /api/v1/meta/templates/:templateKey -> { templateKey, displayName, version, config }
 *   - `getTemplateDependents`: GET /api/v1/meta/templates/:templateKey/dependents
 *     -> { tenants: [{ tenantId, entityName }], total } — `total` is
 *     `tenants.length` BY CONSTRUCTION on the platform side (T086), never a
 *     second count; this tool must not recompute it either.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface.
 */

const CONNECTION = {
  baseUrl: "https://platform.example.test",
  tenantSlug: "acme",
  bearerToken: "token",
};

/** Same double `read.test.ts` uses: `get`/`request` resolve from a path ->
 * already-unwrapped-payload lookup table; `write` always throws. */
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

describe("meta.list_templates — LAB-257 T090", () => {
  it('is registered under the contract name "meta.list_templates"', () => {
    expect(listTemplatesTool.name).toBe("meta.list_templates");
  });

  it("fetches from GET /api/v1/meta/templates and forwards the list verbatim", async () => {
    const platformResult = {
      templates: [
        { templateKey: "contacts", displayName: "contacts", version: 3 },
        { templateKey: "deals", displayName: "deals", version: 1 },
      ],
    };
    const client = makeFakeClient({ "/api/v1/meta/templates": platformResult });

    const result = await listTemplatesTool.handler(makeContext(client), undefined);

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates");
    expect(result).toEqual(platformResult);
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeClient({ "/api/v1/meta/templates": { templates: [] } });
    await expect(listTemplatesTool.handler(makeContext(client, true), undefined)).resolves.toBeDefined();
  });
});

describe("meta.get_template — LAB-257 T090", () => {
  it('is registered under the contract name "meta.get_template"', () => {
    expect(getTemplateTool.name).toBe("meta.get_template");
  });

  it("fetches from GET /api/v1/meta/templates/{templateKey} and forwards the content verbatim", async () => {
    const platformResult = {
      templateKey: "contacts",
      displayName: "contacts",
      version: 3,
      config: { fields: { name: { type: "string" } } },
    };
    const client = makeFakeClient({ "/api/v1/meta/templates/contacts": platformResult });

    const result = await getTemplateTool.handler(makeContext(client), { templateKey: "contacts" });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates/contacts");
    expect(result).toEqual(platformResult);
  });

  it("propagates not-found from the platform instead of swallowing it", async () => {
    const client = makeFakeClient({});
    await expect(
      getTemplateTool.handler(makeContext(client), { templateKey: "does-not-exist" }),
    ).rejects.toThrow();
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/templates/contacts": { templateKey: "contacts", displayName: "contacts", version: 1, config: {} },
    });
    await expect(
      getTemplateTool.handler(makeContext(client, true), { templateKey: "contacts" }),
    ).resolves.toBeDefined();
  });
});

describe("meta.template_dependents — LAB-257 T090 (FR-037)", () => {
  it('is registered under the contract name "meta.template_dependents"', () => {
    expect(templateDependentsTool.name).toBe("meta.template_dependents");
  });

  it("fetches from GET /api/v1/meta/templates/{templateKey}/dependents and forwards the platform's own total verbatim, never recomputed", async () => {
    // `total` deliberately does NOT equal `tenants.length` here — if this
    // tool ever recomputed `total` instead of forwarding it, this test
    // would still pass with a value that happens to look plausible; the
    // point is proven by the assertion checking the SERVER's number came
    // through unchanged, not a locally-derived one.
    const platformResult = {
      tenants: [
        { tenantId: "tenant-a", entityName: "contacts" },
        { tenantId: "tenant-b", entityName: "contacts" },
      ],
      total: 2,
    };
    const client = makeFakeClient({ "/api/v1/meta/templates/contacts/dependents": platformResult });

    const result = await templateDependentsTool.handler(makeContext(client), { templateKey: "contacts" });

    expect(client.get).toHaveBeenCalledWith("/api/v1/meta/templates/contacts/dependents");
    expect(result).toEqual(platformResult);
  });

  it("forwards an empty dependents list and zero total as-is — not an error", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/templates/orphan/dependents": { tenants: [], total: 0 },
    });

    const result = await templateDependentsTool.handler(makeContext(client), { templateKey: "orphan" });

    expect(result).toEqual({ tenants: [], total: 0 });
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/templates/contacts/dependents": { tenants: [], total: 0 },
    });
    await expect(
      templateDependentsTool.handler(makeContext(client, true), { templateKey: "contacts" }),
    ).resolves.toBeDefined();
  });
});
