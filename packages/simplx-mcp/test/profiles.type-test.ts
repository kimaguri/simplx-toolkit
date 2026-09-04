import { describe, expect, it } from "vitest";
import { createPlatformClient } from "../src/client/index.js";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import { createToolRegistry } from "../src/tools/index.js";

/**
 * Proves the compile-time write boundary from criterion 4.
 *
 * A runtime test cannot prove this — a runtime check (`if (profile.name ===
 * "prod") throw`) would also pass a runtime assertion, and that is exactly
 * the pattern this design forbids. The proof has to happen at `tsc` time.
 *
 * The proof: `registerWriteTool` takes `WriteCapableProfile`, not `Profile`.
 * Passing a `ProdProfile` (below) is a type error that `tsc --noEmit`
 * reports, and `@ts-expect-error` requires that error to be present — if a
 * future change to `registry.ts` accidentally widened the parameter type to
 * accept `ProdProfile`, the missing error would itself fail `tsc --noEmit`
 * (an unused `@ts-expect-error` is a compiler error). So this file's mere
 * presence in the type-checked project is the regression guard.
 */
describe("write-capability compile-time boundary", () => {
  it("rejects a prod profile at the type level (see @ts-expect-error below)", () => {
    const connection = {
      baseUrl: "https://platform.example.test",
      tenantSlug: "acme",
      bearerToken: "token",
    };

    const prodProfile = createProdProfile(connection);
    const testProfile = createTestProfile(connection);
    const registry = createToolRegistry();
    const dummyTool = {
      name: "dummy",
      description: "dummy",
      kind: "write" as const,
      inputSchema: {},
      handler: async () => undefined,
    };

    // @ts-expect-error ProdProfile has no `write` member: it does not satisfy
    // WriteCapableProfile, so this must be a compile error, not a runtime throw.
    registry.registerWriteTool(prodProfile, dummyTool);

    // A test profile satisfies WriteCapableProfile and compiles fine.
    registry.registerWriteTool(testProfile, dummyTool);

    expect(registry.get("dummy")).toBeDefined();
  });

  it("still lets a prod profile run through the read-only client", () => {
    const prodProfile = createProdProfile({
      baseUrl: "https://platform.example.test",
      tenantSlug: "acme",
      bearerToken: "token",
    });
    const client = createPlatformClient(prodProfile);

    expect(typeof client.get).toBe("function");
    expect(typeof client.write).toBe("function");
  });
});
