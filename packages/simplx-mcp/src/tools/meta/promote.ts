import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * LAB-272 T063 — promoting meta from `test` to `prod` becomes an MCP
 * capability, but ONLY on the `test` profile: both tools here declare
 * `kind: "write"` even though `meta.promote_preview` mutates nothing, so
 * they go through `registerWriteTool` — the SAME structural boundary
 * `meta.write_entity` and friends use (`WriteCapableProfile`, `"write" in
 * profile` in `server.ts`'s `buildToolRegistry`). A `ProdProfile` cannot
 * satisfy `registerWriteTool`'s parameter type at all, so neither tool can
 * even be wired into a prod server — a `tsc` failure, not a runtime name
 * check that a future rename could silently defeat. `ToolKind` is a
 * self-declared fact about what a tool IS ALLOWED to reach, not a report
 * of which HTTP verb it happens to use or whether it persists anything
 * (`registry.ts`'s `ToolKind` doc comment already establishes this for
 * `meta.validate`, which POSTs without writing) — declaring
 * `meta.promote_preview` as `"write"` is the same convention applied to
 * gate an operation that must stay test-profile-only for a different
 * reason: it exposes cross-environment (prod) state to a caller, which is
 * exactly the boundary this profile split exists to enforce.
 *
 * ADDRESSING — confirmed against the platform's own
 * `resolveAddress`/`PromoteAddressInput` (`meta-promote-address.ts`):
 * exactly THREE mutually exclusive shapes, not "any combination of
 * tenantSlug/app/entity/templateKey":
 *   - entity:   `{ tenantSlug, appName, entityName }`
 *   - app:      `{ tenantSlug, appName }` — entityName/templateKey ABSENT
 *   - template: `{ templateKey }` — tenantSlug/appName ABSENT (templates
 *               are cross-tenant; sending a slug with a templateKey is
 *               `meta_promote_address_invalid`, not merely ignored)
 * `assertValidAddress` below enforces this at runtime — a caller is
 * untyped JSON, so a Zod-optional field alone does not stop a call mixing
 * `templateKey` with `tenantSlug`.
 *
 * Addressing is BY SLUG, unlike every other `meta.*` tool: `meta.get_entity`
 * / `meta.write_entity` etc. address a tenant by the id `meta.list_apps`
 * returns, but the platform's promote endpoints take `tenantSlug` directly
 * and resolve it to an id on BOTH sides internally — there is no separate
 * lookup for this tool to call first (confirmed with the platform side,
 * LAB-272 T062: `resolveLocalTenantIdBySlug` / `resolveTenantIdOnTarget`).
 * A slug is not guaranteed to name the same tenant across environments
 * (e.g. test's `intellhouse` vs a differently-named prod tenant) — a known
 * platform-side caveat, not something this tool tries to detect or route
 * around.
 *
 * There is NO `acknowledgedDependents` field on `meta.promote` — unlike
 * `meta.write_template`/`meta.rollback`, the platform recounts a
 * template's dependents on the TARGET itself as part of the promote call
 * and never asks the caller to carry a count forward. Do not add one.
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
    .optional()
    .describe(
      "The tenant's SLUG, not its id — promotion addresses tenants by slug, unlike every other " +
        "meta.* tool (which use the tenant id from meta.list_apps). Required together with app " +
        "for an app or entity promotion; MUST be omitted when templateKey is given (templates " +
        "are cross-tenant).",
    ),
  app: z
    .string()
    .optional()
    .describe(
      "App name, as returned by meta.list_apps. Required together with tenantSlug for an app or " +
        "entity promotion; MUST be omitted when templateKey is given.",
    ),
  entity: z
    .string()
    .optional()
    .describe(
      "Entity name. Given (with tenantSlug+app), promotes this one entity. Omitted (with " +
        "tenantSlug+app), promotes the whole app description instead. MUST be omitted when " +
        "templateKey is given.",
    ),
  templateKey: z
    .string()
    .optional()
    .describe(
      "Template key, as returned by meta.list_templates — promotes this template instead of an " +
        "app or entity. Templates are cross-tenant: give ONLY templateKey, tenantSlug/app/entity " +
        "MUST all be omitted.",
    ),
} satisfies z.ZodRawShape;

interface AddressArgs {
  readonly tenantSlug?: string | undefined;
  readonly app?: string | undefined;
  readonly entity?: string | undefined;
  readonly templateKey?: string | undefined;
}

/**
 * Enforces the platform's exactly-three-shapes rule (see the module header)
 * BEFORE any network call — the platform would refuse a mixed address with
 * `meta_promote_address_invalid` too, but failing here names the caller's
 * actual mistake instead of a generic remote 400.
 */
const assertValidAddress = (toolName: string, args: AddressArgs): void => {
  if (args.templateKey !== undefined) {
    if (args.tenantSlug !== undefined || args.app !== undefined || args.entity !== undefined) {
      throw new Error(
        `${toolName}: templateKey is mutually exclusive with tenantSlug/app/entity — templates ` +
          "are cross-tenant, addressed by templateKey alone.",
      );
    }
    return;
  }
  if (args.tenantSlug === undefined || args.app === undefined) {
    throw new Error(`${toolName}: tenantSlug and app are both required unless templateKey is given.`);
  }
};

/** The addressing fields shared by both tools' request bodies, built once
 * so the preview and the actual promote never risk addressing something
 * differently — a bug this shape makes structurally impossible to
 * introduce separately in each handler. Omits tenantSlug/appName entirely
 * for a template address (never sends them as `undefined` — the platform
 * requires their outright ABSENCE, see `assertValidAddress`'s doc). */
const buildAddressingBody = (args: AddressArgs & { readonly target?: "prod" | undefined }): Record<string, unknown> => {
  if (args.templateKey !== undefined) {
    return { target: args.target ?? "prod", templateKey: args.templateKey };
  }
  const body: Record<string, unknown> = {
    target: args.target ?? "prod",
    tenantSlug: args.tenantSlug,
    appName: args.app,
  };
  if (args.entity !== undefined) body.entityName = args.entity;
  return body;
};

/** Input for {@link promotePreviewTool}. */
export interface PromotePreviewArgs extends AddressArgs {
  readonly target?: "prod" | undefined;
}

/** {@link PromotePreviewArgs} as a Zod raw shape — becomes this tool's JSON Schema. */
export const promotePreviewInputSchema = {
  ...addressingSchemaFields,
  target: targetSchema,
} satisfies z.ZodRawShape;

/** One structural difference `meta.promote_preview`'s `diff` reports —
 * a canonical, sorted-key comparison, never a raw JSON.stringify diff. */
export interface PromoteDiffEntry {
  readonly path: string;
  readonly op: "add" | "remove" | "change";
}

/** `POST /api/v1/meta/promote/preview` response, forwarded verbatim
 * (confirmed against the platform's own handler, LAB-272 T062). `target`
 * and `targetVersion` are `null` together when no row exists on the target
 * yet — a legitimate first-promotion state, not an error. `templateStale`
 * is `false` unless a template is actually involved. */
export interface PromotePreviewResult {
  readonly source: Record<string, unknown>;
  readonly target: Record<string, unknown> | null;
  readonly targetVersion: number | null;
  readonly templateStale: false | true | "missing";
  readonly diff: readonly PromoteDiffEntry[];
}

/**
 * `meta.promote_preview` — what promoting the addressed object (app,
 * entity, or template) to `target` (default `prod`) would change, without
 * changing anything. ONE call: `POST /api/v1/meta/promote/preview`,
 * forwarded exactly as the platform sent it — no local diffing, no
 * re-derivation of `targetVersion` or `templateStale`.
 *
 * Always the step before `meta.promote`: read `diff` here, confirm
 * `templateStale` is `false` when promoting an entity that depends on a
 * template (`true`/`"missing"` means the template itself has changed or
 * is absent on the target and needs its own promotion first), then call
 * `meta.promote` with `expectedTargetVersion` set to this response's
 * `targetVersion` — including when it is `null` (no row exists on the
 * target yet).
 */
export const promotePreviewTool: ToolDefinition<PromotePreviewArgs, PromotePreviewResult> = {
  name: "meta.promote_preview",
  kind: "write",
  description:
    'Shows what promoting the addressed object (app, entity, or template) to target (default "prod") would change — reads only, changes nothing. Address with tenantSlug+app (add entity for one entity, omit it for the whole app) OR templateKey alone (never mixed with tenantSlug/app/entity — templates are cross-tenant). Read templateStale before promoting: true or "missing" means a dependency template needs promoting first. Carry this response\'s targetVersion into meta.promote\'s expectedTargetVersion, null included. Addresses the tenant by tenantSlug, not the tenant id other meta.* tools use. Only ever available on the test profile — the prod server never has this tool.',
  inputSchema: promotePreviewInputSchema,
  handler: async (context, args) => {
    assertValidAddress("meta.promote_preview", args);
    return context.client.write<PromotePreviewResult>("/api/v1/meta/promote/preview", buildAddressingBody(args));
  },
};

/** Input for {@link promoteTool}. */
export interface PromoteArgs extends AddressArgs {
  readonly target?: "prod" | undefined;
  /** The target's current version, exactly as `meta.promote_preview`
   * returned it — `null` when no row exists on the target yet. Always
   * required here: unlike `meta.write_entity`'s create case, promotion
   * always has a preview to carry this from, so there is no legitimate
   * omission in THIS tool's own cycle (the platform itself would also
   * accept an entirely omitted field, but requiring it here keeps the
   * preview -> promote cycle honest). */
  readonly expectedTargetVersion: number | null;
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
} satisfies z.ZodRawShape;

/** `POST /api/v1/meta/promote` response, forwarded verbatim. `actor` is
 * the resolved author id: `"agent:mcp"` for a call carrying
 * `changeSource: "mcp"` (every call this tool makes), or `null` if the
 * platform could not resolve one. */
export interface PromoteResult {
  readonly targetVersion: number;
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly actor: string | null;
}

/**
 * `meta.promote` — promotes the addressed object (app, entity, or
 * template) from `test` to `target` (default `prod`). This IS the
 * production write — the change is live on the target once this call
 * succeeds. ONE call: `POST /api/v1/meta/promote`, `changeSource: "mcp"`
 * (T226 — same reasoning as every other write tool's handler: identifies
 * this call as agent-initiated so the resolved `actor` in the response
 * reads `"agent:mcp"`, matching how `meta.write_entity` distinguishes
 * `mcp` from `admin_ui`).
 *
 * `expectedTargetVersion` is forwarded exactly as given, `null` included —
 * this tool computes nothing and never substitutes a freshly re-fetched
 * value. Template dependents are recounted by the platform itself on the
 * target as part of this call — this tool passes no such count, and there
 * is no `acknowledgedDependents` field to pass one in.
 *
 * On a `version_conflict` (target moved since the caller's own
 * `meta.promote_preview`, `details.params.currentVersion` included), a
 * `meta_promote_template_stale`, an address error
 * (`meta_promote_address_invalid`), an unreachable/misconfigured target,
 * or any error the TARGET's own write endpoint raised and this call
 * re-threw under its OWN `code` (`propagateTargetError`, LAB-272 T062 —
 * e.g. a rule violation stays whatever `app_code` the target gave it, it
 * is never re-coded as a generic promote failure), this tool does NOT
 * catch, reshape, or retry — the platform's rejection propagates to the
 * caller exactly as sent. Recovery is always `meta.promote_preview`
 * again, never a blind retry with a silently refetched version.
 *
 * Governance, not a technical gate: promotion is per object — one app, one
 * entity, or one template at a time, the whole configuration, never a
 * partial merge — and must only be called on the tenant owner's explicit
 * instruction. A template must be promoted before an entity `basedOn` it
 * when `meta.promote_preview`'s `templateStale` says the template is
 * stale or missing on the target.
 */
export const promoteTool: ToolDefinition<PromoteArgs, PromoteResult> = {
  name: "meta.promote",
  kind: "write",
  description:
    'Promotes the addressed object (app, entity, or template) from test to target (default "prod"). This IS the production write — live once this call succeeds. Address with tenantSlug+app (add entity for one entity, omit it for the whole app) OR templateKey alone (never mixed). Call meta.promote_preview first and pass its targetVersion as expectedTargetVersion (null included); a version_conflict answer means the target moved since — re-preview, do not retry blindly. Promote a template before an entity basedOn it when the preview\'s templateStale is not false. Only call this on the tenant owner\'s explicit instruction. Only ever available on the test profile — the prod server never has this tool.',
  inputSchema: promoteInputSchema,
  handler: async (context, args) => {
    assertValidAddress("meta.promote", args);
    const body: Record<string, unknown> = {
      ...buildAddressingBody(args),
      expectedTargetVersion: args.expectedTargetVersion,
      changeSource: "mcp",
    };
    return context.client.write<PromoteResult>("/api/v1/meta/promote", body);
  },
};
