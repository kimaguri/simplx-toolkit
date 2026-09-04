import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/** The requirement text shared by every write tool whose `expectedVersion`
 * is optional at the type level but conditionally required at the platform
 * (T227, `meta_expected_version_required` / `meta_expected_version_not_allowed`
 * — `platform/src/lib/errs/codes.ts`). Surfaced through `.describe()` so the
 * calling agent reads it in the tool's JSON Schema BEFORE the call, not only
 * after a refusal (T241). */
export const expectedVersionOnUpdateDescription = (getterToolName: string): string =>
  `Required when the record already exists — pass the version returned by ${getterToolName}. ` +
  "Omit ONLY when creating a new record. Supplying a value while creating is rejected " +
  '(app_code "meta_expected_version_not_allowed"); omitting it for an existing record is ' +
  'rejected (app_code "meta_expected_version_required").';

/** {@link WriteEntityArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (T241): `expectedVersion` stays optional (creation has no version
 * to give), but its `.describe()` spells out when omitting it is wrong. */
export const writeEntityInputSchema = {
  tenant: z.string(),
  app: z.string(),
  entity: z.string(),
  expectedVersion: z.number().optional().describe(expectedVersionOnUpdateDescription("meta.get_entity")),
  config: z.unknown(),
  changeReason: z.string().optional(),
} satisfies z.ZodRawShape;

/** Input for {@link writeEntityTool}. */
export interface WriteEntityArgs {
  readonly tenant: string;
  readonly app: string;
  readonly entity: string;
  /** Omit to CREATE the entity at version 1 — the same call handles both
   * create and update (contracts/meta-write-api.md: "Создание выполняется
   * тем же вызовом"). Present, it must match the platform's current
   * version exactly or the write is rejected as a conflict. */
  readonly expectedVersion?: number | undefined;
  readonly config: unknown;
  readonly changeReason?: string | undefined;
}

/**
 * `POST /api/v1/meta/entities/{tenantId}/{appName}/{entityName}` response,
 * forwarded verbatim — mirrors the platform's `WriteEntityMetaResult`
 * (`platform/src/services/tenant-management/meta-entities-api.ts`)
 * exactly, including `unknownComponents` (a warning that never affects
 * whether the write succeeded).
 */
export interface WriteEntityResult {
  readonly version: number;
  readonly entityName: string;
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * `meta.write_entity` — writes (creates or updates) the addressed entity
 * description. Write IS publication (FR-009): exactly ONE call to the
 * platform, no separate publish step, and no pre-fetch to compute
 * anything — `expectedVersion` is whatever the caller already has from its
 * own last `meta.get_entity`, and the returned `version` is whatever the
 * platform's own optimistic-concurrency check actually produced, never
 * `expectedVersion + 1` computed here.
 *
 * On a version conflict, on a rule violation, or on the production write
 * refusal for the automatic author, this tool does NOT catch, reshape, or
 * retry — the platform's rejection (`PlatformApiError`, T050: `code` /
 * `details` carrying e.g. `details.params.currentVersion`) propagates to
 * the caller exactly as the platform sent it. In particular there is no
 * retry-on-the-agent's-behalf here: recovery from a conflict is always
 * `meta.get_entity` (re-read), edit `raw` again, then call this tool again
 * with the fresh `expectedVersion` — an automatic retry with a silently
 * refetched version would BE the unreviewed overwrite this whole feature
 * exists to prevent, dressed up as a convenience.
 */
