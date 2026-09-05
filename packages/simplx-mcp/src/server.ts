import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS, registerKnowledge } from "./knowledge/index.js";
import { createPlatformClient, PlatformApiError } from "./client/index.js";
import type { Profile } from "./profiles/index.js";
import { createToolRegistry, type ToolContext, type ToolDefinition, type ToolRegistry } from "./tools/index.js";
import {
  getSchemaTool,
  listAppsTool,
  getEntityTool,
  diffTool,
  validateTool,
  writeEntityTool,
  deleteEntityTool,
  getAppTool,
  writeAppTool,
  listTemplatesTool,
  getTemplateTool,
  templateDependentsTool,
  writeTemplateTool,
  versionsTool,
  rollbackTool,
  inventoryTool,
  promotePreviewTool,
  promoteTool,
} from "./tools/meta/index.js";

export interface SimplxMcpServerOptions {
  readonly profile: Profile;
}

/** Wires one {@link ToolDefinition} into the MCP server, resolving it
 * against the fixed {@link ToolContext} for this server instance. The
 * tool's own return value becomes the result's text content verbatim
 * (`JSON.stringify`) — this layer does not reshape it either.
 *
 * LAB-257 T243: there is no permissive any-object fallback here anymore.
 * Every tool declares its own `inputSchema` (a Zod raw shape,
 * `ToolDefinition`'s required field) — the MCP SDK turns it into the JSON
 * Schema the calling agent reads BEFORE invoking the tool, including
 * per-field `required`-ness and `.describe()` text. A tool with no schema
 * cannot reach this function at all: `buildToolRegistry`'s
 * `registerReadTool`/`registerWriteTool` (`tools/registry.ts`) both refuse
 * to admit one, so the failure surfaces at server assembly, naming the
 * tool, not here as a silent `undefined`. */
const registerWithServer = (server: McpServer, context: ToolContext, tool: ToolDefinition): void => {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (args: unknown) => {
      try {
        const result = await tool.handler(context, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error: unknown) {
        // LAB-257 T254: a platform refusal reaches the agent as an isError
        // result carrying the platform's OWN envelope — `code`, `message`,
        // `details` (version_conflict's currentVersion, rule-violation
        // locations, acknowledgedDependents mismatch) and HTTP `status` —
        // instead of the SDK's default, which keeps `message` alone and
        // drops everything the agent needs to branch on or retry with
        // (contracts/meta-write-api.md, "расхождение версии (с текущей
        // версией в ответе)"). Anything that is not a platform response
        // (network failure, a bug) is rethrown unchanged.
        if (error instanceof PlatformApiError) {
          const envelope = {
            code: error.code,
            message: error.message,
            details: error.details,
            status: error.status,
          };
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
        }
        throw error;
      }
    },
  );
};

/**
 * Builds the MCP server for a given profile (T056) — the assembly point
 * every earlier tool task (T052-T090) has been building toward. Wires the
 * platform client, builds the tool registry, and registers every tool this
 * package currently has:
 *
 *   read.ts:      meta.get_schema, meta.list_apps, meta.get_entity
 *   inspect.ts:   meta.diff, meta.validate
 *   app.ts:       meta.get_app (read), meta.write_app (write)
 *   templates.ts: meta.list_templates, meta.get_template,
 *                 meta.template_dependents (read), meta.write_template (write)
 *   write.ts:     meta.write_entity, meta.delete_entity (write)
 *   history.ts:   meta.versions (read), meta.rollback (write) — T055,
 *                 unblocked once T167/T168 (platform-side rollback
 *                 version-check + tenant/app/entity addressing) landed;
 *                 T203 extended both to cover templates too, addressed by
 *                 `templateKey` alone, once the platform grew a history/
 *                 rollback handler for them (T175).
 *   inventory.ts: meta.inventory (read) — T210, a full on-demand scan of
 *                 every active meta row across every tenant against the
 *                 published rules (T209's `GET /api/v1/meta/inventory`).
 *   promote.ts:   meta.promote_preview, meta.promote (both "write" —
 *                 LAB-272 T063) — promoting an app/entity/template from
 *                 test to prod, test-profile only; addresses tenants by
 *                 slug, unlike every other tool here.
 *
 * THE WRITE BOUNDARY IS STRUCTURAL, NOT A NAME CHECK. `"write" in profile`
 * narrows the `Profile` union (`ProdProfile | TestProfile`) to
 * `TestProfile` — the ONLY member carrying `WriteCapability` — which is
 * exactly what `ToolRegistry.registerWriteTool`'s own parameter type
 * (`WriteCapableProfile = Extract<Profile, { write: WriteCapability }>`)
 * requires to compile. A `ProdProfile` reaching the `registerWriteTool`
 * calls below would fail `tsc`, not merely fail an `if (profile.name ===
 * "prod")` runtime check that a later rename could silently defeat — this
 * is why `test/profiles.test.ts` (T048's runtime half) asserts against a
 * REAL `tools/list` response rather than this module's internals: a write
 * tool that is never added to the registry is never handed to
 * `McpServer.registerTool`, so it is not merely refused if called, it does
 * not appear in the list an agent sees at all (the exact distinction that
 * test's header states).
 */
export const createSimplxMcpServer = (options: SimplxMcpServerOptions): McpServer => {
  const { profile } = options;
  const client = createPlatformClient(profile);
  const registry = buildToolRegistry(profile);
  const context: ToolContext = { profile, client };

  // LAB-257 T259: the server carries its own operating rules — every
  // client receives `instructions` at initialize — plus the reference as
  // resources/prompts (`./knowledge`). The knowledge travels and versions
  // with the server; no client-side skill file is required for it.
  const server = new McpServer(
    {
      name: "simplx-mcp",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of registry.list()) {
    registerWithServer(server, context, tool);
  }
  registerKnowledge(server);

  return server;
};

/**
 * Builds the tool registry for a given profile — the actual assembly
 * decision `createSimplxMcpServer` wires into the MCP server, pulled out
 * as its own function so it can be inspected directly (LAB-257 T162,
 * `test/tool-registration.test.ts`): the registry's own
 * `listWithProvenance()` records which registration method actually
 * admitted each tool, a distinction a black-box `tools/list` run cannot
 * make (both methods insert into the same underlying map). Calling THIS
 * function, rather than re-deriving an expected registration list in the
 * test, is what keeps the check bound to the real assembly logic instead
 * of a second, driftable copy of it.
 */
export const buildToolRegistry = (profile: Profile): ToolRegistry => {
  const registry = createToolRegistry();

  registry.registerReadTool(getSchemaTool);
  registry.registerReadTool(listAppsTool);
  registry.registerReadTool(getEntityTool);
  registry.registerReadTool(diffTool);
  registry.registerReadTool(validateTool);
  registry.registerReadTool(getAppTool);
  registry.registerReadTool(listTemplatesTool);
  registry.registerReadTool(getTemplateTool);
  registry.registerReadTool(templateDependentsTool);
  registry.registerReadTool(versionsTool);
  registry.registerReadTool(inventoryTool);

  if ("write" in profile) {
    registry.registerWriteTool(profile, writeEntityTool);
    registry.registerWriteTool(profile, deleteEntityTool);
    registry.registerWriteTool(profile, writeAppTool);
    registry.registerWriteTool(profile, writeTemplateTool);
    registry.registerWriteTool(profile, rollbackTool);
    registry.registerWriteTool(profile, promotePreviewTool);
    registry.registerWriteTool(profile, promoteTool);
  }

  return registry;
};
