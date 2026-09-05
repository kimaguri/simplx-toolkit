/**
 * The `Connection` a running MCP server needs to reach the SimplX platform.
 */
export interface Connection {
  baseUrl: string;
  tenantSlug: string;
  bearerToken: string;
}

/**
 * Reads the platform connection out of a process-env-shaped object.
 *
 * `tenantSlug` is NOT a statement that this server is scoped to a single
 * tenant: every tool call takes its own tenant parameter. This env var only
 * supplies the `X-Tenant-Slug` header the platform requires for
 * service-to-service authentication when the server talks to the platform
 * API on the caller's behalf.
 *
 * `SIMPLX_AUTH_TENANT_SLUG` is the preferred variable name; the legacy
 * `SIMPLX_TENANT_SLUG` name is still accepted as a fallback for backward
 * compatibility (LAB-272 FR-012, research R9).
 *
 * Pure: reads only from the `env` argument and never touches `process.env`.
 */
export const readConnectionFromEnv = (env: NodeJS.ProcessEnv): Connection => {
  const baseUrl = env["SIMPLX_PLATFORM_URL"];
  if (!baseUrl) {
    throw new Error("missing required environment variable: SIMPLX_PLATFORM_URL");
  }

  const tenantSlug = env["SIMPLX_AUTH_TENANT_SLUG"] ?? env["SIMPLX_TENANT_SLUG"];
  if (!tenantSlug) {
    throw new Error(
      "missing required environment variable: SIMPLX_AUTH_TENANT_SLUG (or legacy SIMPLX_TENANT_SLUG)",
    );
  }

  const bearerToken = env["SIMPLX_BEARER_TOKEN"];
  if (!bearerToken) {
    throw new Error("missing required environment variable: SIMPLX_BEARER_TOKEN");
  }

  return { baseUrl, tenantSlug, bearerToken };
};