export const writeEntityTool: ToolDefinition<WriteEntityArgs, WriteEntityResult> = {
  name: "meta.write_entity",
  kind: "write",
  description:
    "Writes (creates or updates) the addressed entity description. This IS publication — the change is live once this call succeeds. Send the RAW config (meta.get_entity's `raw`); for a basedOn entity that is overrides only, arrays replace wholesale. Rules that bite: constants.labels is a whole object (partial is refused); the sidebar label is the translation of routeConfig.navKey when one exists, displayName only otherwise — renaming displayName alone leaves the menu unchanged; routeConfig.hideInMenu hides from the sidebar. Pass expectedVersion for an existing entity, omit it only for a new one; a version_conflict answer carries details.params.currentVersion — re-read and re-apply, never retry blindly. Answer's unknownComponents / unresolvedOverrides are warnings, the write already succeeded. Prefer changeReason: humans read it in history.",
  inputSchema: writeEntityInputSchema,
  handler: async (context, args) => {
    // T226: identifies every write this tool makes as coming from an
    // agent, not a human at the admin UI — the platform defaults a missing
    // `changeSource` to `'admin_ui'`, which would both misattribute the
    // change in `meta_versions` (FR-045) and leave the production write
    // refusal for the automatic author (`assertAgentWriteNotInProduction`)
    // dead, since it gates on the author `resolveChangeAuthor` derives
    // FROM this field.
    const body: Record<string, unknown> = { config: args.config, changeSource: "mcp" };
    if (args.expectedVersion !== undefined) body.expectedVersion = args.expectedVersion;
    if (args.changeReason !== undefined) body.changeReason = args.changeReason;
    return context.client.write<WriteEntityResult>(
      `/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}`,
      body,
    );
  },
};

/** Input for {@link deleteEntityTool}. `expectedVersion` is REQUIRED, and
 * checked at runtime (not just typed) — see {@link deleteEntityTool}. */
export interface DeleteEntityArgs {
  readonly tenant: string;
  readonly app: string;
  readonly entity: string;
  readonly expectedVersion: number;
}

/** {@link DeleteEntityArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). `expectedVersion` is required at the schema
 * level too (not merely checked at runtime below): deletion has no
 * creation-like "no version yet" case the way write does. */
export const deleteEntityInputSchema = {
  tenant: z.string().describe("Tenant id, as returned by meta.list_apps."),
  app: z.string().describe("App name, as returned by meta.list_apps."),
  entity: z.string().describe("Entity name, as listed under this app by meta.list_apps."),
  expectedVersion: z
    .number()
    .describe(
      "The version returned by the last meta.get_entity — always required. Deleting without " +
        "checking the current version would risk removing changes another author made since.",
    ),
} satisfies z.ZodRawShape;

/** `DELETE /api/v1/meta/entities/{tenantId}/{appName}/{entityName}`
 * response, forwarded verbatim. */
export interface DeleteEntityResult {
  readonly entityName: string;
  readonly deleted: boolean;
}

/**
 * `meta.delete_entity` — explicit soft-deletion of the addressed entity.
 * The description stays recoverable from history (FR-008). Deletion is
 * NEVER inferred from an entity's absence anywhere else in this tool
 * surface — there is no batch/set write tool for such an inference to even
 * apply to; a delete only ever happens by calling this tool by name.
 *
 * `expectedVersion` is validated AT RUNTIME here, not merely declared in
 * the TypeScript type: arguments arrive from a language model as untyped
 * JSON, and a compile-time-only declaration would not stop a call that
 * omits it. Deleting without checking the version would be deleting blind
 * something another author may have changed a moment ago — exactly the
 * unreviewed overwrite the whole feature exists to prevent, just via
 * deletion instead of an overwrite.
 */
export const deleteEntityTool: ToolDefinition<DeleteEntityArgs, DeleteEntityResult> = {
  name: "meta.delete_entity",
  kind: "write",
  description: "Explicitly deletes the addressed entity (soft-delete, recoverable from history). Requires expectedVersion.",
  inputSchema: deleteEntityInputSchema,
  handler: async (context, args) => {
    if (typeof args.expectedVersion !== "number") {
      throw new Error(
        "meta.delete_entity requires expectedVersion: deleting without checking the current version " +
          "would risk removing changes another author made since the last read.",
      );
    }
    // T226: see writeEntityTool's handler for why this field is mandatory
    // on every write/delete/rollback body.
    return context.client.write<DeleteEntityResult>(
      `/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}`,
      { expectedVersion: args.expectedVersion, changeSource: "mcp" },
      "DELETE",
    );
  },
};
