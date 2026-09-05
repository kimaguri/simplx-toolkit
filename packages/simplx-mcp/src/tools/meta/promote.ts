import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * LAB-272 — promoting meta from `test` to `prod` becomes an MCP capability,
 * but ONLY on the `test` profile: both tools here declare `kind: "write"`
 * even though `meta.promote_preview` mutates nothing, so they go through
 * `registerWriteTool` — the SAME structural boundary `meta.write_entity`
 * and friends use (`WriteCapableProfile`, `"write" in profile` in
 * `server.ts`'s `buildToolRegistry`). A `ProdProfile` cannot satisfy
 * `registerWriteTool`'s parameter type at all, so neither tool can even be
 * wired into a prod server — a `tsc` failure, not a runtime name check
 * that a future rename could silently defeat. `ToolKind` is a
 * self-declared fact about what a tool IS ALLOWED to reach, not a report
 * of which HTTP verb it happens to use or whether it persists anything
 * (`registry.ts`'s `ToolKind` doc comment already establishes this for
 * `meta.validate`, which POSTs without writing) — declaring
 * `meta.promote_preview` as `"write"` is the same convention applied to
 * gate an operation that must stay test-profile-only for a different
 * reason: it exposes cross-environment (prod) state to a caller, which is
 * exactly the boundary this profile split exists to enforce.
 *
 * Addressing is BY SLUG, unlike every other `meta.*` tool: `meta.get_entity`
 * / `meta.write_entity` etc. address a tenant by the id `meta.list_apps`
 * returns, but the platform's promote endpoints take `tenantSlug` — this
 * package has no existing tenant-id-to-slug lookup to reuse (grepped
 * `src/tools` and `src/client`; none exists), so `tenantSlug` is accepted
 * here as an explicit input field instead of silently reinterpreting
 * `tenant` as a slug. Documented on the field itself.
 */

/** `target` is the only promotion direction the platform supports today —
 * a literal, not a free string, so an agent cannot address an environment
 * that was never wired up. */
const targetSchema = z
  .literal("prod")
  .optional()
  .describe('The environment to promote to. Only "prod" exists today; omit to default to it.');

const addressingSchemaFields = {
  tenantSlug: z
    .string()
    .describe(
      "The tenant's SLUG, not its id — promotion addresses tenants by slug, unlike every other " +
        "meta.* tool (which use the tenant id from meta.list_apps).",
    ),
  app: z.string().describe("App name, as returned by meta.list_apps."),
  entity: z
    .string()
    .optional()
    .describe(
      "Entity name — promotes this one entity. Mutually exclusive with templateKey; omit both to " +
        "promote the whole app.",
    ),
  templateKey: z
    .string()
    .optional()
    .describe(
      "Template key, as returned by meta.list_templates — promotes this template. Mutually " +
        "exclusive with entity; omit both to promote the whole app.",
    ),
} satisfies z.ZodRawShape;

/** Throws when both `entity` and `templateKey` are given — the one address
 * shape no promote call can legitimately take, checked at runtime because
 * a caller is untyped JSON, not merely TypeScript that happened to compile. */
const assertNotBothEntityAndTemplateKey = (
  toolName: string,
  args: { entity?: string | undefined; templateKey?: string | undefined },
): void => {
  if (args.entity !== undefined && args.templateKey !== undefined) {
    throw new Error(`${toolName}: pass at most one of entity / templateKey, never both.`);
  }
};

/** The addressing fields shared by both tools' request bodies, built once
 * so the preview and the actual promote never risk addressing different
 * things — a bug this shape makes structurally impossible to introduce
 * separately in each handler. */
const buildAddressingBody = (args: {
  readonly target?: "prod" | undefined;
  readonly tenantSlug: string;
  readonly app: string;
  readonly entity?: string | undefined;
  readonly templateKey?: string | undefined;
}): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    target: args.target ?? "prod",
    tenantSlug: args.tenantSlug,
    appName: args.app,
  };
  if (args.entity !== undefined) body.entityName = args.entity;
  if (args.templateKey !== undefined) body.templateKey = args.templateKey;
  return body;
};

/** Input for {@link promotePreviewTool}. */
export interface PromotePreviewArgs {
  readonly tenantSlug: string;
  readonly app: string;
  readonly entity?: string | undefined;
  readonly templateKey?: string | undefined;
  readonly target?: "prod" | undefined;
}

/** {@link PromotePreviewArgs} as a Zod raw shape — becomes this tool's JSON Schema. */
export const promotePreviewInputSchema = {
  ...addressingSchemaFields,
  target: targetSchema,
} satisfies z.ZodRawShape;

/** `POST /api/v1/meta/promote/preview` response, forwarded verbatim. */
export interface PromotePreviewResult {
  readonly source: unknown;
  readonly target: unknown;
  readonly targetVersion: number | null;
  readonly templateStale: boolean;
  readonly diff: unknown;
}

/**
 * `meta.promote_preview` — what promoting the addressed object (app,
 * entity, or template) to `target` (default `prod`) would change, without
 * changing anything. ONE call: `POST /api/v1/meta/promote/preview`,
 * forwarded exactly as the platform sent it — no local diffing, no
 * re-derivation of `targetVersion` or `templateStale`.
 *
 * Always the step before `meta.promote`: read `diff` here, confirm
 * `templateStale` is `false` when promoting a template (`true` means the
 * template itself has changed on the target since the last promotion and
 * needs its own promotion first, not the dependent entity's), then call
 * `meta.promote` with `expectedTargetVersion` set to this response's
 * `targetVersion` — including when it is `null` (no row exists on the
 * target yet).
 */
