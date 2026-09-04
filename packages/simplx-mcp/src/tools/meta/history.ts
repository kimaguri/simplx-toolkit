import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * One row of a meta change history, exactly as the platform's
 * `getMetaVersionHistory` (`platform/src/services/tenant-management/src/
 * meta-versioning.ts`) returns it. Most fields mirror the `meta_versions`
 * database row verbatim (snake_case) — `versioningScheme`/`isSchemeBoundary`
 * are the two deliberate exceptions, camelCase because they are COMPUTED by
 * that function rather than stored on the row itself. Forwarded here with
 * the mixed casing intact, not "tidied" into one convention: a reader who
 * cannot tell `entity_name` and `versioningScheme` apart by name alone is
 * exactly the reader who needs the distinction between "what the platform
 * stored" and "what the platform derived" to stay visible.
 *
 * `versioningScheme` is `"legacy_app"` for a snapshot recorded before the
 * per-entity-versioning cutover, `"entity"` after — version numbers are
 * comparable only WITHIN one scheme, never across (R5, FR-032).
 * `isSchemeBoundary` is `true` on exactly the one row where the scheme
 * changes from the previous (newer) row — the single transition point a
 * caller renders a divider at, never every row of the older scheme.
 */
export interface MetaVersionHistoryEntry {
  readonly id: string;
  readonly tenant_id: string;
  readonly meta_type: "app" | "entity" | "template";
  readonly meta_id: string;
  readonly entity_name: string | null;
  readonly from_version: number | null;
  readonly to_version: number;
  readonly previous_config: Record<string, unknown> | null;
  /** Nullable: an explicit `null` marks a delete's snapshot — "new content"
   * for a delete is the absence of content, recorded as such. */
  readonly new_config: Record<string, unknown> | null;
  readonly change_source: string | null;
  readonly change_reason: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly versioning_scheme?: string | null;
  readonly versioningScheme: "legacy_app" | "entity";
  readonly isSchemeBoundary: boolean;
}

