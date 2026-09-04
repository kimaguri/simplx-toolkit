import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
// src/tools/meta/inspect.ts does not exist yet (T053) — this import is
// expected to fail to resolve, which is the correct RED reason for T047
// (tool absent), not a typo in this test file.
import { diffTool, validateTool } from "../src/tools/meta/inspect.js";

/**
 * LAB-257 T047 — contract tests for `meta.diff` and `meta.validate`,
 * written BEFORE their implementation (T053, `src/tools/meta/inspect.ts`).
 *
 * The absence of side effects IS the point of both tools (US3 scenario 3):
 * they exist so an author can inspect a proposed change before committing
 * to it. If either tool can reach a write, "let me check first" quietly
 * becomes "let me change it and see", and the entire safety story this
 * feature is built on is gone. Every test below that checks for "no writes"
 * asserts on the write HTTP METHOD never reaching the client mock — not on
 * the absence of a specific named endpoint — so a future implementation
 * cannot sneak a write through under a different path.
 *
 * `meta.validate`'s load-bearing fact (R16, FR-010, FR-016): the verdict
 * MUST come from the platform's `POST /api/v1/meta/validate`, never from a
 * locally re-implemented JSON Schema check. The decisive test below makes
 * the mocked server reject a config that would pass any plausible local
 * sanity check, and asserts the tool's verdict follows the server anyway —
 * a local-rules implementation would never even touch the client mock, or
 * would touch it and then override the answer; either way this test fails
 * for one of those two implementations and passes only for a true forward.
 *
 * `meta.diff`'s load-bearing fact: the comparison base is `raw`, the
 * stored form — never `resolved`, the template-assembled view. Diffing
 * against `resolved` would report every inherited field the entity does
 * not carry in `raw` as a "removed" difference, and inviting the author to
 * "fix" that is exactly the flattening the raw/resolved split exists to
 * prevent.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface.
 *
 * T163: `diff`'s fixtures pass the ALREADY-UNWRAPPED entity payload to
 * `makeFakeClient` — matching what `client.get()` resolves to in reality
 * (T050's `platform-client.ts` unwraps the platform's `{ data, message }`
 * envelope itself). `validate`'s `makeValidateClient` already did this
 * correctly and needed no change — confirmed, not assumed, per T163.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

/**
 * A `PlatformClient` double whose `get` responses are keyed by exact path,
 * and whose `write` (and any non-GET `request`) ALWAYS throws — `diff` and
 * `validate` are read/inspect-only, so this double turns any accidental
 * write attempt into an immediate, loud test failure instead of a silent
 * pass.
 */
const makeFakeClient = (getResponses: Record<string, unknown>): PlatformClient => {
  const get = vi.fn(async (path: string) => {
    if (!(path in getResponses)) {
      throw new Error(`fake platform client: unexpected GET ${path}`);
    }
    return getResponses[path];
  });
  const write = vi.fn(async (path: string, _body: unknown, method = "POST") => {
    throw new Error(`fake platform client: inspect-only tool attempted a write — ${method} ${path}`);
  });
  const request = vi.fn(async (options: { method?: string; path: string }) => {
    if (!options.method || options.method === "GET") return get(options.path);
    return write(options.path, undefined, options.method);
  });
  return { get, write, request } as unknown as PlatformClient;
};

/**
 * A double that additionally answers `POST /api/v1/meta/validate` — used
 * only by the `meta.validate` tests, which is the one legitimate case where
 * this tool set issues a POST (validating is not writing: nothing is
 * stored). Everything else — actual mutation methods reaching any OTHER
 * path — still throws.
 */
