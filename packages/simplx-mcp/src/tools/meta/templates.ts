import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/** One template's summary, as listed by {@link listTemplatesTool}. */
export interface TemplateSummary {
  readonly templateKey: string;
  readonly displayName: string;
  readonly version: number;
}

/** `GET /api/v1/meta/templates` response, forwarded verbatim. */
export interface ListTemplatesResult {
  readonly templates: readonly TemplateSummary[];
}

/**
 * `meta.list_templates` — every template available to base an entity on.
 *
 * ONE call: `GET /api/v1/meta/templates` (`platform/src/services/tenant-
 * management/meta-templates-api.ts`'s `listTemplates`), forwarded exactly
 * as the platform sent it — no local filtering, no re-derivation. Scoped
 * to active templates server-side; this tool does not repeat that logic.
 */
export const listTemplatesTool: ToolDefinition<undefined, ListTemplatesResult> = {
  name: "meta.list_templates",
  kind: "read",
  description: "Every template available to base an entity on.",
  // LAB-257 T243: genuinely zero-argument, same reasoning as
  // meta.get_schema's empty shape (read.ts).
  inputSchema: {},
  handler: async (context) => context.client.get<ListTemplatesResult>("/api/v1/meta/templates"),
};

/** Input for {@link getTemplateTool}. */
export interface GetTemplateArgs {
  readonly templateKey: string;
}

/** {@link GetTemplateArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). */
export const getTemplateInputSchema = {
  templateKey: z.string().describe("Template key, as returned by meta.list_templates."),
} satisfies z.ZodRawShape;

/** `GET /api/v1/meta/templates/{templateKey}` response, forwarded verbatim. */
export interface GetTemplateResult {
  readonly templateKey: string;
  readonly displayName: string;
  readonly version: number;
  readonly config: Record<string, unknown>;
}

/**
 * `meta.get_template` — a single template's own content and version.
 *
 * ONE call: `GET /api/v1/meta/templates/{templateKey}` (`getTemplate`),
 * forwarded exactly as returned — no local shaping.
 */
export const getTemplateTool: ToolDefinition<GetTemplateArgs, GetTemplateResult> = {
  name: "meta.get_template",
  kind: "read",
  description: "A single template's own content and version.",
  inputSchema: getTemplateInputSchema,
  handler: async (context, args) =>
    context.client.get<GetTemplateResult>(`/api/v1/meta/templates/${args.templateKey}`),
};

/** Input for {@link templateDependentsTool}. */
export interface TemplateDependentsArgs {
  readonly templateKey: string;
}

/** {@link TemplateDependentsArgs} as a Zod raw shape — becomes this tool's
 * JSON Schema (LAB-257 T243). */
export const templateDependentsInputSchema = {
  templateKey: z.string().describe("Template key, as returned by meta.list_templates."),
} satisfies z.ZodRawShape;

/** One entity, addressed by the tenant it belongs to, that depends on a template. */
export interface TemplateDependent {
  readonly tenantId: string;
  readonly entityName: string;
}

/**
 * `GET /api/v1/meta/templates/{templateKey}/dependents` response, forwarded
 * verbatim. `total` is the platform's own count — never recomputed here
 * from `tenants.length`, even though the two always agree: the platform
 * guarantees that by construction (`getTemplateDependents`, T086), and
 * this tool's job is to surface what was returned, not re-derive it.
 */
export interface TemplateDependentsResult {
  readonly tenants: readonly TemplateDependent[];
  readonly total: number;
}

/**
 * `meta.template_dependents` — who an edit to this template would touch:
 * every entity, across EVERY tenant, whose `basedOn` names it. Called
 * BEFORE `meta.write_template`, whose `acknowledgedDependents` is this
 * call's `total` carried forward as the author's confirmation (FR-037,
 * FR-041) — the one place in this feature's tool surface where a
 * cross-tenant answer is the correct one, not a leak to guard against.
 *
 * ONE call: `GET /api/v1/meta/templates/{templateKey}/dependents`
 * (`getTemplateDependents`). No local counting, no tenant filtering added
 * on top — the platform's own scope (every tenant, active dependents
 * only) is forwarded as-is.
 */