/** Input for {@link versionsTool}. */
export interface VersionsArgs {
  /** Omit together with `app` when `templateKey` is given — a template has
   * no tenant/app/entity triple, `templateKey` is its whole address. */
  readonly tenant?: string | undefined;
  readonly app?: string | undefined;
  /** Omit to read the APP description's own history instead of an
   * entity's — the same triple-vs-pair distinction `meta.get_app` /
   * `meta.get_entity` already draw. Ignored when `templateKey` is given. */
  readonly entity?: string | undefined;
  /** Given, addresses a template's own history instead of an entity's or
   * app's — mutually exclusive with `tenant`/`app`/`entity`. */
  readonly templateKey?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** {@link VersionsArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). None of the address fields is unconditionally
 * required by the handler (see the branching in the handler below): a
 * `templateKey` call needs only that; an entity call needs `tenant`,
 * `app`, `entity`; an app call needs `tenant`, `app`. The descriptions
 * carry the rule instead of the schema's `required` array, matching the
 * mutually-exclusive-optionals convention `meta.rollback`'s own address
 * fields already use. */
export const versionsInputSchema = {
  tenant: z
    .string()
    .optional()
    .describe(
      "Tenant id, as returned by meta.list_apps. Required together with app when reading an " +
        "entity's or an app's history; omit together with app when templateKey is given.",
    ),
  app: z
    .string()
    .optional()
    .describe(
      "App name, as returned by meta.list_apps. Required together with tenant when reading an " +
        "entity's or an app's history; omit together with tenant when templateKey is given.",
    ),
  entity: z
    .string()
    .optional()
    .describe(
      "Entity name. Given (with tenant+app), reads this entity's history. Omitted (with " +
        "tenant+app), reads the APP description's own history instead. Ignored when templateKey " +
        "is given.",
    ),
  templateKey: z
    .string()
    .optional()
    .describe(
      "Template key, as returned by meta.list_templates. Given, reads this template's history " +
        "instead of an entity's or app's — mutually exclusive with tenant/app/entity.",
    ),
  limit: z.number().optional().describe("Maximum number of history entries to return."),
  offset: z.number().optional().describe("Number of history entries to skip, for pagination."),
} satisfies z.ZodRawShape;

/**
 * `meta.versions` — the change history of an entity, an app description, or
 * a template: who, when, from which source, what it was and what it became.
 *
 * ONE call: `GET /api/v1/meta/templates/{templateKey}/versions` when
 * `templateKey` is given (`getTemplateVersions`, T175 — templates have no
 * tenant/app/entity triple, `templateKey` is their entire address);
 * otherwise `GET /api/v1/meta/entities/{tenant}/{app}/{entity}/versions`
 * when `entity` is given, `GET /api/v1/meta/apps/{tenant}/{app}/versions`
 * otherwise (`getEntityVersionsByName` / `getAppVersions`, T168 — both
 * addressed by the tenant/app/entity triple an agent already has from
 * `meta.get_entity`/`meta.get_app`, never the opaque row id the
 * now-legacy `getEntityVersions`/`rollbackEntityMetaById` still use for
 * `simplx-apps`' admin history panel). Each entry is forwarded exactly as
 * the platform sent it — see {@link MetaVersionHistoryEntry} for why the
 * mixed snake_case/camelCase shape is deliberate and not reshaped here;
 * templates return the identical shape (`getTemplateVersions` is a thin
 * address-to-`meta_id` resolution in front of the same shared history
 * query `getEntityVersionsByName`/`getAppVersions` use).
 */
export const versionsTool: ToolDefinition<VersionsArgs, readonly MetaVersionHistoryEntry[]> = {
  name: "meta.versions",
  kind: "read",
  description: "The change history of an entity (pass entity), an app description (omit entity), or a template (pass templateKey instead of tenant/app/entity) — who, when, from which source, before and after. Each entry carries versioningScheme and isSchemeBoundary; version numbers are only comparable within one scheme.",
  inputSchema: versionsInputSchema,
  handler: async (context, args) => {
    const query = new URLSearchParams();
    if (args.limit !== undefined) query.set("limit", String(args.limit));
    if (args.offset !== undefined) query.set("offset", String(args.offset));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    const path =
      args.templateKey !== undefined
        ? `/api/v1/meta/templates/${args.templateKey}/versions${suffix}`
        : args.entity !== undefined
          ? `/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}/versions${suffix}`
          : `/api/v1/meta/apps/${args.tenant}/${args.app}/versions${suffix}`;

    return context.client.get<readonly MetaVersionHistoryEntry[]>(path);
  },
};

/** Input for {@link rollbackTool}. */
export interface RollbackArgs {
  /** Omit together with `app` when `templateKey` is given. */
  readonly tenant?: string | undefined;
  readonly app?: string | undefined;
  /** Omit to roll back the APP description instead of an entity. Ignored
   * when `templateKey` is given. */
  readonly entity?: string | undefined;
  /** Given, rolls back a template instead of an entity or app —
   * mutually exclusive with `tenant`/`app`/`entity`. */
  readonly templateKey?: string | undefined;
  readonly targetVersionId: string;
  /** The version the caller last read — MANDATORY on the entity, app, AND
   * template paths (T167/T175): a rollback replaces the whole stored
   * description wholesale, so it races a concurrent change exactly the
   * way an ordinary write does, and there is no "safe to omit" case the
   * way `write_entity`'s create-at-version-1 path has. */
  readonly expectedVersion: number;
  /** REQUIRED when `templateKey` is given, checked at runtime here (same
   * reason `meta.write_template`'s does — see {@link writeTemplateTool}):
   * a template rollback reaches every dependent tenant exactly the way an
   * edit does, so it carries the same acknowledgement obligation. The
   * count the caller read via `meta.template_dependents` immediately
   * before this call — the SERVER recounts and refuses if it has changed
   * (T175's "BOTH-STALE DECISION": a stale `expectedVersion` is checked
   * first, so a call stale on both counts sees only the version
   * conflict). Never validated, refreshed, or compared against anything
   * by this tool — a client-side comparison would check the stale picture
   * against itself. Ignored on the entity/app paths, which carry no such
   * obligation. */
  readonly acknowledgedDependents?: number | undefined;
  readonly changeReason?: string | undefined;
}

/** {@link RollbackArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243).
 *
 * NOT a `z.discriminatedUnion`: `ToolDefinition.inputSchema` is a flat
 * `z.ZodRawShape` (one Zod type per top-level field, the shape
 * `McpServer.registerTool` itself requires) — a discriminated union
 * would have to live inside a single wrapper field (e.g. `{ target:
 * z.discriminatedUnion(...) }`), which would change every call's actual
 * argument shape and break the handler below, which reads `args.tenant`
 * / `args.templateKey` etc. directly. Mutually-exclusive optionals with
 * `.describe()` spelling out the rule is the same convention
 * `meta.versions`' address fields (above) and `write.ts`'s
 * `expectedVersionOnUpdateDescription` already use for a condition the
 * flat shape cannot express structurally — checked against the rendered
 * JSON Schema in `test/read-input-schema.test.ts`, not the Zod source.
 */
export const rollbackInputSchema = {
  tenant: z
    .string()
    .optional()
    .describe(
      "Tenant id, as returned by meta.list_apps. Required together with app when rolling back " +
        "an entity or an app description; omit together with app when templateKey is given.",
    ),
  app: z
    .string()
    .optional()
    .describe(
      "App name, as returned by meta.list_apps. Required together with tenant when rolling back " +
        "an entity or an app description; omit together with tenant when templateKey is given.",
    ),
  entity: z
    .string()
    .optional()
    .describe(
      "Entity name. Given (with tenant+app), rolls back this entity. Omitted (with tenant+app), " +
        "rolls back the APP description instead. Ignored when templateKey is given.",
    ),
  templateKey: z
    .string()
    .optional()
    .describe(
      "Template key, as returned by meta.list_templates. Given, rolls back this template " +
        "instead of an entity or app — mutually exclusive with tenant/app/entity, and requires " +
        "acknowledgedDependents (see below).",
    ),
  targetVersionId: z
    .string()
    .describe("The meta_versions row id to restore, as returned by meta.versions."),
  expectedVersion: z
    .number()
    .describe(
      "The current version the caller last read (from meta.get_entity / meta.get_app / " +
        "meta.get_template as appropriate) — always required, no legitimate omission: a " +
        "rollback replaces the whole stored description wholesale, exactly like an ordinary write.",
    ),
  acknowledgedDependents: z
    .number()
    .optional()
    .describe(
      "Required ONLY when templateKey is given — the dependents count just read via " +
        "meta.template_dependents. Restoring old template content reaches every dependent " +
        "tenant exactly the way an edit does, so the platform recounts and refuses if the " +
        "picture has changed. Omitted, or ignored, on the entity/app paths.",
    ),
  changeReason: z.string().optional().describe("Optional free-text reason recorded with this change."),
} satisfies z.ZodRawShape;

/** `meta.rollback` response, forwarded verbatim. */
export interface RollbackResult {
  readonly newVersion: number;
  /** Warnings only — computed against the RESTORED config, never the
   * blocking rules `meta.validate` enforces. An older config may name a
   * component since removed from the renderer's core registry; this is
   * how the agent learns that BEFORE the screen renders empty. */
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * `meta.rollback` — returns an entity, an app description, or a template to
 * a previously saved version. This CREATES A NEW VERSION carrying the old
 * content; it does not erase what came between and must never be
 * presented to the caller as undoing history — the intervening versions
 * stay exactly where they are, in `meta.versions`' own output.
 *
 * ONE call: `POST /api/v1/meta/templates/{templateKey}/rollback` when
 * `templateKey` is given (`rollbackTemplateMeta`, T175); otherwise
 * `POST /api/v1/meta/entities/{tenant}/{app}/{entity}/rollback` when
 * `entity` is given, `POST /api/v1/meta/apps/{tenant}/{app}/rollback`
 * otherwise (`rollbackEntityMetaByName`, T168; `rollbackAppMetaById`,
 * already triple-addressed before T168). `expectedVersion` is forwarded
 * exactly as given — this tool does not compute, retry, or soften a
 * rejection.
 *
 * Template rollback carries ONE extra obligation entity/app rollback does
 * not: `acknowledgedDependents` is REQUIRED, checked at runtime here (a
 * compile-time-only optional field would not stop a call that omits it —
 * same reasoning `meta.delete_entity`'s `expectedVersion` check uses).
 * Restoring old content reaches every dependent tenant exactly the way an
 * ordinary template edit does (T071/T084), so the same confirmation
 * `meta.write_template` requires applies here too — "this content used to
 * be live" is not a reason to skip confirming TODAY's dependent picture.
 * This tool forwards the count exactly as given and never computes,
 * refreshes, or compares it itself — the platform RECOUNTS at rollback
 * time and refuses with `meta_template_ack_dependents_stale` if the
 * picture has changed since the caller's own `meta.template_dependents`
 * call, the identical shape `meta.write_template`'s refusal takes. Per the
 * platform's ordering (T175's "BOTH-STALE DECISION"), a stale
 * `expectedVersion` is checked BEFORE the acknowledgement recount, so a
 * call stale on both counts sees only the version conflict — this tool
 * does not reorder or duplicate that decision, only surfaces whichever
 * rejection the platform sends.
 *
 * On a version conflict, a stale acknowledgement, a rule violation, or the
 * production write refusal for the automatic author, this tool does NOT
 * catch, reshape, or retry — the platform's rejection (`PlatformApiError`)
 * propagates to the caller exactly as sent, `details.params.currentVersion`
 * (or `details.params.actualDependents`) included. Recovery is always
 * `meta.versions` (re-read) — and for a stale acknowledgement,
 * `meta.template_dependents` (re-read) — pick a target again, then call
 * this tool again with fresh values; an automatic retry with a silently
 * refetched version or count would BE the unreviewed overwrite this whole
 * feature exists to prevent.
 */
export const rollbackTool: ToolDefinition<RollbackArgs, RollbackResult> = {
  name: "meta.rollback",
  kind: "write",
  description: "Returns an entity (pass entity), an app description (omit entity), or a template (pass templateKey instead of tenant/app/entity) to a previously saved version — creates a new version carrying the old content, never erases what came between. targetVersionId is the `id` of a meta.versions entry (its new_config is what gets restored); expectedVersion is the CURRENT version from meta.get_entity / get_app / get_template, not the target's number. expectedVersion is always mandatory; acknowledgedDependents is mandatory for templates (the count just read via meta.template_dependents — the platform recounts and refuses if it has changed).",
  inputSchema: rollbackInputSchema,
  handler: async (context, args) => {
    if (args.templateKey !== undefined) {
      if (typeof args.acknowledgedDependents !== "number") {
        throw new Error(
          "meta.rollback requires acknowledgedDependents when templateKey is given: restoring old " +
            "content reaches every dependent tenant exactly the way an edit does, so read " +
            "meta.template_dependents first and pass its total.",
        );
      }
      // T226: see `meta.write_entity`'s handler (`tools/meta/write.ts`)
      // for why this field is mandatory on every write/delete/rollback
      // body.
      const body: Record<string, unknown> = {
        targetVersionId: args.targetVersionId,
        expectedVersion: args.expectedVersion,
        acknowledgedDependents: args.acknowledgedDependents,
        changeSource: "mcp",
      };
      if (args.changeReason !== undefined) body.changeReason = args.changeReason;
      return context.client.write<RollbackResult>(`/api/v1/meta/templates/${args.templateKey}/rollback`, body);
    }

    const body: Record<string, unknown> = {
      targetVersionId: args.targetVersionId,
      expectedVersion: args.expectedVersion,
      changeSource: "mcp",
    };
    if (args.changeReason !== undefined) body.changeReason = args.changeReason;

    const path =
      args.entity !== undefined
        ? `/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}/rollback`
        : `/api/v1/meta/apps/${args.tenant}/${args.app}/rollback`;

    return context.client.write<RollbackResult>(path, body);
  },
};