const makeValidateClient = (validateResponse: unknown): PlatformClient => {
  const get = vi.fn(async (path: string) => {
    throw new Error(`fake platform client: meta.validate must not issue any GET — ${path}`);
  });
  const write = vi.fn(async (path: string, body: unknown, method = "POST") => {
    if (path === "/api/v1/meta/validate" && method === "POST") return validateResponse;
    throw new Error(`fake platform client: unexpected ${method} ${path}`);
  });
  const request = vi.fn(async (options: { method?: string; path: string; body?: unknown }) => {
    if (!options.method || options.method === "GET") return get(options.path);
    return write(options.path, options.body, options.method);
  });
  return { get, write, request } as unknown as PlatformClient;
};

const makeContext = (client: PlatformClient, useProdProfile = false): ToolContext => ({
  profile: useProdProfile ? createProdProfile(CONNECTION) : createTestProfile(CONNECTION),
  client,
});

/** No test pins one exact field name for "the violations list" (per the
 * task: "do not pin a shape more specific than locations are carried
 * through, not flattened into prose") — this reads whichever of the
 * plausible names an implementation used, the same fallback style already
 * used for version-conflict details in T046. */
const readViolations = (result: any): unknown[] | undefined => result?.errors ?? result?.violations ?? result?.data?.errors;

describe("meta.diff — LAB-257 T047 (US3 scenario 3, shown BEFORE applying)", () => {
  const TENANT = "tenant-acme";
  const APP = "intellhouse";
  const ENTITY = "contacts";
  const ENTITY_PATH = `/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`;

  it('is registered under the contract name "meta.diff"', () => {
    expect(diffTool.name).toBe("meta.diff");
  });

  it("issues only reads — no write method reaches the client at all", async () => {
    const raw = { entityName: ENTITY, basedOn: "contacts", overrides: {} };
    const resolved = { entityName: ENTITY, fields: { name: { type: "string" } } }; // irrelevant to this test
    const client = makeFakeClient({ [ENTITY_PATH]: { entityName: ENTITY, version: 7, resolved, raw } });

    await diffTool.handler(makeContext(client), {
      tenant: TENANT,
      app: APP,
      entity: ENTITY,
      proposedConfig: { entityName: ENTITY, basedOn: "contacts", overrides: { fields: { inn: {} } } },
    });

    expect(client.write).not.toHaveBeenCalled();
  });

  it("diffs against RAW, not resolved — inherited fields present only in resolved must never appear as differences", async () => {
    // `resolved` carries a large set of template-assembled fields that
    // `raw` never mentions (they come from the template, not the entity's
    // own config). A diff computed against `resolved` would report every
    // one of them as "removed" the moment the author's proposal doesn't
    // repeat them verbatim — exactly the flattening raw/resolved exists to
    // prevent.
    const raw = { entityName: ENTITY, basedOn: "contacts", overrides: { fields: { inn: { required: false } } } };
    const resolved = {
      entityName: ENTITY,
      fields: {
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        inn: { type: "string", required: false },
      },
      list: { columns: ["name", "phone", "email", "inn"] },
    };
    const client = makeFakeClient({ [ENTITY_PATH]: { entityName: ENTITY, version: 7, resolved, raw } });

    // The author's ONLY intended change: flip inn.required to true. This
    // proposal is shaped like `raw` (basedOn + overrides), not `resolved`.
    const proposedConfig = { entityName: ENTITY, basedOn: "contacts", overrides: { fields: { inn: { required: true } } } };

    const result = await diffTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY, proposedConfig });

    const diffText = JSON.stringify(result);
    // The one real change is present...
    expect(diffText).toContain("required");
    // ...but none of resolved's template-only fields (never mentioned in
    // raw or in the proposal) leak in as spurious differences.
    expect(diffText).not.toContain("phone");
    expect(diffText).not.toContain("email");
    expect(diffText).not.toContain('"columns"');
  });

  it("works on the prod profile — reads are never profile-gated", async () => {
    const raw = { entityName: ENTITY };
    const client = makeFakeClient({ [ENTITY_PATH]: { entityName: ENTITY, version: 1, resolved: raw, raw } });

    await expect(
      diffTool.handler(makeContext(client, true), { tenant: TENANT, app: APP, entity: ENTITY, proposedConfig: raw }),
    ).resolves.toBeDefined();
  });
});

