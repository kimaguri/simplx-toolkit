import { describe, expect, it } from "vitest";
import { createProdProfile, createTestProfile } from "../src/profiles/index.js";
import { createToolRegistry } from "../src/tools/index.js";
// None of these three modules exist yet — this import is expected to fail
// to resolve until T054 (write_entity/delete_entity), T126 (write_app), and
// T090 (write_template) land. Same absent-module RED as T046's write.test.ts.
import { deleteEntityTool, writeEntityTool } from "../src/tools/meta/write.js";
import { writeAppTool } from "../src/tools/meta/app.js";
import { writeTemplateTool } from "../src/tools/meta/templates.js";
import { rollbackTool } from "../src/tools/meta/history.js";
import { promotePreviewTool, promoteTool } from "../src/tools/meta/promote.js";

/**
 * LAB-257 T048, half 1/2 — the COMPILE-TIME half.
 *
 * `test/profiles.type-test.ts` already proves `registerWriteTool` rejects
 * `ProdProfile` for one anonymous dummy tool — that generic proof extends to
 * ANY tool by construction of `registerWriteTool`'s own signature
 * (`WriteCapableProfile`, not `Profile`), so it is not repeated here.
 *
 * What THIS file adds: the proof tied to the five ACTUAL write tools named
 * in the contract (`meta.write_entity`, `meta.delete_entity`,
 * `meta.write_app`, `meta.write_template`, `meta.rollback`) instead of an
 * anonymous stand-in — so a reviewer reading `tsc`'s output for THIS file
 * sees the real tool names the contract cares about, not a placeholder.
 * `meta.rollback` (T055) landed after this file's first two `it` blocks
 * were written; a third was added rather than silently leaving it out —
 * the same staleness `test/profiles.test.ts`'s `WRITE_TOOL_NAMES` had
 * (LAB-257 T162).
 *
 * A runtime check (`if (profile.name === "prod") throw`) would also satisfy
 * a runtime assertion — that is exactly the pattern this design forbids
 * (T048's framing: "not the write tool refuses on prod" but "on the prod
 * profile the write tools are not offered at all"). The proof has to
 * happen at `tsc` time: `@ts-expect-error` demands the compiler produce an
 * error on the line below it; if `registerWriteTool`'s parameter type were
 * ever accidentally widened to accept `ProdProfile`, the now-missing error
 * would itself fail `tsc --noEmit` (an unused `@ts-expect-error` is a
 * compiler error) — so this file's mere presence in the type-checked
 * project (see CLAUDE traps: tsconfig does NOT exclude `test/`, only
 * `src/**\/*.test.ts` on the platform side; this package's `tsconfig.json`
 * checks `test/` directly) is the regression guard.
 *
 * HONEST LIMIT (asked for explicitly by T048): this file, like
 * `profiles.type-test.ts`, proves `registerWriteTool` itself cannot accept
 * a prod profile for these four tools. It does NOT and CANNOT prove the
 * runtime tool-list ASSEMBLY (T056, wiring these tools into
 * `createSimplxMcpServer`) actually calls `registerWriteTool` for them
 * rather than, say, looping over every tool and filtering by name via
 * `registerReadTool` for all of them regardless of profile — a
 * name-based denylist would compile fine (it never touches
 * `registerWriteTool` at all) and could still produce a correct-looking
 * prod tool list today while silently missing the next write tool someone
 * adds tomorrow. That failure mode is only observable by what the
 * assembled server actually returns from `tools/list` — see
 * `test/profiles.test.ts`'s runtime half, which is the actual check for
 * "not a hardcoded denylist" as far as a black-box test can go: it re-runs
 * the same assertion against the CURRENT four named tools, so if T056 is
 * ever re-implemented as a denylist, this compile-time file still passes
 * (a denylist doesn't touch `registerWriteTool`) but a naming-based
 * approach with a stale list is caught the moment someone forgets to
 * update it — the type-checked call site here is enforcement, the
 * runtime file is the observable proof of what the agent actually sees.
 */
describe("write-capability compile-time boundary — named write tools (LAB-257 T048)", () => {
  it("rejects a prod profile for meta.write_entity and meta.delete_entity at the type level", () => {
    const connection = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };
    const prodProfile = createProdProfile(connection);
    const testProfile = createTestProfile(connection);
    const registry = createToolRegistry();

    // @ts-expect-error ProdProfile has no `write` member — meta.write_entity
    // cannot be registered against it, must be a compile error.
    registry.registerWriteTool(prodProfile, writeEntityTool);
    // @ts-expect-error same for meta.delete_entity.
    registry.registerWriteTool(prodProfile, deleteEntityTool);

    registry.registerWriteTool(testProfile, writeEntityTool);
    registry.registerWriteTool(testProfile, deleteEntityTool);

    expect(registry.get(writeEntityTool.name)).toBeDefined();
    expect(registry.get(deleteEntityTool.name)).toBeDefined();
  });

  it("rejects a prod profile for meta.write_app and meta.write_template at the type level", () => {
    const connection = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };
    const prodProfile = createProdProfile(connection);
    const testProfile = createTestProfile(connection);
    const registry = createToolRegistry();

    // @ts-expect-error ProdProfile has no `write` member — meta.write_app
    // cannot be registered against it, must be a compile error.
    registry.registerWriteTool(prodProfile, writeAppTool);
    // @ts-expect-error same for meta.write_template.
    registry.registerWriteTool(prodProfile, writeTemplateTool);

    registry.registerWriteTool(testProfile, writeAppTool);
    registry.registerWriteTool(testProfile, writeTemplateTool);

    expect(registry.get(writeAppTool.name)).toBeDefined();
    expect(registry.get(writeTemplateTool.name)).toBeDefined();
  });

  it("rejects a prod profile for meta.rollback at the type level", () => {
    const connection = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };
    const prodProfile = createProdProfile(connection);
    const testProfile = createTestProfile(connection);
    const registry = createToolRegistry();

    // @ts-expect-error ProdProfile has no `write` member — meta.rollback
    // cannot be registered against it, must be a compile error.
    registry.registerWriteTool(prodProfile, rollbackTool);

    registry.registerWriteTool(testProfile, rollbackTool);

    expect(registry.get(rollbackTool.name)).toBeDefined();
  });

  it("rejects a prod profile for meta.promote_preview and meta.promote at the type level (LAB-272 T063)", () => {
    const connection = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };
    const prodProfile = createProdProfile(connection);
    const testProfile = createTestProfile(connection);
    const registry = createToolRegistry();

    // @ts-expect-error ProdProfile has no `write` member — meta.promote_preview
    // cannot be registered against it, must be a compile error.
    registry.registerWriteTool(prodProfile, promotePreviewTool);
    // @ts-expect-error same for meta.promote.
    registry.registerWriteTool(prodProfile, promoteTool);

    registry.registerWriteTool(testProfile, promotePreviewTool);
    registry.registerWriteTool(testProfile, promoteTool);

    expect(registry.get(promotePreviewTool.name)).toBeDefined();
    expect(registry.get(promoteTool.name)).toBeDefined();
  });
});
