import { describe, expect, it } from "vitest";
import { createTestProfile } from "../src/profiles/index.js";
import { buildToolRegistry } from "../src/server.js";
import { createToolRegistry, type ToolDefinition } from "../src/tools/registry.js";
import * as readTools from "../src/tools/meta/read.js";
import * as inspectTools from "../src/tools/meta/inspect.js";
import * as writeTools from "../src/tools/meta/write.js";
import * as appTools from "../src/tools/meta/app.js";
import * as templateTools from "../src/tools/meta/templates.js";
import * as historyTools from "../src/tools/meta/history.js";
import * as inventoryTools from "../src/tools/meta/inventory.js";

/**
 * LAB-257 T162 — every write tool must register through `registerWriteTool`,
 * every other tool through `registerReadTool`. `test/profiles.test.ts`
 * (T048) proves this BEHAVIORALLY for four named tools by driving a real
 * `tools/list` against both profiles — but a black-box run of `tools/list`
 * cannot tell "registered via `registerWriteTool` because the profile is
 * write-capable" apart from "registered via `registerReadTool` by mistake,
 * and happens to be present on this particular profile too": both produce
 * an identical list for whatever tools exist today. `meta.rollback` (T055)
 * IS exactly that gap made real — a fifth write tool that landed after
 * `test/profiles.test.ts`'s `WRITE_TOOL_NAMES` was written, so that list is
 * now stale by one and nothing caught it.
 *
 * WHAT COUNTS AS GROUND TRUTH, AND WHAT DOESN'T. The first version of this
 * file tried to infer "is this a write tool" by spying on which
 * `PlatformClient` method a tool's handler called — `.get()` vs `.write()`.
 * That is WRONG: `meta.validate` calls `client.write()` at the transport
 * level (POSTing a body is the only way to send `config` for validation)
 * while persisting nothing — the platform's own handler carries no
 * permission gate a real write would (`meta-schema-api.ts`). Which client
 * method a tool happens to call is an artifact of HTTP method choice, not
 * evidence of mutation. So `ToolDefinition` now carries an explicit `kind:
 * "read" | "write"` field, declared BY each tool next to its own
 * definition (`registry.ts`'s `ToolKind` doc comment records this
 * reasoning) — THAT is the ground truth this file checks against, and
 * `createToolRegistry`'s `registerReadTool`/`registerWriteTool` now assert
 * a tool's declared `kind` matches the call it was routed through, so a
 * misrouted tool fails immediately at server assembly, not only in this
 * test.
 *
 * This file adds two more* things a self-declared `kind` alone would not
 * catch:
 *   1. that `server.ts`'s actual assembly (`buildToolRegistry`, the exact
 *      function `createSimplxMcpServer` uses) routes every tool it knows
 *      about into a call matching that tool's own `kind` — proven by
 *      reading `listWithProvenance()`, which records which registration
 *      method actually admitted each entry, not by re-deriving what
 *      "should" have happened;
 *   2. that the registry's own runtime guard actually refuses a
 *      mismatched pairing, proven by DRIVING it into that state directly
 *      (see the second describe block) rather than trusting the guard
 *      exists because the source says so.
 *
 * *A third property, `test/profiles.test.ts` already covers and this file
 * does not repeat: that a write tool is truly ABSENT from the prod
 * profile's tool list, not merely refused if called.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { name?: unknown }).name === "string" &&
  typeof (value as { kind?: unknown }).kind === "string" &&
  typeof (value as { handler?: unknown }).handler === "function";

/** Every `ToolDefinition` a module exports, found generically — no name
 * list to keep in sync with what the module exports; a new tool added to
 * any of these files is picked up automatically as long as it declares
 * `kind`, which `tsc` already requires of it. */
const collectTools = (mod: Record<string, unknown>): readonly ToolDefinition[] =>
  Object.values(mod).filter(isToolDefinition);

const ALL_MODULES: Record<string, Record<string, unknown>> = {
  "read.ts": readTools,
  "inspect.ts": inspectTools,
  "write.ts": writeTools,
  "app.ts": appTools,
  "templates.ts": templateTools,
  "history.ts": historyTools,
  "inventory.ts": inventoryTools,
};

describe("every write tool registers through registerWriteTool, every other tool through registerReadTool — LAB-257 T162", () => {
  it("the real assembly (buildToolRegistry) routes every known tool to a registration call matching its own declared kind", () => {
    const registry = buildToolRegistry(createTestProfile(CONNECTION));
    const provenanceByName = new Map(registry.listWithProvenance().map((entry) => [entry.tool.name, entry.registeredAs]));

    const allTools = Object.entries(ALL_MODULES).flatMap(([file, mod]) =>
      collectTools(mod).map((tool) => ({ file, tool })),
    );
    // Sanity floor — if module resolution silently found nothing, every
    // assertion below would vacuously pass.
    expect(allTools.length).toBeGreaterThanOrEqual(13);

    for (const { file, tool } of allTools) {
      const actualProvenance = provenanceByName.get(tool.name);
      expect(actualProvenance, `${tool.name} (from ${file}) is not registered in the assembly at all`).toBeDefined();
      expect(
        actualProvenance,
        `${tool.name} (from ${file}) declares kind "${tool.kind}" but the assembly registered it as "${actualProvenance}"`,
      ).toBe(tool.kind);
    }
  });

  it("the registry holds nothing beyond what the seven tool modules export — no orphaned or duplicated registration", () => {
    const registry = buildToolRegistry(createTestProfile(CONNECTION));
    const registeredNames = new Set(registry.listWithProvenance().map((entry) => entry.tool.name));

    const exportedNames = new Set(
      Object.values(ALL_MODULES)
        .flatMap((mod) => collectTools(mod))
        .map((tool) => tool.name),
    );

    expect(registeredNames).toEqual(exportedNames);
  });
});

describe("the registration guard itself actually refuses a mismatched pairing — LAB-257 T162", () => {
  it("registerReadTool REFUSES a tool declaring kind \"write\" — proven by driving it into that state, not by reading the source and trusting it", () => {
    const registry = createToolRegistry();
    const misclassifiedWriteTool: ToolDefinition = {
      name: "meta.would_be_a_write_tool",
      description: "a write-shaped tool someone routed through the read call by mistake",
      kind: "write",
      inputSchema: {},
      handler: async () => undefined,
    };

    expect(() => registry.registerReadTool(misclassifiedWriteTool)).toThrow(/kind "write"/);
    // The refusal must be total — nothing half-registered.
    expect(registry.get("meta.would_be_a_write_tool")).toBeUndefined();
  });

  it("registerWriteTool REFUSES a tool declaring kind \"read\" — the mirror mistake", () => {
    const registry = createToolRegistry();
    const testProfile = createTestProfile(CONNECTION);
    const misclassifiedReadTool: ToolDefinition = {
      name: "meta.would_be_a_read_tool",
      description: "a read-shaped tool someone routed through the write call by mistake",
      kind: "read",
      inputSchema: {},
      handler: async () => undefined,
    };

    expect(() => registry.registerWriteTool(testProfile, misclassifiedReadTool)).toThrow(/kind "read"/);
    expect(registry.get("meta.would_be_a_read_tool")).toBeUndefined();
  });
});
