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
 * Two layers, matching the conventions already used for the other write
 * tools in this package:
 *  - JSON Schema level (`test/write-input-schema.test.ts`'s pattern): what
 *    the calling agent sees at `tools/list`, through a real MCP client.
 *  - Handler level (`test/write.test.ts`'s pattern): the runtime checks a
 *    Zod-optional field alone cannot express (exactly-one-of
 *    entity/templateKey; acknowledgedDependents required for templateKey),
 *    against a hand-rolled `PlatformClient` double — no network involved.
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

  it("meta.promote_preview's JSON Schema requires tenantSlug and app, but not entity/templateKey/target", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.promote_preview");
      const schema = tool.inputSchema as { required?: readonly string[] };
      expect(schema.required ?? []).toEqual(expect.arrayContaining(["tenantSlug", "app"]));
      expect(schema.required ?? []).not.toContain("entity");
      expect(schema.required ?? []).not.toContain("templateKey");
      expect(schema.required ?? []).not.toContain("target");
    } finally {
      await client.close();
    }
  });

  it("meta.promote's acknowledgedDependents stays optional at the schema level (only conditionally required, checked at runtime)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.promote");
      const schema = tool.inputSchema as { required?: readonly string[] };
      expect(schema.required ?? []).not.toContain("acknowledgedDependents");
    } finally {
      await client.close();
    }
  });
});

describe("meta.promote_preview / meta.promote — exactly one of entity/templateKey (LAB-272 T063)", () => {
  it("meta.promote_preview rejects a call giving BOTH entity and templateKey", async () => {
    const client = makeFakeClient({});
    await expect(
      promotePreviewTool.handler(makeContext(client), {
        tenantSlug: "acme",
        app: "intellhouse",
        entity: "contacts",
        templateKey: "base-crm",
      }),
    ).rejects.toThrow(/at most one of entity/i);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("meta.promote rejects a call giving BOTH entity and templateKey", async () => {
    const client = makeFakeClient({});
    await expect(
      promoteTool.handler(makeContext(client), {
        tenantSlug: "acme",
        app: "intellhouse",
        entity: "contacts",
        templateKey: "base-crm",
        expectedTargetVersion: 3,
      }),
    ).rejects.toThrow(/at most one of entity/i);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("meta.promote_preview accepts neither entity nor templateKey (whole-app promotion)", async () => {
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
});

describe("meta.promote — acknowledgedDependents required when templateKey is given (LAB-272 T063)", () => {
  it("rejects a templateKey call without acknowledgedDependents", async () => {
    const client = makeFakeClient({});
    await expect(
      promoteTool.handler(makeContext(client), {
        tenantSlug: "acme",
        app: "intellhouse",
        templateKey: "base-crm",
        expectedTargetVersion: 2,
      }),
    ).rejects.toThrow(/acknowledgedDependents/);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("succeeds a templateKey call WITH acknowledgedDependents, forwarding it verbatim alongside expectedTargetVersion (null included) and changeSource: mcp", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote": (body) => {
        expect(body).toMatchObject({
          target: "prod",
          tenantSlug: "acme",
          appName: "intellhouse",
          templateKey: "base-crm",
          expectedTargetVersion: null,
          acknowledgedDependents: 5,
          changeSource: "mcp",
        });
        return { targetVersion: 1, unknownComponents: [], actor: "agent:mcp" };
      },
    });
    const result = await promoteTool.handler(makeContext(client), {
      tenantSlug: "acme",
      app: "intellhouse",
      templateKey: "base-crm",
      expectedTargetVersion: null,
      acknowledgedDependents: 5,
    });
    expect(result).toEqual({ targetVersion: 1, unknownComponents: [], actor: "agent:mcp" });
  });

  it("does not require acknowledgedDependents for an entity promotion", async () => {
    const client = makeFakeClient({
      "/api/v1/meta/promote": (body) => {
        expect(body).not.toHaveProperty("acknowledgedDependents");
        return { targetVersion: 8, unknownComponents: [], actor: "agent:mcp" };
      },
    });
    const result = await promoteTool.handler(makeContext(client), {
      tenantSlug: "acme",
      app: "intellhouse",
      entity: "contacts",
      expectedTargetVersion: 7,
    });
    expect(result).toEqual({ targetVersion: 8, unknownComponents: [], actor: "agent:mcp" });
  });
});
