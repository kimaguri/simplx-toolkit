import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";

/**
 * LAB-273 T056 — the meta contract adds a `ValueSource` mechanism
 * (`{ valueFrom, dict?, pick? }`, including a `parent.` prefix for nested
 * sections) and a `money` field type with `fieldProps.currency` /
 * `fieldProps.currencyField`. The server's built-in knowledge (the
 * `simplx://meta/guide` and `simplx://meta/types` resources) must document
 * both before an agent can use them correctly. This test reads the
 * resources through the same runtime boundary the agent uses — a real MCP
 * `Client` over `InMemoryTransport`, resources served from `embedded.ts`
 * via `resources.ts` — not the `.md` sources directly.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

const readResource = async (uri: string): Promise<string> => {
  const server = createSimplxMcpServer({ profile: createTestProfile(CONNECTION) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "knowledge-value-source-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.readResource({ uri });
    return (result.contents[0] as { text?: string }).text ?? "";
  } finally {
    await client.close();
  }
};

describe("built-in knowledge documents ValueSource and money (LAB-273)", () => {
  it("guide explains ValueSource, the parent. prefix, and shows a money example with a sibling and a parent. currency", async () => {
    const guide = await readResource("simplx://meta/guide");

    expect(guide).toContain("ValueSource");
    expect(guide).toContain("parent.");
    // money field with currency sourced from a sibling field
    expect(guide).toMatch(/currency:\s*\{\s*valueFrom:\s*['"]currency['"]\s*\}/);
    // money field with currency sourced from the parent record
    expect(guide).toMatch(/valueFrom:\s*['"]parent\.currency['"]/);
    expect(guide.toLowerCase()).toContain("money");
  });

  it("types reference explains ValueSource, the parent. prefix, and shows a money example with a sibling and a parent. currency", async () => {
    const types = await readResource("simplx://meta/types");

    expect(types).toContain("ValueSource");
    expect(types).toContain("parent.");
    expect(types).toMatch(/currency:\s*\{\s*valueFrom:\s*['"]currency['"]\s*\}/);
    expect(types).toMatch(/valueFrom:\s*['"]parent\.currency['"]/);
    expect(types.toLowerCase()).toContain("money");
  });
});
