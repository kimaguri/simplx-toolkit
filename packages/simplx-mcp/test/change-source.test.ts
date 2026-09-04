import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
import { deleteEntityTool, writeEntityTool } from "../src/tools/meta/write.js";
import { writeAppTool } from "../src/tools/meta/app.js";
import { writeTemplateTool } from "../src/tools/meta/templates.js";
import { rollbackTool } from "../src/tools/meta/history.js";
import { validateTool } from "../src/tools/meta/inspect.js";

/**
 * LAB-257 T226 — **КРИТИЧНО**. Every write/delete/rollback tool must
 * identify itself to the platform as `changeSource: "mcp"` in the
 * OUTGOING HTTP request body. Without it, the platform defaults to
 * `changeSource ?? 'admin_ui'` (`meta-entities-api.ts`, `meta-apps-api.ts`,
 * `meta-templates-api.ts`), which means:
 *
 *   - every agent write is recorded in `meta_versions` as a HUMAN edit
 *     (FR-045, FR-006 broken), and
 *   - `assertAgentWriteNotInProduction` (`meta-access.ts`) never fires,
 *     because it gates on `createdBy` being the automatic actor, which
 *     `resolveChangeAuthor` only produces for `changeSource: 'mcp'`
 *     (FR-033, R9, SC-012) — the server-side production write refusal is
 *     silently dead for the real agent.
 *
 * This is deliberately NOT a test of handler arguments or of
 * `resolveChangeAuthor` (that's the platform's own
 * `meta-write-prod-guard-threading.test.ts`, which supplies
 * `changeSource: 'mcp'` itself and proves nothing about who sends it).
 * This file asserts on the body the fake `PlatformClient.write()`
 * actually receives — the one place a tool could silently omit the field
 * despite every unit test of "does the platform accept mcp" passing.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const makeContext = (client: PlatformClient): ToolContext => ({
  profile: createTestProfile(CONNECTION),
  client,
});

/** Captures the body of every `write()` call the tool under test issues,
 * regardless of path — this file cares about EVERY outgoing write body
 * carrying (or not carrying) `changeSource`, not about routing. */
const makeCapturingClient = (result: unknown): { client: PlatformClient; bodies: unknown[] } => {
  const bodies: unknown[] = [];
  const write = vi.fn(async (_path: string, body: unknown) => {
    bodies.push(body);
    return result;
  });
  const get = vi.fn(async () => {
    throw new Error("fake platform client: unexpected GET in a write-tool test");
  });
  const request = vi.fn(async (options: { method?: string; path: string; body?: unknown }) => {
    if (options.method && options.method !== "GET") {
      bodies.push(options.body);
      return result;
    }
    throw new Error("fake platform client: unexpected GET in a write-tool test");
  });
  return { client: { get, write, request } as unknown as PlatformClient, bodies };
};

describe("LAB-257 T226 — write/delete/rollback tools send changeSource: 'mcp'", () => {
  it("meta.write_entity", async () => {
    const { client, bodies } = makeCapturingClient({ version: 2, entityName: "contacts", unknownComponents: [] });
    await writeEntityTool.handler(makeContext(client), {
      tenant: "acme",
      app: "intellhouse",
      entity: "contacts",
      config: { entityName: "contacts" },
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.delete_entity", async () => {
    const { client, bodies } = makeCapturingClient({ entityName: "contacts", deleted: true });
    await deleteEntityTool.handler(makeContext(client), {
      tenant: "acme",
      app: "intellhouse",
      entity: "contacts",
      expectedVersion: 3,
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.write_app", async () => {
    const { client, bodies } = makeCapturingClient({ version: 2, appName: "intellhouse", unknownComponents: [] });
    await writeAppTool.handler(makeContext(client), {
      tenant: "acme",
      app: "intellhouse",
      config: { menu: [] },
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.write_template", async () => {
    const { client, bodies } = makeCapturingClient({ version: 2 });
    await writeTemplateTool.handler(makeContext(client), {
      templateKey: "contacts",
      config: { fields: {} },
      acknowledgedDependents: 0,
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.rollback — entity path", async () => {
    const { client, bodies } = makeCapturingClient({ newVersion: 4, unknownComponents: [] });
    await rollbackTool.handler(makeContext(client), {
      tenant: "acme",
      app: "intellhouse",
      entity: "contacts",
      targetVersionId: "v-1",
      expectedVersion: 3,
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.rollback — app path (entity omitted)", async () => {
    const { client, bodies } = makeCapturingClient({ newVersion: 4, unknownComponents: [] });
    await rollbackTool.handler(makeContext(client), {
      tenant: "acme",
      app: "intellhouse",
      targetVersionId: "v-1",
      expectedVersion: 3,
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });

  it("meta.rollback — template path", async () => {
    const { client, bodies } = makeCapturingClient({ newVersion: 4, unknownComponents: [] });
    await rollbackTool.handler(makeContext(client), {
      templateKey: "contacts",
      targetVersionId: "v-1",
      expectedVersion: 3,
      acknowledgedDependents: 2,
    });
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as any).changeSource).toBe("mcp");
  });
});

describe("LAB-257 T226 — read (and check-only) tools never send changeSource", () => {
  it("meta.validate — POSTs via client.write() but is a check, not a write; must not carry changeSource", async () => {
    const { client, bodies } = makeCapturingClient({ valid: true, mode: "warn", wouldBlock: false, errors: [], unknownComponents: [] });
    await validateTool.handler(makeContext(client), { config: { entityName: "contacts" } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("changeSource");
  });
});
