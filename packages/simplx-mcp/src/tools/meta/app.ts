import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import { expectedVersionOnUpdateDescription } from "./write.js";

/**
 * The tenant-level app description shape (contracts/meta-write-api.md,
 * "Описание приложения" / `AppMetaConfig` on the platform,
 * `platform/src/services/tenant-management/meta-apps-api.ts`): connected
 * plugins and their settings, general app settings, notification settings.
 *
 * Deliberately does NOT carry the set of entities (that's defined by which
 * entity descriptions exist under this app) or the built navigation ITEMS
 * (those come from each entity's own route config) — only `menu`, which is
 * live: `simplx-core/core-ui/src/app/app-root/index.tsx` feeds it to
 * `applyMenuGrouping` to decide which sidebar SECTION each item lands in.
 * Stripping or reshaping it here would flatten the sidebar for every
 * tenant that groups its navigation.
 */
export interface AppMetaConfig {
  readonly menu?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly path: string;
    readonly icon?: string;
  }>;
  readonly customRoutes?: ReadonlyArray<Record<string, unknown>>;
  readonly plugins?: readonly string[];
  readonly pluginConfigs?: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
  readonly notifications?: Record<string, unknown>;
}

/** Input for {@link getAppTool}. */
export interface GetAppArgs {
  readonly tenant: string;
  readonly app: string;
}

/** {@link GetAppArgs} as a Zod raw shape — becomes this tool's JSON Schema
 * (LAB-257 T243). */
export const getAppInputSchema = {
  tenant: z.string().describe("Tenant id, as returned by meta.list_apps."),
  app: z.string().describe("App name, as returned by meta.list_apps."),
} satisfies z.ZodRawShape;

/**
 * `GET /api/v1/meta/apps/{tenantId}/{appName}` response, forwarded verbatim
 * — mirrors the platform's `readAppMeta` result
 * (`platform/src/services/tenant-management/meta-apps-api.ts`) exactly.
 */
export interface GetAppResult {
  readonly appName: string;
  readonly version: number;
  readonly config: AppMetaConfig;
}

/**
 * `meta.get_app` — the addressed app's own description: its version and
 * `config` (plugins, plugin settings, general settings, notifications,
 * `menu`). Versioned SEPARATELY from the app's entities (FR-044) — this
 * tool never touches `/api/v1/meta/entities/*`, and never the tenant-wide
 * listing `/api/v1/meta/apps/tenant/{tenantId}` that `meta.list_apps` uses.
 *
 * A pure forward of the platform's response: no local rules logic, no
 * version arithmetic, nothing reshaped.
 */
export const getAppTool: ToolDefinition<GetAppArgs, GetAppResult> = {
  name: "meta.get_app",
  kind: "read",
  description: "The addressed app's own description: its version and config (plugins, settings, notifications, menu) — versioned separately from its entities.",
  inputSchema: getAppInputSchema,
  handler: async (context, args) =>
    context.client.get<GetAppResult>(`/api/v1/meta/apps/${args.tenant}/${args.app}`),
};

/** Input for {@link writeAppTool}. */
export interface WriteAppArgs {
  readonly tenant: string;
  readonly app: string;
  /** Omit to CREATE the app description at version 1 — the same call
   * handles both create and update, same convention as
   * `meta.write_entity`. Present, it must match the platform's current
   * version exactly or the write is rejected as a conflict. */
  readonly expectedVersion?: number | undefined;
  readonly config: unknown;
  readonly changeReason?: string | undefined;
}

/** {@link WriteAppArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (T241): `expectedVersion` stays optional (creation has no version
 * to give), but its `.describe()` spells out when omitting it is wrong. */
export const writeAppInputSchema = {
  tenant: z.string(),
  app: z.string(),
  expectedVersion: z.number().optional().describe(expectedVersionOnUpdateDescription("meta.get_app")),
  config: z.unknown(),
  changeReason: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * `POST /api/v1/meta/apps/{tenantId}/{appName}` response, forwarded
 * verbatim — mirrors the platform's `writeAppMeta` result exactly,
 * including `unknownComponents` (a warning that never affects whether the
 * write succeeded, same convention as `meta.write_entity`'s).
 */
export interface WriteAppResult {
  readonly version: number;
  readonly appName: string;
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * `meta.write_app` — writes (creates or updates) the addressed app
 * description. Exactly ONE call to the platform, no separate publish step,
 * and no pre-fetch to compute anything — `expectedVersion` is whatever the
 * caller already has from its own last `meta.get_app`, and the returned
 * `version` is whatever the platform's own optimistic-concurrency check
 * actually produced, never `expectedVersion + 1` computed here.
 *
 * `config.menu` is forwarded UNCHANGED, never stripped, rejected, or
 * validated against a local copy of the rules. `menu` is live: it drives
 * which sidebar SECTION each navigation item is grouped into
 * (`applyMenuGrouping` in `simplx-core/core-ui/src/app/app-root/index.tsx`)
 * — the items themselves come from each entity's own route config and
 * never read `menu` at all, but the grouping does, for every tenant that
 * groups its navigation.
 *
 * On a version conflict, on a rule violation, or on the production write
 * refusal for the automatic author, this tool does NOT catch, reshape, or
 * retry — the platform's rejection (`PlatformApiError`) propagates to the
 * caller exactly as the platform sent it, `details.params.currentVersion`
 * included. There is no retry-on-the-agent's-behalf here: recovery from a
 * conflict is always `meta.get_app` (re-read), edit `config` again, then
 * call this tool again with the fresh `expectedVersion` — an automatic
 * retry with a silently refetched version would BE the unreviewed
 * overwrite this whole feature exists to prevent, dressed up as a
 * convenience.
 */
export const writeAppTool: ToolDefinition<WriteAppArgs, WriteAppResult> = {
  name: "meta.write_app",
  kind: "write",
  description: "Writes (creates or updates) the addressed app description. This IS publication — the change is live once this call succeeds. menu is forwarded unchanged; it drives sidebar section grouping.",
  inputSchema: writeAppInputSchema,
  handler: async (context, args) => {
    // T226: see `meta.write_entity`'s handler (`tools/meta/write.ts`) for
    // why this field is mandatory on every write/delete/rollback body.
    const body: Record<string, unknown> = { config: args.config, changeSource: "mcp" };
    if (args.expectedVersion !== undefined) body.expectedVersion = args.expectedVersion;
    if (args.changeReason !== undefined) body.changeReason = args.changeReason;
    return context.client.write<WriteAppResult>(
      `/api/v1/meta/apps/${args.tenant}/${args.app}`,
      body,
    );
  },
};
