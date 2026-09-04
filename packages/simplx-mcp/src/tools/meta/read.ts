import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * `GET /api/v1/meta/schema` response, forwarded verbatim — see
 * {@link getSchemaTool}. Field shapes are deliberately `unknown`: this
 * package never inspects, validates, or re-derives the rules themselves
 * (R16, R20) — only the platform's generated JSON Schema artifact does.
 */
export interface MetaSchemaPayload {
  readonly manifest: unknown;
  readonly entitySchema: unknown;
  readonly appSchema: unknown;
}

/**
 * `meta.get_schema` — the machine-readable metadata rules and their
 * version. The first call in any meta work: without the rules the agent
 * writes blind.
 *
 * A pure forward of `GET /api/v1/meta/schema` — this tool holds NO local
 * copy of the rules and derives nothing from the response. A second,
 * drifting implementation of the schema is exactly what R16/R20 rule out;
 * this is why the tool exists at all rather than agents rolling their own
 * check.
 */
export const getSchemaTool: ToolDefinition<undefined, MetaSchemaPayload> = {
  name: "meta.get_schema",
  kind: "read",
  description: "Machine-readable metadata rules and their version. Call this first, before any other meta work.",
  // LAB-257 T243: genuinely zero-argument — the handler takes no `args`
  // at all. The empty shape is deliberate, not an omission: it tells the
  // agent "no properties" rather than leaving the field undocumented.
  inputSchema: {},
  handler: async (context) => context.client.get<MetaSchemaPayload>("/api/v1/meta/schema"),
};

/** Input for {@link listAppsTool}. */
export interface ListAppsArgs {
  readonly tenant: string;
}

/** {@link ListAppsArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). */
export const listAppsInputSchema = {
  tenant: z.string().describe(
    "Tenant id to list apps for — the tenant whose meta the agent is working in.",
  ),
} satisfies z.ZodRawShape;

/** One entity's name and current version, as listed under its owning app. */
export interface ListAppsEntitySummary {
  readonly entityName: string;
  readonly version: number;
}

/** One app of the tenant's map: its own version plus its own entities. */
export interface ListAppsAppSummary {
  readonly appName: string;
  readonly version: number;
  readonly entities: readonly ListAppsEntitySummary[];
}

/** `GET /api/v1/meta/apps/tenant/{tenantId}` response, forwarded verbatim. */
export interface ListAppsResult {
  readonly apps: readonly ListAppsAppSummary[];
}

/**
 * `meta.list_apps` — the map by which the agent finds what to edit, before
 * any write. Every app of the tenant, each with its own current version and
 * its own entities' current versions.
 *
 * ONE call: `GET /api/v1/meta/apps/tenant/{tenantId}` (T159,
 * `platform/src/services/tenant-management/meta-apps-api.ts`'s
 * `listTenantApps`) already returns every app together with its entities
 * and their versions in a single response — there is no N-call composition
 * to do here. Note the `/tenant/` path segment: the contract's originally
 * literal `GET /api/v1/meta/apps/{tenantId}` collided with the pre-existing
 * admin route `GET /api/v1/meta/apps/:appId` and was disambiguated on the
 * platform (contract updated accordingly).
 */
export const listAppsTool: ToolDefinition<ListAppsArgs, ListAppsResult> = {
  name: "meta.list_apps",
  kind: "read",
  description: "Every app of a tenant, each with its own version and its entities' current versions.",
  inputSchema: listAppsInputSchema,
  handler: async (context, args) => context.client.get<ListAppsResult>(`/api/v1/meta/apps/tenant/${args.tenant}`),
};

/** Input for {@link getEntityTool}. */
export interface GetEntityArgs {
  readonly tenant: string;
  readonly app: string;
  readonly entity: string;
}

/** {@link GetEntityArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). */
export const getEntityInputSchema = {
  tenant: z.string().describe("Tenant id, as returned by meta.list_apps."),
  app: z.string().describe("App name, as returned by meta.list_apps."),
  entity: z.string().describe("Entity name, as listed under this app by meta.list_apps."),
} satisfies z.ZodRawShape;

/**
 * `GET /api/v1/meta/entities/{tenantId}/{appName}/{entityName}` response,
 * forwarded verbatim — see {@link getEntityTool}.
 */
export interface GetEntityResult {
  readonly entityName: string;
  readonly version: number;
  readonly basedOn?: string;
  /** As the renderer/preview would assemble it — template applied,
   * overrides layered on top, internal refs resolved. NEVER what the agent
   * edits. */
  readonly resolved: Record<string, unknown>;
  /** As stored — `basedOn` + `overrides`. What the agent (and the editor)
   * must edit and write back. */
  readonly raw: Record<string, unknown>;
}

/**
 * `meta.get_entity` — the addressed entity description in two views.
 *
 * Both `raw` and `resolved` are forwarded exactly as the platform sent
 * them, never collapsed into one another. The agent is obligated to edit
 * `raw`: writing back `resolved` would flatten inheritance into a
 * standalone copy, turning a templated entity into one that no longer
 * benefits from — or receives — future template changes. That loss is
 * exactly what the `raw`/`resolved` split exists to prevent, so this tool
 * does nothing more than pass the platform's own two fields through.
 */
export const getEntityTool: ToolDefinition<GetEntityArgs, GetEntityResult> = {
  name: "meta.get_entity",
  kind: "read",
  description:
    "An entity's description in two views: raw (what is stored — edit and send THIS back) and resolved (template + overrides assembled, read-only preview of what the screen gets), plus the current version to pass as expectedVersion. A raw config with basedOn holds only the tenant's overrides.",
  inputSchema: getEntityInputSchema,
  handler: async (context, args) =>
    context.client.get<GetEntityResult>(`/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}`),
};
