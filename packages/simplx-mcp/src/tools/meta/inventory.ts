import type { ToolDefinition } from "../registry.js";

/** One rule violation found while walking every active `app_meta`/
 * `entity_meta` row across every tenant, exactly as the platform's
 * `getMetaInventory` (`platform/src/services/tenant-management/
 * meta-schema-api.ts`) returns it. */
export interface MetaInventoryViolation {
  readonly tenantId: string;
  readonly scope: "app" | "entity";
  readonly appName: string;
  readonly entityName?: string;
  /** JSON-pointer-style path into `config` — same shape `meta.validate`'s
   * error entries use. */
  readonly path: string;
  readonly message: string;
  /** `true` for the `admin`/`host` rows the platform traced as never read
   * by any running consumer — excluded from `tenantViolationCount` on
   * purpose (the raw-count trap `meta-validation-report.ts`'s exit code
   * falls into: nonzero for ANY violation, including annotated
   * non-tenant ones). */
  readonly knownNonTenant: boolean;
  readonly knownNonTenantReason?: string;
}

/** One `valueType` value observed across every field config scanned, and
 * how often. */
export interface MetaInventoryValueTypeCount {
  readonly valueType: string;
  readonly count: number;
}

/**
 * `meta.inventory` result. Forwards the platform's `GET /api/v1/meta/
 * inventory` payload with ONE deliberate change: `tenantViolationCount`
 * is moved to the FIRST field. This is a key-order change only — no
 * value is computed, renamed, or dropped — made because this tool's
 * result becomes an agent's read verbatim via `JSON.stringify` (see
 * `server.ts`'s `registerWithServer`): with `violations` listed first, a
 * long array pushes the one number a caller actually needs to check
 * (real, tenant-scoped violations — NOT `violations.length`, which
 * includes annotated non-tenant rows) out of the part of the response
 * most likely to be read first or truncated to.
 */
export interface MetaInventoryResult {
  readonly tenantViolationCount: number;
  readonly knownNonTenantCount: number;
  readonly violations: readonly MetaInventoryViolation[];
  readonly valueTypes: readonly MetaInventoryValueTypeCount[];
}

/** The platform's own field order — `client.get` unwraps `data` for us,
 * this is exactly the `MetaInventoryResult` shape `meta-schema-api.ts`
 * defines server-side, before this tool reorders it. */
interface PlatformMetaInventoryResult {
  readonly violations: readonly MetaInventoryViolation[];
  readonly tenantViolationCount: number;
  readonly knownNonTenantCount: number;
  readonly valueTypes: readonly MetaInventoryValueTypeCount[];
}

/**
 * `meta.inventory` — a full, on-demand scan of every active meta row
 * across every tenant against the published validation rules: what is
 * broken in the DATABASE right now, not merely what a future write would
 * be rejected for.
 *
 * ONE call: `GET /api/v1/meta/inventory` (T209,
 * `platform/src/services/tenant-management/meta-schema-api.ts`'s
 * `getMetaInventory`). Read-only, no pagination — the platform performs
 * the whole scan server-side and returns it in one response.
 *
 * `tenantViolationCount` is the number to act on: it EXCLUDES rows the
 * platform has classified as known non-tenant (`admin`/`host`). Reading
 * `violations.length` instead reproduces exactly the trap the standalone
 * `meta-validation-report.ts` script's exit code falls into — nonzero for
 * ANY violation, including ones already annotated as not worth acting on.
 *
 * On a platform rejection — a non-editor role (403) or the rules
 * themselves being unavailable (`meta_rules_unavailable`, 503) — this
 * tool does NOT catch, reshape, or fall back to an empty result. The
 * platform's `PlatformApiError` propagates to the caller exactly as
 * received: a diagnostic that cannot actually check must never report
 * "no violations found" for a check it never ran.
 */
export const inventoryTool: ToolDefinition<undefined, MetaInventoryResult> = {
  name: "meta.inventory",
  kind: "read",
  description:
    "Full scan of every active meta row across every tenant against the published rules. Read tenantViolationCount first — it excludes rows already known non-tenant; violations.length does not. A platform error (e.g. rules unavailable) surfaces as a tool error, never a silent empty result.",
  // LAB-257 T243: genuinely zero-argument — a full, unfiltered,
  // unpaginated scan (see the doc comment above).
  inputSchema: {},
  handler: async (context) => {
    const result = await context.client.get<PlatformMetaInventoryResult>("/api/v1/meta/inventory");
    return {
      tenantViolationCount: result.tenantViolationCount,
      knownNonTenantCount: result.knownNonTenantCount,
      violations: result.violations,
      valueTypes: result.valueTypes,
    };
  },
};
