import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProdProfile, createTestProfile, type Profile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";
import { META_GUIDE, META_TYPES_REFERENCE, SERVER_INSTRUCTIONS } from "../src/knowledge/index.js";

/**
 * LAB-257 T259 — the server carries its own knowledge: operating rules as
 * `instructions` (every client sees them at initialize), the reference as
 * resources, typical jobs as prompts, and the per-tool semantics inside the
 * tool descriptions. Each layer is checked through a real MCP client, not by
 * reading the source: what matters is what the agent receives.
 */
const connection = { baseUrl: "https://platform.example", tenantSlug: "acme", bearerToken: "t" };

const connect = async (profile: Profile = createTestProfile(connection)) => {
  const server = createSimplxMcpServer({ profile });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
};

const md = (name: string) => readFileSync(fileURLToPath(new URL(`../src/knowledge/${name}`, import.meta.url)), "utf8");

describe("server knowledge (LAB-257 T259)", () => {
  it("delivers operating rules as initialize instructions — the write cycle, navKey/menu rule, whole labels, version conflict handling", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    for (const must of ["meta.get_entity", "meta.validate", "meta.diff", "expectedVersion", "version_conflict", "navKey", "displayName", "labels", "basedOn", "meta.rollback", "simplx://meta/guide"]) {
      expect(instructions).toContain(must);
    }
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("serves the guide and the type reference as markdown resources, identical to the .md sources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["simplx://meta/guide", "simplx://meta/types"]);
    const guide = await client.readResource({ uri: "simplx://meta/guide" });
    const types = await client.readResource({ uri: "simplx://meta/types" });
    expect((guide.contents[0] as { text?: string }).text).toBe(md("guide.md"));
    expect((types.contents[0] as { text?: string }).text).toBe(md("types-reference.md"));
    // The embedded copy must not go stale against the markdown next to it.
    expect(META_GUIDE).toBe(md("guide.md"));
    expect(META_TYPES_REFERENCE).toBe(md("types-reference.md"));
    expect(META_GUIDE).toContain("hideInMenu");
    expect(META_GUIDE).toContain("meta.relation");
  });

  it("offers the three typical jobs as prompts with typed arguments, and renders them", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["meta_add_field", "meta_new_entity_from_template", "meta_rename_entity"]);
    const rename = await client.getPrompt({
      name: "meta_rename_entity",
      arguments: { tenant: "t-1", app: "intellhouse", entity: "contracts", newName: "Соглашения" },
    });
    const text = rename.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");
    expect(text).toContain("contracts");
    expect(text).toContain("navKey");
    expect(text).toContain("WHOLE `constants.labels`");
  });

  it("keeps the knowledge on the prod profile too — reading the rules never needs write tools", async () => {
    const client = await connect(createProdProfile(connection));
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(2);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "meta.write_entity")).toBe(false);
  });

  it("puts the per-tool semantics into the tool descriptions the agent reads at tools/list", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName["meta.write_entity"]).toContain("navKey");
    expect(byName["meta.write_entity"]).toContain("labels");
    expect(byName["meta.write_entity"]).toContain("currentVersion");
    expect(byName["meta.get_entity"]).toContain("raw");
    expect(byName["meta.rollback"]).toContain("meta.versions");
    expect(byName["meta.validate"]).toContain("unknownComponents");
    expect(byName["meta.diff"]).toContain("raw");
  });
});