describe("meta.validate — LAB-257 T047 (R16, FR-010, FR-011, FR-012, FR-016)", () => {
  it('is registered under the contract name "meta.validate"', () => {
    expect(validateTool.name).toBe("meta.validate");
  });

  it("issues only a single POST to /api/v1/meta/validate — never a write, never more than one call", async () => {
    const config = { entityName: "contacts", fields: {} };
    const client = makeValidateClient({ valid: true, mode: "block", wouldBlock: false, errors: [] });

    await validateTool.handler(makeContext(client), { config, kind: "entity" });

    expect((client.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((client.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("/api/v1/meta/validate");
    expect((client.get as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("forwards config and kind in the request body, unmodified", async () => {
    const config = { entityName: "contacts", fields: { inn: { valueType: "string" } } };
    const client = makeValidateClient({ valid: true, mode: "block", wouldBlock: false, errors: [] });

    await validateTool.handler(makeContext(client), { config, kind: "entity" });

    const body = (client.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(body).toMatchObject({ config, kind: "entity" });
  });

  it("`kind` is optional per the contract", async () => {
    const config = { pluginConfigs: {} };
    const client = makeValidateClient({ valid: true, mode: "block", wouldBlock: false, errors: [] });

    await expect(validateTool.handler(makeContext(client), { config })).resolves.toBeDefined();
  });

  it("LOAD-BEARING: the verdict follows the SERVER's answer, even for a config that would pass any plausible local sanity check", async () => {
    // A config with all the fields a naive/local schema check would accept
    // — well-typed, no obviously missing keys. The mocked server rejects it
    // anyway for a reason only server-side cross-field/business rules would
    // know about. If `meta.validate` held its own rules copy, it would
    // either never reach the client at all (caught by the call-count
    // assertion below) or report `valid: true` regardless of what the
    // server said (caught by the assertion on the verdict itself).
    const plausibleLookingConfig = {
      entityName: "contacts",
      fields: { name: { valueType: "string" }, inn: { valueType: "string" } },
    };
    const serverErrors = [{ path: "/fields/inn/valueType", message: "duplicate INN validator already defined on the template" }];
    const client = makeValidateClient({ valid: false, mode: "block", wouldBlock: true, errors: serverErrors });

    const result = await validateTool.handler(makeContext(client), { config: plausibleLookingConfig, kind: "entity" });

    expect((client.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((result as { valid: boolean }).valid).toBe(false);
    const violations = readViolations(result);
    expect(violations).toBeDefined();
    expect(violations).toHaveLength(1);
  });

  it("carries violation LOCATIONS through distinctly — never flattened into a single prose string", async () => {
    // Same identity a rejected write would carry (T042). This test only
    // asserts the location and the message survive as two separately
    // reachable pieces of information — it does NOT pin which field name
    // the tool exposes them under.
    const serverErrors = [{ path: "/fields/form/fields/0/valueType", message: "unknown valueType \"currency\"" }];
    const client = makeValidateClient({ valid: false, mode: "block", wouldBlock: true, errors: serverErrors });

    const result = await validateTool.handler(makeContext(client), { config: { entityName: "contacts" }, kind: "entity" });

    const violations = readViolations(result);
    expect(violations).toBeDefined();
    const [violation] = violations as any[];
    expect(typeof violation).not.toBe("string");
    const serialized = JSON.stringify(violation);
    expect(serialized).toContain("/fields/form/fields/0/valueType");
    expect(serialized).toContain("unknown valueType");
  });

  it("works on the prod profile — reads/inspections are never profile-gated", async () => {
    const client = makeValidateClient({ valid: true, mode: "block", wouldBlock: false, errors: [] });

    await expect(
      validateTool.handler(makeContext(client, true), { config: { entityName: "contacts" }, kind: "entity" }),
    ).resolves.toBeDefined();
  });
});
