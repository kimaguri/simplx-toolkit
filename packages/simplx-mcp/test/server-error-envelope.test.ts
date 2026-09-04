import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestProfile } from "../src/profiles/index.js";
import { createSimplxMcpServer } from "../src/server.js";

/**
 * LAB-257 T254 — a platform refusal must reach the agent WITH the platform's
 * own `code` and `details`, not as a bare message.
 *
 * Found by T117 on the test stand: `meta.write_entity` with a stale
 * `expectedVersion` came back as the text "База ушла вперёд, перечитайте
 * описание" and nothing else — the `version_conflict` code and
 * `details.params.currentVersion` (contracts/meta-write-api.md: "расхождение
 * версии (с текущей версией в ответе)") were dropped on the way, because a
 * thrown `PlatformApiError` was serialized by the SDK as `message` only. The
 * agent then has no version to retry with and no code to branch on.
 *
 * Exercised end to end through a real MCP client over an in-memory
 * transport, with `fetch` stubbed to answer as the platform would.
 */
const connection = { baseUrl: "https://platform.example", tenantSlug: "acme", bearerToken: "t" };

const connect = async () => {
  const server = createSimplxMcpServer({ profile: createTestProfile(connection) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
};

afterEach(() => vi.unstubAllGlobals());

describe("platform error envelope through MCP (LAB-257 T254)", () => {
  it("forwards code, message, details and status of a platform refusal as an isError result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: "failed_precondition",
            message: "База ушла вперёд, перечитайте описание",
            details: { app_code: "version_conflict", params: { currentVersion: 149, expectedVersion: 1 } },
          }),
          { status: 412, statusText: "Precondition Failed", headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = await connect();
    const result = await client.callTool({
      name: "meta.write_entity",
      arguments: { tenant: "t", app: "a", entity: "e", expectedVersion: 1, config: {} },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      code: "failed_precondition",
      message: "База ушла вперёд, перечитайте описание",
      status: 412,
      details: { app_code: "version_conflict", params: { currentVersion: 149 } },
    });
  });

  it("still returns a successful tool result untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { templates: [] } }), { status: 200 })),
    );
    const client = await connect();
    const result = await client.callTool({ name: "meta.list_templates", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(JSON.parse(text)).toEqual({ templates: [] });
  });
});
