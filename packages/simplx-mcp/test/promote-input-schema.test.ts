import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";
import type { PlatformClient } from "../src/client/platform-client.js";
import type { ToolContext } from "../src/tools/registry.js";
import { promotePreviewTool, promoteTool } from "../src/tools/meta/promote.js";

/**
 * LAB-272 T063 — contract tests for `meta.promote_preview` / `meta.promote`.
 *
 * The address rule under test (confirmed against the platform's own
 * `resolveAddress`, LAB-272 T062): exactly THREE mutually exclusive
 * shapes — `{ tenantSlug, app, entity? }` (app or entity address) or
 * `{ templateKey }` alone (template address, cross-tenant — tenantSlug/app/
 * entity MUST be absent). There is no `acknowledgedDependents` field on
 * `meta.promote` — the platform recounts a template's dependents on the
 * TARGET itself as part of the promote call.
 *
 * Two layers, matching the conventions already used for the other write
 * tools in this package:
 *  - JSON Schema level (`test/write-input-schema.test.ts`'s pattern): what
 *    the calling agent sees at `tools/list`, through a real MCP client.
 *  - Handler level (`test/write.test.ts`'s pattern): the runtime checks a
 *    Zod-optional field alone cannot express, against a hand-rolled
 *    `PlatformClient` double — no network involved.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const connectClient = async () => {
  const server = createSimplxMcpServer({ profile: createTestProfile(CONNECTION) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t063-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const findTool = (tools: readonly { name: string; inputSchema?: unknown }[], name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not found in tools/list`);
  return tool;
};

type WriteResponder = (body: unknown, method: string) => unknown;

const makeFakeClient = (write: Record<string, WriteResponder>): PlatformClient => {
  const writeFn = vi.fn(async (path: string, body: unknown, method = "POST") => {
    const responder = write[path];
    if (!responder) throw new Error(`fake platform client: unexpected ${method} ${path}`);
    return responder(body, method);
  });
  const get = vi.fn(async (path: string) => {
    throw new Error(`fake platform client: unexpected GET ${path}`);
  });
  const request = vi.fn(async (options: { method?: string; path: string; body?: unknown }) => {
    if (!options.method || options.method === "GET") return get(options.path);
    return writeFn(options.path, options.body, options.method);
  });
  return { get, write: writeFn, request } as unknown as PlatformClient;
};

const makeContext = (client: PlatformClient): ToolContext => ({
  profile: createTestProfile(CONNECTION),
  client,
});

describe("meta.promote_preview / meta.promote JSON Schema — LAB-272 T063", () => {
  it("meta.promote's JSON Schema lists expectedTargetVersion as required (a preview always precedes a promote, so there is no legitimate omission)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.promote");
      const schema = tool.inputSchema as { required?: readonly string[] };
      expect(schema.required ?? []).toContain("expectedTargetVersion");
    } finally {
      await client.close();
    }
  });

  it("neither tool's JSON Schema hard-requires tenantSlug/app at the schema level (the three-shapes rule is conditional, checked at runtime — a template address legitimately omits both)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const name of ["meta.promote_preview", "meta.promote"]) {
        const tool = findTool(tools, name);
        const schema = tool.inputSchema as { required?: readonly string[] };
        expect(schema.required ?? []).not.toContain("tenantSlug");
        expect(schema.required ?? []).not.toContain("app");
        expect(schema.required ?? []).not.toContain("entity");
        expect(schema.required ?? []).not.toContain("templateKey");
        expect(schema.required ?? []).not.toContain("target");
      }
    } finally {
      await client.close();
    }
  });

  it("meta.promote has no acknowledgedDependents field at all — the platform recounts template dependents on the target itself", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.promote");
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties ?? {}).not.toHaveProperty("acknowledgedDependents");
    } finally {
      await client.close();
    }
  });
});

describe("meta.promote_preview / meta.promote — the three mutually exclusive address shapes (LAB-272 T063)", () => {
  it("meta.promote_preview rejects templateKey mixed with tenantSlug/app/entity", async () => {
    const client = makeFakeClient({});
    await expect(
      promotePreviewTool.handler(makeContext(client), {
        tenantSlug: "acme",
        app: "intellhouse",
        entity: "contacts",
        templateKey: "base-crm",
      }),
    ).rejects.toThrow(/mutually exclusive/i);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("meta.promote rejects templateKey mixed with tenantSlug alone (no entity/app needed to trip the rule)", async () => {
    const client = makeFakeClient({});
    await expect(
      promoteTool.handler(makeContext(client), {
        tenantSlug: "acme",
        templateKey: "base-crm",
        expectedTargetVersion: 3,
      }),
    ).rejects.toThrow(/mutually exclusive/i);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("rejects an address giving neither tenantSlug/app nor templateKey", async () => {
    const client = makeFakeClient({});
    await expect(
      promotePreviewTool.handler(makeContext(client), {}),
    ).rejects.toThrow(/tenantSlug and app are both required/i);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("rejects tenantSlug given without app", async () => {
    const client = makeFakeClient({});
    await expect(
      promotePreviewTool.handler(makeContext(client), { tenantSlug: "acme" }),
    ).rejects.toThrow(/tenantSlug and app are both required/i);
  });

  it("meta.promote_preview accepts tenantSlug+app with no entity (whole-app address) — body carries no entityName/templateKey", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote/preview": (body) => {
        expect(body).toMatchObject({ target: "prod", tenantSlug: "acme", appName: "intellhouse" });
        expect(body).not.toHaveProperty("entityName");
        expect(body).not.toHaveProperty("templateKey");
        return { source: {}, target: {}, targetVersion: 4, templateStale: false, diff: [] };
      },
    });
    const result = await promotePreviewTool.handler(makeContext(client), {
      tenantSlug: "acme",
      app: "intellhouse",
    });
    expect(result).toMatchObject({ targetVersion: 4, templateStale: false });
  });

  it("meta.promote_preview accepts templateKey alone — body carries ONLY target/templateKey, no tenantSlug/appName at all", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote/preview": (body) => {
        expect(body).toEqual({ target: "prod", templateKey: "base-crm" });
        return { source: {}, target: null, targetVersion: null, templateStale: false, diff: [] };
      },
    });
    const result = await promotePreviewTool.handler(makeContext(client), { templateKey: "base-crm" });
    expect(result).toMatchObject({ target: null, targetVersion: null });
  });
});

describe("meta.promote — request/response shapes (LAB-272 T063)", () => {
  it("forwards expectedTargetVersion verbatim, null included, alongside changeSource: mcp, for an entity address", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote": (body) => {
        expect(body).toEqual({
          target: "prod",
          tenantSlug: "acme",
          appName: "intellhouse",
          entityName: "contacts",
          expectedTargetVersion: null,
          changeSource: "mcp",
        });
        return { targetVersion: 1, unknownComponents: [], actor: "agent:mcp" };
      },
    });
    const result = await promoteTool.handler(makeContext(client), {
      tenantSlug: "acme",
      app: "intellhouse",
      entity: "contacts",
      expectedTargetVersion: null,
    });
    expect(result).toEqual({ targetVersion: 1, unknownComponents: [], actor: "agent:mcp" });
  });

  it("promotes a template by templateKey alone, no tenantSlug/appName in the body, and never sends acknowledgedDependents", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote": (body) => {
        expect(body).toEqual({
          target: "prod",
          templateKey: "base-crm",
          expectedTargetVersion: 2,
          changeSource: "mcp",
        });
        expect(body).not.toHaveProperty("acknowledgedDependents");
        return { targetVersion: 3, unknownComponents: [], actor: "agent:mcp" };
      },
    });
    const result = await promoteTool.handler(makeContext(client), {
      templateKey: "base-crm",
      expectedTargetVersion: 2,
    });
    expect(result).toEqual({ targetVersion: 3, unknownComponents: [], actor: "agent:mcp" });
  });

  it("promotes the whole app when entity is omitted", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote": (body) => {
        expect(body).not.toHaveProperty("entityName");
        return { targetVersion: 8, unknownComponents: [], actor: null };
      },
    });
    const result = await promoteTool.handler(makeContext(client), {
      tenantSlug: "acme",
      app: "intellhouse",
      expectedTargetVersion: 7,
    });
    expect(result).toEqual({ targetVersion: 8, unknownComponents: [], actor: null });
  });
});
