import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";
import type { Profile } from "../src/profiles/index.js";

/**
 * LAB-257 T048, half 2/2 — the RUNTIME half.
 *
 * The exact claim under test is NOT "the write tool refuses on prod" (that
 * server-side redundancy is T044/T049, already green on the platform and
 * out of scope here) — it is "on the prod profile, the write tools are not
 * OFFERED at all". A tool that exists and refuses still shows up in the
 * agent's tool list, and an agent that sees a tool will eventually try it
 * and treat the refusal as an obstacle, not a boundary. A tool that is
 * never listed cannot be attempted.
 *
 * Types vanish at runtime — `test/profiles.type-test.ts` and
 * `test/write-tools-prod-gating.type-test.ts` (T048 half 1) prove
 * `registerWriteTool` cannot compile against a `ProdProfile`, but the tool
 * list actually handed to the model is a RUNTIME value produced by
 * whatever assembly code wires tools into the server (T056). A loop that
 * assembles that list incorrectly is a runtime bug no compile-time proof
 * catches.
 *
 * So this file goes through the REAL MCP protocol boundary instead of
 * reaching into `McpServer`'s private internals (`_registeredTools` is not
 * public API and this package does not depend on its shape): it connects
 * an actual `@modelcontextprotocol/sdk` `Client` to the server produced by
 * `createSimplxMcpServer` — the package's one real, already-exported,
 * fixed-signature entry point — over `InMemoryTransport` (the SDK's own
 * same-process pair, built for exactly this kind of test) and calls the
 * real `tools/list` request. This is what "the tool list handed to the
 * model" concretely means.
 *
 * `createSimplxMcpServer` currently registers no tools at all (T045-T057
 * land the actual tools) — so today `listTools()` returns nothing (or the
 * connection may reject if no tools capability is advertised yet), and
 * every assertion below fails. That is the correct RED: this file does not
 * import a nonexistent module, so `tsc --noEmit` reports nothing about it,
 * but the runtime assertions are the ones expected to fail until T056 (and
 * the individual tool tasks) wire the real tools in — see the run output
 * quoted in the T048 report for the actual failure text.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

/** The five write tools named in contracts/mcp-tools.md — the exact set
 * that must never appear on the prod profile.
 *
 * DELIBERATELY HARDCODED, not derived from each tool's own `kind` field
 * (LAB-257 T162, `tools/registry.ts`'s `ToolKind`). This list going stale
 * by one (`meta.rollback`, T055, landed after this list was written) is
 * exactly what motivated T162 — but the fix there is a DIFFERENT, source-
 * level check (`test/tool-registration.test.ts`), not converting this
 * list into `Object.values(historyTools).filter(t => t.kind === "write")`.
 * A list derived from `kind` could only prove "the profiles behave
 * consistently with whatever `kind` values exist today" — it would agree
 * with itself even if a tool's own `kind` were WRONG (declared "read" for
 * something that should gate, or vice versa), because both sides of the
 * comparison would come from the same field. This list is independent of
 * that field on purpose: it is the contract's own enumeration, so it
 * catches an accidental ADDITION to write-capability (a tool that should
 * stay ungated suddenly appearing here) exactly as well as an omission —
 * a self-referential list could do neither. Keep it in sync with the
 * contract by hand; `test/tool-registration.test.ts` is what catches a
 * NEW write tool being wired through the wrong registration call. */
const WRITE_TOOL_NAMES = [
  "meta.write_entity",
  "meta.delete_entity",
  "meta.write_app",
  "meta.write_template",
  "meta.rollback",
  // LAB-272 T063: promotion is test-profile-only, gated through the same
  // registerWriteTool mechanism as every write tool above, even though
  // meta.promote_preview itself mutates nothing — see promote.ts's header
  // comment for why kind: "write" is the correct self-declaration here.
  "meta.promote_preview",
  "meta.promote",
];

/** A representative slice of the read/inspect tools (contracts/mcp-tools.md)
 * that must be present on BOTH profiles — reads are never profile-gated. */
const READ_AND_INSPECT_TOOL_NAMES = ["meta.get_schema", "meta.list_apps", "meta.get_entity", "meta.diff", "meta.validate"];

/**
 * Connects a real MCP `Client` to the server built for `profile` over an
 * in-memory transport pair and returns the tool names `tools/list` reports
 * — i.e. exactly what an agent talking to this server for this profile
 * would see, not an internal data structure this test reaches into.
 */
const listToolNamesFor = async (profile: Profile): Promise<string[]> => {
  const server = createSimplxMcpServer({ profile });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t048-test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
};

describe("prod profile exposes no write tools — LAB-257 T048 (runtime)", () => {
  it("the TEST profile's tool list includes every write tool (writes are only unavailable on prod, not removed altogether)", async () => {
    const names = await listToolNamesFor(createTestProfile(CONNECTION));

    for (const writeName of WRITE_TOOL_NAMES) {
      expect(names).toContain(writeName);
    }
  });

  it("the PROD profile's tool list contains NONE of the four write tools", async () => {
    const names = await listToolNamesFor(createProdProfile(CONNECTION));

    for (const writeName of WRITE_TOOL_NAMES) {
      expect(names).not.toContain(writeName);
    }
  });

  it("the PROD profile's tool list still contains the read and inspect tools — asserting PRESENCE, not just the writers' absence (a bug that empties the whole list must not pass)", async () => {
    const names = await listToolNamesFor(createProdProfile(CONNECTION));

    for (const readOrInspectName of READ_AND_INSPECT_TOOL_NAMES) {
      expect(names).toContain(readOrInspectName);
    }
    expect(names.length).toBeGreaterThanOrEqual(READ_AND_INSPECT_TOOL_NAMES.length);
  });

  it("the TEST profile genuinely offers strictly more tools than PROD — a sanity cross-check against both lists collapsing to the same (possibly empty) set", async () => {
    const [testNames, prodNames] = await Promise.all([
      listToolNamesFor(createTestProfile(CONNECTION)),
      listToolNamesFor(createProdProfile(CONNECTION)),
    ]);

    expect(testNames.length).toBeGreaterThan(prodNames.length);
    expect(prodNames.length).toBeGreaterThan(0);
  });
});