export const promotePreviewTool: ToolDefinition<PromotePreviewArgs, PromotePreviewResult> = {
  name: "meta.promote_preview",
  kind: "write",
  description:
    'Shows what promoting the addressed object (whole app, one entity, or one template) to target (default "prod") would change — reads only, changes nothing. Pass exactly one of entity/templateKey, or neither to preview the whole app. Read templateStale before promoting a template: true means the template itself is stale on the target and must be promoted first. Carry this response\'s targetVersion into meta.promote\'s expectedTargetVersion, null included. Addresses the tenant by tenantSlug, not the tenant id other meta.* tools use. Only ever available on the test profile — the prod server never has this tool.',
  inputSchema: promotePreviewInputSchema,
  handler: async (context, args) => {
    assertNotBothEntityAndTemplateKey("meta.promote_preview", args);
    return context.client.write<PromotePreviewResult>("/api/v1/meta/promote/preview", buildAddressingBody(args));
  },
};

/** Input for {@link promoteTool}. */
export interface PromoteArgs {
  readonly tenantSlug: string;
  readonly app: string;
  readonly entity?: string | undefined;
  readonly templateKey?: string | undefined;
  readonly target?: "prod" | undefined;
  /** The target's current version, exactly as `meta.promote_preview`
   * returned it — `null` when no row exists on the target yet. Always
   * required: unlike `meta.write_entity`'s create case, promotion always
   * has a preview to carry this from, so there is no legitimate omission. */
  readonly expectedTargetVersion: number | null;
  /** Required ONLY when `templateKey` is given — the dependents count read
   * via `meta.template_dependents` immediately before this call. Promoting
   * a template reaches every dependent tenant exactly the way
   * `meta.write_template` does, so it carries the same confirmation. */
  readonly acknowledgedDependents?: number | undefined;
}

/** {@link PromoteArgs} as a Zod raw shape — becomes this tool's JSON Schema. */
export const promoteInputSchema = {
  ...addressingSchemaFields,
  target: targetSchema,
  expectedTargetVersion: z
    .number()
    .nullable()
    .describe(
      "The target's current version, exactly as returned by meta.promote_preview's targetVersion " +
        "— pass null when preview returned null (no row on the target yet). Always required.",
    ),
  acknowledgedDependents: z
    .number()
    .optional()
    .describe(
      "Required ONLY when templateKey is given — the dependents count just read via " +
        "meta.template_dependents. Promoting a template reaches every dependent tenant exactly " +
        "the way meta.write_template does.",
    ),
} satisfies z.ZodRawShape;

/** `POST /api/v1/meta/promote` response, forwarded verbatim. */
export interface PromoteResult {
  readonly targetVersion: number;
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly actor: string;
}

/**
 * `meta.promote` — promotes the addressed object (app, entity, or
 * template) from `test` to `target` (default `prod`). This IS the
 * production write — the change is live on the target once this call
 * succeeds. ONE call: `POST /api/v1/meta/promote`, `changeSource: "mcp"`
 * (T226 — same reasoning as every other write tool's handler: a missing
 * `changeSource` would misattribute the change in history and leave the
 * production write refusal for the automatic author dead, since it gates
 * on the author `changeSource` resolves to. Promotion's own author still
 * carries `promote` as its `change_source` on the PLATFORM side — `mcp`
 * here identifies which CLIENT initiated it, matching how `meta.write_entity`
 * distinguishes `mcp` from `admin_ui`).
 *
 * `expectedTargetVersion` is forwarded exactly as given, `null` included —
 * this tool computes nothing and never substitutes a freshly re-fetched
 * value. On a `version_conflict` (target moved since the caller's own
 * `meta.promote_preview`), a stale acknowledgement
 * (`meta_promote_template_stale`), or any other platform refusal, this
 * tool does NOT catch, reshape, or retry — the platform's rejection
 * propagates to the caller exactly as sent, `details.params.currentVersion`
 * included. Recovery is always `meta.promote_preview` again, never a blind
 * retry with a silently refetched version.
 *
 * Governance, not a technical gate: promotion is per object — one app, one
 * entity, or one template at a time, the whole configuration, never a
 * partial merge — and must only be called on the tenant owner's explicit
 * instruction. A template must be promoted before an entity `basedOn` it,
 * when both are stale (`meta.promote_preview`'s `templateStale` says so).
 */
export const promoteTool: ToolDefinition<PromoteArgs, PromoteResult> = {
  name: "meta.promote",
  kind: "write",
  description:
    'Promotes the addressed object (whole app, one entity, or one template) from test to target (default "prod"). This IS the production write — live once this call succeeds. Call meta.promote_preview first and pass its targetVersion as expectedTargetVersion (null included); a version_conflict answer means the target moved since — re-preview, do not retry blindly. acknowledgedDependents is required for templateKey (read via meta.template_dependents first) and reaches every dependent tenant, exactly like meta.write_template. Promote a template before an entity basedOn it when both are stale. Only call this on the tenant owner\'s explicit instruction. Only ever available on the test profile — the prod server never has this tool.',
  inputSchema: promoteInputSchema,
  handler: async (context, args) => {
    assertNotBothEntityAndTemplateKey("meta.promote", args);
    if (args.templateKey !== undefined && typeof args.acknowledgedDependents !== "number") {
      throw new Error(
        "meta.promote requires acknowledgedDependents when templateKey is given: promoting a " +
          "template reaches every dependent tenant exactly the way meta.write_template does, so " +
          "read meta.template_dependents first and pass its total.",
      );
    }
    const body: Record<string, unknown> = {
      ...buildAddressingBody(args),
      expectedTargetVersion: args.expectedTargetVersion,
      changeSource: "mcp",
    };
    if (args.acknowledgedDependents !== undefined) body.acknowledgedDependents = args.acknowledgedDependents;
    return context.client.write<PromoteResult>("/api/v1/meta/promote", body);
  },
};
