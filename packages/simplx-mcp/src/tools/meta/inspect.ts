import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import type { GetEntityResult } from "./read.js";

/** Input for {@link validateTool}. */
export interface ValidateArgs {
  readonly config: unknown;
  /** Which shape `config` claims to be — omit to validate against whichever
   * the platform infers. Optional per the contract. */
  readonly kind?: "entity" | "template" | undefined;
}

/** {@link ValidateArgs} as a Zod raw shape — becomes this tool's JSON
 * Schema (LAB-257 T243). */
export const validateInputSchema = {
  config: z.unknown().describe(
    "The description to check against the published rules — an entity's raw config " +
      "(same shape as meta.get_entity's raw / meta.write_entity's config) or a template's config.",
  ),
  kind: z
    .enum(["entity", "template"])
    .optional()
    .describe(
      "Which shape config claims to be. Omit to validate as an entity description — the platform's default (LAB-257 T253).",
    ),
} satisfies z.ZodRawShape;

/**
 * `POST /api/v1/meta/validate` response, forwarded verbatim. Field shapes
 * mirror the platform's `ValidateMetaConfigResponse`
 * (`platform/src/services/tenant-management/meta-schema-api.ts`) exactly —
 * this tool does not filter, rename, or drop anything the platform sends.
 */
export interface ValidateResult {
  readonly valid: boolean;
  /** Current server enforcement mode this check ran under (FR-015). */
  readonly mode: string;
  /** Whether an actual write with this config would be refused right now. */
  readonly wouldBlock: boolean;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** Unknown component references (T146, FR-030) — ALWAYS a warning,
   * independent of `valid`/`wouldBlock`: never affects the verdict. */
  readonly unknownComponents: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * `meta.validate` — checks a description against the published rules
 * WITHOUT writing it.
 *
 * A call to `POST /api/v1/meta/validate` and NOTHING else (R16, FR-010,
 * FR-016): no local JSON Schema check, no embedded copy of the rules, no
 * re-derivation of the verdict from `config` itself. A second rules
 * implementation in another library would inevitably drift from the
 * platform's own — the entire reason this tool is a network call and not a
 * local function.
 */
export const validateTool: ToolDefinition<ValidateArgs, ValidateResult> = {
  name: "meta.validate",
  // Uses client.write() at the transport level (a POST body is required to
  // send `config`) but persists nothing — the contract is explicit this is
  // a check, not a write (`meta-schema-api.ts`'s handler carries no
  // permission gate a real write would). Declared "read" on THAT basis,
  // not on which client method it happens to call — see `ToolKind`'s doc
  // comment in `registry.ts` for why the latter is not a valid proxy.
  kind: "read",
  description:
    "Checks a description against the published rules without writing it — either valid, or the violations with their locations (path + message). unknownComponents is a WARNING about componentName values the core-ui list does not know (tenant-scoped `tenant/Name` and plugin components are never checked) — do not delete keys to silence it. Call before every write.",
  inputSchema: validateInputSchema,
  handler: async (context, args) =>
    context.client.write<ValidateResult>("/api/v1/meta/validate", { config: args.config, kind: args.kind }),
};

/** Input for {@link diffTool}. */
export interface DiffArgs {
  readonly tenant: string;
  readonly app: string;
  readonly entity: string;
  readonly proposedConfig: unknown;
}

/** {@link DiffArgs} as a Zod raw shape — becomes this tool's JSON Schema
 * (LAB-257 T243). */
export const diffInputSchema = {
  tenant: z.string().describe("Tenant id, as returned by meta.list_apps."),
  app: z.string().describe("App name, as returned by meta.list_apps."),
  entity: z.string().describe("Entity name, as listed under this app by meta.list_apps."),
  proposedConfig: z.unknown().describe(
    "The edited config to compare against the entity's current stored raw state — same shape " +
      "as meta.get_entity's raw / meta.write_entity's config.",
  ),
} satisfies z.ZodRawShape;

/** One difference between the stored `raw` config and the proposal. */
export interface DiffEntry {
  /** JSON-pointer-style path into the config, matching the location
   * convention `meta.validate`'s `errors`/`unknownComponents` already use
   * (`platform/src/lib/validation/meta-rules.ts`'s `MetaValidationError`),
   * so the two tools' output reads consistently. Root is "/". */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Is `value` a container `diffConfigs` should recurse into (a plain
 * object or an array) rather than compare atomically? */
const isContainer = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

/**
 * Structural diff between two arbitrary JSON values — a generic utility,
 * not a rule about permissible structure (R16 governs the SHAPE of a
 * config, not whether two of them differ). Walks both sides key-by-key
 * (uniformly for plain objects and arrays — `Object.keys` on an array
 * yields its numeric indices), recursing into shared containers and
 * reporting a leaf entry wherever the two sides stop being both
 * containers or stop being structurally identical.
 *
 * Deliberately consults NOTHING beyond `before`/`after` themselves: no
 * schema, no `kind`, no version, no validity judgment. That boundary is
 * what keeps this a "generic utility" rather than a second, drifting
 * rules implementation — `meta.validate` (above) is the ONLY place that
 * decides what's valid.
 */
const diffConfigs = (before: unknown, after: unknown, path = ""): DiffEntry[] => {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  if (isContainer(before) && isContainer(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const entries: DiffEntry[] = [];
    for (const key of keys) {
      entries.push(...diffConfigs(before[key], after[key], `${path}/${key}`));
    }
    return entries;
  }
  return [{ path: path || "/", before, after }];
};

/**
 * `meta.diff` — the differences between a proposed description and the
 * entity's current stored state, shown BEFORE applying (US3 scenario 3).
 *
 * Computed HERE in the tools server, not on the platform (contract
 * decision, meta-tools.md) — one `GET` on the same entity endpoint
 * `meta.get_entity` uses, then a local structural comparison. Issues ONLY
 * that one read: no write method ever reaches the client (asserted at the
 * transport level, not merely "no write endpoint exists").
 *
 * Compares the proposal against `raw`, the stored form — NEVER `resolved`,
 * the template-assembled view. `resolved` carries fields the entity's own
 * `raw` never mentions (inherited from a template); diffing against it
 * would report every one of those as a "removed" local change the moment
 * the proposal doesn't repeat them verbatim, inviting the author to "fix"
 * that by copying the template into the entity — precisely the flattening
 * the `raw`/`resolved` split exists to prevent.
 */
export const diffTool: ToolDefinition<DiffArgs, DiffEntry[]> = {
  name: "meta.diff",
  kind: "read",
  description:
    "Differences between a proposed entity description and its current stored raw state, as path-level entries (before/after). Use it to confirm only the intended paths change before meta.write_entity; the comparison base is raw, never resolved.",
  inputSchema: diffInputSchema,
  handler: async (context, args) => {
    const current = await context.client.get<GetEntityResult>(
      `/api/v1/meta/entities/${args.tenant}/${args.app}/${args.entity}`,
    );
    return diffConfigs(current.raw, args.proposedConfig);
  },
};