export const templateDependentsTool: ToolDefinition<TemplateDependentsArgs, TemplateDependentsResult> = {
  name: "meta.template_dependents",
  kind: "read",
  description: "Every entity, across every tenant, that depends on this template — call before write_template to get the number to acknowledge.",
  inputSchema: templateDependentsInputSchema,
  handler: async (context, args) =>
    context.client.get<TemplateDependentsResult>(`/api/v1/meta/templates/${args.templateKey}/dependents`),
};

/** Input for {@link writeTemplateTool}. */
export interface WriteTemplateArgs {
  readonly templateKey: string;
  /** Omit to CREATE the template — same create/update convention every
   * other write tool in this set uses (`meta.write_entity`,
   * `meta.write_app`). Present, it must match the platform's current
   * version exactly or the write is rejected as a conflict, checked
   * BEFORE the acknowledgement below (platform-side ordering, not
   * decided here). */
  readonly expectedVersion?: number | undefined;
  readonly config: unknown;
  /** The dependents count the author read via `meta.template_dependents`
   * immediately before this call, carried forward as an explicit
   * confirmation (FR-041). REQUIRED — there is no "safe to omit" case:
   * omitting it is not silence-as-consent, it is a rejected call. */
  readonly acknowledgedDependents: number;
  readonly changeReason?: string | undefined;
}

/** {@link WriteTemplateArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (T241). Unlike `meta.write_entity`/`meta.write_app`,
 * `expectedVersion` is NOT `.optional()` here: templates have no creation
 * path at all (`writeTemplateMeta` throws `not_found` before any version
 * check runs for a nonexistent template), so there is no legitimate call
 * that omits it — the MCP client refuses to even send such a call, rather
 * than relying on the platform's `meta_expected_version_required` refusal
 * to catch it after the fact. */
export const writeTemplateInputSchema = {
  templateKey: z.string(),
  expectedVersion: z
    .number()
    .describe(
      "Always required — templates have no creation path, only updates. " +
        "Pass the version returned by meta.get_template. " +
        'A missing value is rejected (app_code "meta_expected_version_required").',
    ),
  config: z.unknown(),
  acknowledgedDependents: z.number(),
  changeReason: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * `POST /api/v1/meta/templates/{templateKey}` response, forwarded
 * verbatim — mirrors the platform's `WriteTemplateMetaResult` exactly.
 */
export interface WriteTemplateResult {
  readonly version: number;
}

/**
 * `meta.write_template` — writes (creates or updates) a template.
 *
 * ONE call to the platform, nothing computed here. `acknowledgedDependents`
 * is forwarded exactly as given — this tool never compares it against
 * anything itself; the platform RECOUNTS dependents at write time and
 * refuses if the picture has changed since the author's own
 * `meta.template_dependents` call (`writeTemplateMeta`'s "THE SERVER
 * RECOUNTS" — a client-side comparison would check the stale picture
 * against itself, which is exactly the shortcut this design rules out).
 *
 * On a version conflict, a missing or stale acknowledgement, a rule
 * violation, or the production write refusal for the automatic author,
 * this tool does NOT catch, reshape, or retry — the platform's rejection
 * (`PlatformApiError`) propagates to the caller exactly as sent. Per the
 * platform's own ordering (`meta-templates-api.ts`'s `writeTemplateMeta`,
 * "BOTH-STALE DECISION"), a stale version is checked BEFORE the
 * acknowledgement recount, so a call that is stale on both counts sees
 * only the version conflict — this tool does not reorder or duplicate
 * that decision, only surfaces whichever rejection the platform sends.
 */
export const writeTemplateTool: ToolDefinition<WriteTemplateArgs, WriteTemplateResult> = {
  name: "meta.write_template",
  kind: "write",
  description: "Writes (creates or updates) a template. acknowledgedDependents must be the count just read via meta.template_dependents — the platform recounts and refuses if it has changed.",
  inputSchema: writeTemplateInputSchema,
  handler: async (context, args) => {
    // T226: see `meta.write_entity`'s handler (`tools/meta/write.ts`) for
    // why this field is mandatory on every write/delete/rollback body.
    const body: Record<string, unknown> = {
      config: args.config,
      acknowledgedDependents: args.acknowledgedDependents,
      changeSource: "mcp",
    };
    if (args.expectedVersion !== undefined) body.expectedVersion = args.expectedVersion;
    if (args.changeReason !== undefined) body.changeReason = args.changeReason;
    return context.client.write<WriteTemplateResult>(
      `/api/v1/meta/templates/${args.templateKey}`,
      body,
    );
  },
};
