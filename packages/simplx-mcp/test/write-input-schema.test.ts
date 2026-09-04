import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";

/**
 * LAB-257 T241 — the JSON Schema `tools/list` hands the calling agent for
 * the three write tools whose body carries `expectedVersion` must tell the
 * agent BEFORE it calls the tool what T227 (platform) now enforces AFTER:
 *
 *  - `meta.write_template`: `expectedVersion` is ALWAYS required (templates
 *    have no creation path — `writeTemplateMeta` throws `not_found` first).
 *    This must be reflected in the SCHEMA itself (a call omitting it is
 *    rejected by the MCP SDK's own Zod validation, not merely refused by
 *    the platform over the wire) — not just documented in prose.
 *
 *  - `meta.write_entity` / `meta.write_app`: `expectedVersion` stays
 *    optional (creation legitimately omits it), but the generated JSON
 *    Schema's `description` for that field must say plainly that it is
 *    required for an existing record, name where to get the value from,
 *    and name both `app_code`s the platform can send back
 *    (`meta_expected_version_required` / `meta_expected_version_not_allowed`).
 *
 * This connects a REAL `@modelcontextprotocol/sdk` `Client` to the server
 * over `InMemoryTransport` and reads the actual `tools/list` response —
 * the exact JSON Schema an agent talking to this server would see — rather
 * than reaching into `ToolDefinition.inputSchema` (a Zod shape, not JSON
 * Schema) or any other internal. Same pattern as `test/profiles.test.ts`.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const connectClient = async () => {
  const server = createSimplxMcpServer({ profile: createTestProfile(CONNECTION) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t241-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const findTool = (tools: readonly { name: string; inputSchema?: unknown }[], name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not found in tools/list`);
  return tool;
};

describe("write tool input schemas surface expectedVersion's real requirement — LAB-257 T241", () => {
  it("meta.write_template's JSON Schema lists expectedVersion as REQUIRED (no legitimate omission — templates have no creation path)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.write_template");
      const schema = tool.inputSchema as { required?: readonly string[]; properties?: Record<string, unknown> };

      expect(schema.required ?? []).toContain("expectedVersion");
    } finally {
      await client.close();
    }
  });

  it("meta.write_entity's and meta.write_app's JSON Schemas still allow omitting expectedVersion (creation case)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const name of ["meta.write_entity", "meta.write_app"]) {
        const tool = findTool(tools, name);
        const schema = tool.inputSchema as { required?: readonly string[] };
        expect(schema.required ?? []).not.toContain("expectedVersion");
      }
    } finally {
      await client.close();
    }
  });

  it("meta.write_entity's and meta.write_app's expectedVersion description states the existing-record requirement and BOTH app_codes (creation exists for these two, so both directions of the check are reachable)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const name of ["meta.write_entity", "meta.write_app"]) {
        const tool = findTool(tools, name);
        const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
        const description = schema.properties?.expectedVersion?.description ?? "";

        expect(description.length).toBeGreaterThan(0);
        expect(description).toMatch(/required/i);
        expect(description).toContain("meta_expected_version_required");
        expect(description).toContain("meta_expected_version_not_allowed");
      }
    } finally {
      await client.close();
    }
  });

  it("meta.write_template's expectedVersion description states it is always required (no creation path, so meta_expected_version_not_allowed can never apply here)", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = findTool(tools, "meta.write_template");
      const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
      const description = schema.properties?.expectedVersion?.description ?? "";

      expect(description.length).toBeGreaterThan(0);
      expect(description).toMatch(/always required/i);
      expect(description).toContain("meta_expected_version_required");
    } finally {
      await client.close();
    }
  });

  it("meta.write_entity's description points at meta.get_entity, and meta.write_app's at meta.get_app, as the source of the version to pass", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const entityTool = findTool(tools, "meta.write_entity");
      const appTool = findTool(tools, "meta.write_app");
      const entitySchema = entityTool.inputSchema as { properties?: Record<string, { description?: string }> };
      const appSchema = appTool.inputSchema as { properties?: Record<string, { description?: string }> };

      expect(entitySchema.properties?.expectedVersion?.description ?? "").toContain("meta.get_entity");
      expect(appSchema.properties?.expectedVersion?.description ?? "").toContain("meta.get_app");
    } finally {
      await client.close();
    }
  });
});
