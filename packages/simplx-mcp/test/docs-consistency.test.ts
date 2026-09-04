import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";

/**
 * LAB-257 T244 — a guide is code a human runs by hand: a stale tool table
 * costs someone an afternoon just as surely as a stale type signature costs
 * a build. `docs/simplx-mcp.md`'s "What the sixteen tools cover" table is
 * the one place the guide enumerates every tool by name; this test pins it
 * against the REAL `tools/list` response (the same runtime boundary
 * `test/profiles.test.ts` uses — a real MCP `Client` over `InMemoryTransport`,
 * not `ToolRegistry` internals) so the next tool added, removed, or renamed
 * fails a test instead of silently drifting from what the doc promises.
 *
 * The TEST profile is used because it is the superset (every tool the PROD
 * profile has, plus the five write tools) — the doc table documents all
 * sixteen, gated tools included.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const DOCS_PATH = fileURLToPath(new URL("../../../docs/simplx-mcp.md", import.meta.url));

/** Every `meta.*` tool name named in the guide's "What the sixteen tools
 * cover" markdown table, in table order — parsed from the table's own
 * `| \`meta.x\` | kind | ... |` row shape, not hand-copied. */
const toolNamesFromDocsTable = (): string[] => {
  const markdown = readFileSync(DOCS_PATH, "utf-8");
  const rowPattern = /^\| `(meta\.[a-z_]+)` \| (?:read|write) \|/gm;
  return [...markdown.matchAll(rowPattern)].map((match) => match[1]!);
};

const listRealToolNames = async (): Promise<string[]> => {
  const server = createSimplxMcpServer({ profile: createTestProfile(CONNECTION) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs-consistency-test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
};

describe("docs/simplx-mcp.md tool table matches the real tools/list — LAB-257 T244", () => {
  it("names exactly the set of tools the TEST profile actually registers — no more, no fewer", async () => {
    const documented = toolNamesFromDocsTable();
    const real = await listRealToolNames();

    expect(documented.length).toBeGreaterThan(0);
    expect(new Set(documented)).toEqual(new Set(real));
    // Catches a duplicated row, which the Set comparison alone would hide.
    expect(documented.length).toBe(real.length);
  });
});
