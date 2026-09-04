import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import type { WriteCapableProfile } from "../src/profiles/types.js";
import { createSimplxMcpServer } from "../src/server.js";
import { createToolRegistry, type ToolDefinition } from "../src/tools/registry.js";

/**
 * LAB-257 T243 — until this task, 13 of the 16 MCP tools fell back to
 * `server.ts`'s `ANY_ARGS_SCHEMA` (T241's doc comment named it: "every
 * other tool keeps the permissive any-object fallback it always had"). The
 * agent calling this server — the feature's PRIMARY author — saw a tool
 * name and an untyped bag for every one of them: no parameter names, no
 * types, no description of where a value comes from.
 *
 * Same pattern as `test/write-input-schema.test.ts` (T241): a REAL
 * `@modelcontextprotocol/sdk` `Client` connected to the server over
 * `InMemoryTransport`, reading the actual `tools/list` response — the
 * exact JSON Schema an agent talking to this server sees — never
 * `ToolDefinition.inputSchema` (a Zod shape, not JSON Schema) or any other
 * internal.
 *
 * Covers every tool `write-input-schema.test.ts` does NOT: the three write
 * tools it already checks (`meta.write_entity`, `meta.write_app`,
 * `meta.write_template`) are deliberately absent from `EXPECTATIONS` below.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const connectClient = async () => {
  const server = createSimplxMcpServer({ profile: createTestProfile(CONNECTION) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t243-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

interface JsonSchema {
  readonly properties?: Record<string, { readonly description?: string }>;
  readonly required?: readonly string[];
}

const findToolSchema = (tools: readonly { name: string; inputSchema?: unknown }[], name: string): JsonSchema => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not found in tools/list`);
  return tool.inputSchema as JsonSchema;
};

interface Expectation {
  /** Fields the handler genuinely cannot proceed without. */
  readonly required: readonly string[];
  /** This tool genuinely takes no arguments — `properties` must be empty,
   * not merely undocumented. */
  readonly zeroArgs?: boolean;
}

/** One entry per tool T243 covers — the 13 that fell back to
 * `ANY_ARGS_SCHEMA` before this task. Cross-checked against each
 * handler's own `args.*` reads (`src/tools/meta/*.ts`), not against
 * `contracts/mcp-tools.md` alone, per T243's own instruction: where the
 * two disagree, the handler is what the agent gets. */
const EXPECTATIONS: Readonly<Record<string, Expectation>> = {
  "meta.get_schema": { required: [], zeroArgs: true },
  "meta.list_apps": { required: ["tenant"] },
  "meta.get_entity": { required: ["tenant", "app", "entity"] },
  "meta.get_app": { required: ["tenant", "app"] },
  "meta.get_template": { required: ["templateKey"] },
  "meta.list_templates": { required: [], zeroArgs: true },
  "meta.template_dependents": { required: ["templateKey"] },
  // tenant/app/entity/templateKey are mutually exclusive-ish per
  // history.ts's own doc comments — none is unconditionally required.
  "meta.versions": { required: [] },
  // Only targetVersionId and expectedVersion are unconditionally required
  // by the handler; acknowledgedDependents is required only when
  // templateKey is given, and is checked at runtime, not by the schema
  // (same convention meta.delete_entity's expectedVersion check used
  // before this task, and meta.rollback's own acknowledgedDependents
  // check still uses).
  "meta.rollback": { required: ["targetVersionId", "expectedVersion"] },
  // proposedConfig/config are z.unknown() — same convention the existing
  // write tools' own `config: z.unknown()` field already uses (T241), and
  // zod-to-json-schema does not mark a z.unknown() field required (it
  // structurally accepts `undefined` too). Presence/description is
  // checked below; only the string address fields are asserted required.
  "meta.diff": { required: ["tenant", "app", "entity"] },
  "meta.validate": { required: [] },
  "meta.inventory": { required: [], zeroArgs: true },
  "meta.delete_entity": { required: ["tenant", "app", "entity", "expectedVersion"] },
};

describe("every remaining MCP tool publishes a real input schema — LAB-257 T243", () => {
  it("tools/list's JSON Schema documents parameters (or is genuinely zero-args), every property has a description, and required matches the handler", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const [name, expectation] of Object.entries(EXPECTATIONS)) {
        const schema = findToolSchema(tools, name);
        const propertyNames = Object.keys(schema.properties ?? {});

        if (expectation.zeroArgs) {
          expect(propertyNames.length, `${name} should genuinely take no arguments`).toBe(0);
        } else {
          expect(propertyNames.length, `${name} should document its parameters`).toBeGreaterThan(0);
        }

        for (const prop of propertyNames) {
          expect(
            (schema.properties?.[prop]?.description ?? "").length,
            `${name}.${prop} is missing a description`,
          ).toBeGreaterThan(0);
        }

        const required = schema.required ?? [];
        for (const field of expectation.required) {
          expect(required, `${name} should require "${field}"`).toContain(field);
        }
        for (const field of required) {
          expect(expectation.required, `${name} unexpectedly requires "${field}"`).toContain(field);
        }
      }
    } finally {
      await client.close();
    }
  });

  it("meta.rollback's schema states the three-way (entity / app / template) addressing rule in prose, for every one of tenant/app/entity/templateKey", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const schema = findToolSchema(tools, "meta.rollback");
      for (const field of ["tenant", "app", "entity", "templateKey"]) {
        const description = schema.properties?.[field]?.description ?? "";
        expect(description.length, `meta.rollback.${field} needs a description`).toBeGreaterThan(0);
      }
      // At least one of them must spell out the mutual-exclusivity rule —
      // not merely exist.
      const descriptions = ["tenant", "app", "entity", "templateKey"].map(
        (field) => schema.properties?.[field]?.description ?? "",
      );
      expect(descriptions.some((d) => /templateKey/.test(d) || /template/.test(d))).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("a tool without inputSchema fails registration, never silently falls back to a permissive bag — LAB-257 T243", () => {
  it("registerReadTool throws, naming the tool", () => {
    const registry = createToolRegistry();
    const badTool = {
      name: "meta.__no_schema_read",
      kind: "read",
      description: "test tool with no inputSchema",
      handler: async () => ({}),
    } as unknown as ToolDefinition;

    expect(() => registry.registerReadTool(badTool)).toThrow(/meta\.__no_schema_read/);
  });

  it("registerWriteTool throws, naming the tool", () => {
    const registry = createToolRegistry();
    const badTool = {
      name: "meta.__no_schema_write",
      kind: "write",
      description: "test tool with no inputSchema",
      handler: async () => ({}),
    } as unknown as ToolDefinition;
    const fakeWriteProfile = { write: { __writeCapable: true } } as unknown as WriteCapableProfile;

    expect(() => registry.registerWriteTool(fakeWriteProfile, badTool)).toThrow(/meta\.__no_schema_write/);
  });
});
