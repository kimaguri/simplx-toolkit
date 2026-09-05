import { describe, expect, it } from "vitest";
import { readConnectionFromEnv } from "../src/env.js";
import { SERVER_INSTRUCTIONS } from "../src/knowledge/instructions.js";

/**
 * LAB-272 T044 — `readConnectionFromEnv()` must accept the new
 * SIMPLX_AUTH_TENANT_SLUG env var name while remaining backward compatible
 * with the legacy SIMPLX_TENANT_SLUG name (spec FR-012, research R9).
 *
 * Tenant is a parameter of every tool call already; the env var is only
 * used to build the `X-Tenant-Slug` service-to-service auth header, so the
 * rename is purely about naming clarity, not about a single-tenant server.
 */
describe("readConnectionFromEnv (LAB-272 T044)", () => {
  it("reads SIMPLX_AUTH_TENANT_SLUG as tenantSlug when set", () => {
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_AUTH_TENANT_SLUG: "acme",
      SIMPLX_BEARER_TOKEN: "t",
    };
    const connection = readConnectionFromEnv(env);
    expect(connection).toEqual({
      baseUrl: "https://platform.example",
      tenantSlug: "acme",
      bearerToken: "t",
    });
  });

  it("falls back to the legacy SIMPLX_TENANT_SLUG when the new name is absent", () => {
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_TENANT_SLUG: "legacy-acme",
      SIMPLX_BEARER_TOKEN: "t",
    };
    const connection = readConnectionFromEnv(env);
    expect(connection.tenantSlug).toBe("legacy-acme");
  });

  it("prefers SIMPLX_AUTH_TENANT_SLUG when both the new and legacy names are set", () => {
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_AUTH_TENANT_SLUG: "new-acme",
      SIMPLX_TENANT_SLUG: "legacy-acme",
      SIMPLX_BEARER_TOKEN: "t",
    };
    const connection = readConnectionFromEnv(env);
    expect(connection.tenantSlug).toBe("new-acme");
  });

  it("throws naming both variable names when neither tenant slug env var is set", () => {
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_BEARER_TOKEN: "t",
    };
    expect(() => readConnectionFromEnv(env)).toThrowError(/SIMPLX_AUTH_TENANT_SLUG/);
    expect(() => readConnectionFromEnv(env)).toThrowError(/SIMPLX_TENANT_SLUG/);
  });

  it("throws naming SIMPLX_PLATFORM_URL when it is missing", () => {
    const env = {
      SIMPLX_AUTH_TENANT_SLUG: "acme",
      SIMPLX_BEARER_TOKEN: "t",
    };
    expect(() => readConnectionFromEnv(env)).toThrowError(/SIMPLX_PLATFORM_URL/);
  });

  it("throws naming SIMPLX_BEARER_TOKEN when it is missing", () => {
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_AUTH_TENANT_SLUG: "acme",
    };
    expect(() => readConnectionFromEnv(env)).toThrowError(/SIMPLX_BEARER_TOKEN/);
  });

  it("is pure: does not read or mutate process.env", () => {
    const originalEnv = { ...process.env };
    const env = {
      SIMPLX_PLATFORM_URL: "https://platform.example",
      SIMPLX_AUTH_TENANT_SLUG: "acme",
      SIMPLX_BEARER_TOKEN: "t",
    };
    readConnectionFromEnv(env);
    expect(process.env).toEqual(originalEnv);
  });
});

/**
 * LAB-272 T046 tracker (may currently pass or fail; T046 owns making it green).
 * Server instructions must reflect that tenant is a per-call parameter, not
 * something the server itself is scoped to.
 */
describe("SERVER_INSTRUCTIONS tenant-parameter wording (LAB-272 T046 tracker)", () => {
  it("does not claim the server is scoped to a single tenant, and mentions tenant is a call parameter", () => {
    const lower = SERVER_INSTRUCTIONS.toLowerCase();
    expect(lower).not.toContain("which tenant this server");
    expect(lower).not.toContain("один арендатор");
    expect(lower).toMatch(/parameter|параметр/);
  });
});
