import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../src/client/platform-client.js";
import { createTestProfile } from "../src/profiles/index.js";
import type { ToolContext } from "../src/tools/registry.js";
// None of these three modules exist yet — this import is expected to fail
// to resolve until T054 (write_entity/delete_entity), T126 (write_app), and
// T090 (write_template) land, which is the correct RED reason for T046
// (tool absent), not a typo in this test file.
import { deleteEntityTool, writeEntityTool } from "../src/tools/meta/write.js";
import { writeAppTool } from "../src/tools/meta/app.js";
import { writeTemplateTool } from "../src/tools/meta/templates.js";

/**
 * LAB-257 T046 — contract tests for the four MCP write tools
 * (`meta.write_entity`, `meta.delete_entity`, `meta.write_app`,
 * `meta.write_template`), written BEFORE their implementation (T054/T126/T090).
 *
 * contracts/mcp-tools.md + contracts/meta-write-api.md pin the facts this
 * file exists to enforce:
 *
 *  1. "Она же публикация — отдельного шага нет" (FR-009): `write_entity`
 *     makes exactly ONE call to the platform. There is no second "publish"
 *     call to assert against, and no test here looks for one.
 *
 *  2. Version conflict: the tool surfaces `currentVersion` FROM THE
 *     SERVER'S RESPONSE, verbatim — never recomputed. A blind retry with
 *     the SAME stale `expectedVersion` must be rejected again (proves no
 *     client-side "just try again" leniency); only a retry carrying the
 *     re-read version succeeds — that re-read is `meta.get_entity`'s job,
 *     not this tool's.
 *
 *  3. `delete_entity` is explicit and carries `expectedVersion`; deletion
 *     is never inferred from omission — there is no batch/set tool in this
 *     surface for an omission to even be expressed against (`mcp-tools.md`
 *     lists no such tool), so the closest enforceable assertion is that an
 *     addressed write/delete never touches an entity it wasn't given.
 *
 *  4. `write_app`'s `menu` is LIVE (drives sidebar section grouping) and
 *     MUST be forwarded unchanged — no test here treats `menu` as rejected
 *     or stripped.
 *
 *  5. `write_template`'s `acknowledgedDependents` mismatch is a SERVER-side
 *     rejection the tool surfaces, not a client-computed one.
 *
 *  6. Thin wrapper: none of these tools may read anything before writing
 *     (no pre-fetch to compute a version) and none may compute the new
 *     version itself — every test's mocked server response uses a version
 *     number that is NOT `expectedVersion + 1`, so a tool that fabricated
 *     `expectedVersion + 1` instead of forwarding the server's actual
 *     answer would be caught immediately.
 *
 * Profile gating (prod exposes no write tools at all) is T048's assertion,
 * not this file's — nothing here contradicts it; every test uses a
 * `TestProfile` context directly against each tool's `handler`.
 *
 * DB/network: never touched. `PlatformClient` is a hand-rolled `vi.fn()`
 * double satisfying the real `PlatformClient` interface.
 */

const CONNECTION = { baseUrl: "https://platform.example.test", tenantSlug: "acme", bearerToken: "token" };

/** A structured platform rejection — mirrors the actual HTTP error envelope
 * `errs.*` produces on the platform (`{ code, message, details: { params: {...} } }`,
 * see `platform/src/lib/errs/index.ts`), so a write tool that unwraps this
 * exact shape and forwards `details.params.currentVersion` is doing the
 * SAME thing the platform's own existing sibling tests already assert of
 * `writeAppMeta`/`writeEntityMeta` (`caught?.details?.params?.currentVersion`).
 */
class PlatformError extends Error {
  code: string;
  details: { params?: Record<string, unknown>; [key: string]: unknown };
  constructor(message: string, code: string, details: { params?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type WriteResponder = (body: unknown, method: string) => unknown;

/**
 * A `PlatformClient` double. `get` responses are static per path; `write`
 * responses are functions so a test can react to what was actually sent
 * (e.g. reject unless the body's `expectedVersion` matches "the server's"
 * current state) — the only way to prove a blind retry keeps failing while
 * a corrected retry succeeds.
 */
const makeFakeClient = (opts: { get?: Record<string, unknown>; write?: Record<string, WriteResponder> }): PlatformClient => {
  const get = vi.fn(async (path: string) => {
    if (!opts.get || !(path in opts.get)) {
      throw new Error(`fake platform client: unexpected GET ${path}`);
    }
    return opts.get[path];
  });
  const write = vi.fn(async (path: string, body: unknown, method = "POST") => {
    const responder = opts.write?.[path];
    if (!responder) {
      throw new Error(`fake platform client: unexpected ${method} ${path}`);
    }
    return responder(body, method);
  });
  const request = vi.fn(async (options: { method?: string; path: string; body?: unknown }) => {
    if (!options.method || options.method === "GET") return get(options.path);
    return write(options.path, options.body, options.method);
  });
  return { get, write, request } as unknown as PlatformClient;
};

const makeContext = (client: PlatformClient): ToolContext => ({
  profile: createTestProfile(CONNECTION),
  client,
});

const totalCalls = (client: PlatformClient) =>
  (client.get as ReturnType<typeof vi.fn>).mock.calls.length +
  (client.write as ReturnType<typeof vi.fn>).mock.calls.length +
  (client.request as ReturnType<typeof vi.fn>).mock.calls.length;

describe("meta.write_entity — LAB-257 T046", () => {
  const TENANT = "tenant-acme";
  const APP = "intellhouse";
  const ENTITY = "contacts";
  const PATH = `/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`;

  it('is registered under the contract name "meta.write_entity"', () => {
    expect(writeEntityTool.name).toBe("meta.write_entity");
  });

  it("writes the addressed entity in exactly ONE platform call and returns the server's version verbatim — write IS publication, no second call", async () => {
    const config = { entityName: ENTITY, basedOn: ENTITY, overrides: { fields: { inn: {} } } };
    const client = makeFakeClient({
      write: {
        [PATH]: (body) => {
          expect(body).toMatchObject({ expectedVersion: 7, config, changeReason: "добавлено поле ИНН" });
          // Deliberately NOT expectedVersion + 1 (would be 8) — proves the
          // tool forwards the server's actual answer instead of computing it.
          return { version: 9, entityName: ENTITY };
        },
      },
    });

    const result = await writeEntityTool.handler(makeContext(client), {
      tenant: TENANT,
      app: APP,
      entity: ENTITY,
      expectedVersion: 7,
      config,
      changeReason: "добавлено поле ИНН",
    });

    expect(result).toEqual({ version: 9, entityName: ENTITY });
    expect(totalCalls(client)).toBe(1);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("on a version conflict, surfaces the CURRENT version from the server's response, not a recomputed one", async () => {
    const client = makeFakeClient({
      write: {
        [PATH]: () => {
          throw new PlatformError("База ушла вперёд, перечитайте описание", "failed_precondition", {
            params: { currentVersion: 8, expectedVersion: 6 },
          });
        },
      },
    });

    let caught: any;
    try {
      await writeEntityTool.handler(makeContext(client), {
        tenant: TENANT,
        app: APP,
        entity: ENTITY,
        expectedVersion: 6,
        config: { entityName: ENTITY },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const currentVersion = caught?.currentVersion ?? caught?.details?.currentVersion ?? caught?.details?.params?.currentVersion;
    expect(currentVersion).toBe(8);
  });

  it("rejects a BLIND retry with the same stale expectedVersion again — retrying without re-reading must not succeed", async () => {
    let serverVersion = 8;
    const client = makeFakeClient({
      write: {
        [PATH]: (body: any) => {
          if (body.expectedVersion !== serverVersion) {
            throw new PlatformError("stale", "failed_precondition", {
              params: { currentVersion: serverVersion, expectedVersion: body.expectedVersion },
            });
          }
          serverVersion += 1;
          return { version: serverVersion, entityName: ENTITY };
        },
      },
    });

    const staleArgs = { tenant: TENANT, app: APP, entity: ENTITY, expectedVersion: 6, config: { entityName: ENTITY } };

    await expect(writeEntityTool.handler(makeContext(client), staleArgs)).rejects.toBeDefined();
    // Same call again, same stale expectedVersion — a blind retry, exactly
    // what the agent must NOT do without re-reading via get_entity first.
    await expect(writeEntityTool.handler(makeContext(client), staleArgs)).rejects.toBeDefined();
    expect(serverVersion).toBe(8); // untouched by either failed attempt

    // Only a retry carrying the RE-READ version (the recovery path —
    // meta.get_entity, then re-apply) succeeds.
    const recovered = await writeEntityTool.handler(makeContext(client), { ...staleArgs, expectedVersion: 8 });
    expect(recovered).toEqual({ version: 9, entityName: ENTITY });
  });

  it("touches only the addressed entity — writing 'contacts' never sends anything under a different entity's path", async () => {
    const client = makeFakeClient({
      write: {
        [PATH]: () => ({ version: 1, entityName: ENTITY }),
        [`/api/v1/meta/entities/${TENANT}/${APP}/deals`]: () => {
          throw new Error("must not be called — write_entity('contacts') must never reach 'deals'");
        },
      },
    });

    await writeEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY, config: { entityName: ENTITY } });

    const writeCalls = (client.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.[0]).toBe(PATH);
  });
});

describe("meta.delete_entity — LAB-257 T046", () => {
  const TENANT = "tenant-acme";
  const APP = "intellhouse";
  const ENTITY = "contacts";
  const PATH = `/api/v1/meta/entities/${TENANT}/${APP}/${ENTITY}`;

  it('is registered under the contract name "meta.delete_entity"', () => {
    expect(deleteEntityTool.name).toBe("meta.delete_entity");
  });

  it("deletes explicitly with expectedVersion via DELETE, and forwards the server's confirmation verbatim", async () => {
    const client = makeFakeClient({
      write: {
        [PATH]: (body, method) => {
          expect(method).toBe("DELETE");
          expect(body).toMatchObject({ expectedVersion: 7 });
          return { entityName: ENTITY, deleted: true };
        },
      },
    });

    const result = await deleteEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY, expectedVersion: 7 });

    expect(result).toEqual({ entityName: ENTITY, deleted: true });
  });

  it("on a version conflict, surfaces the current version and does not proceed with deletion", async () => {
    const client = makeFakeClient({
      write: {
        [PATH]: () => {
          throw new PlatformError("stale", "failed_precondition", { params: { currentVersion: 9, expectedVersion: 7 } });
        },
      },
    });

    let caught: any;
    try {
      await deleteEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY, expectedVersion: 7 });
    } catch (err) {
      caught = err;
    }

    const currentVersion = caught?.currentVersion ?? caught?.details?.currentVersion ?? caught?.details?.params?.currentVersion;
    expect(currentVersion).toBe(9);
  });

  it("expectedVersion is mandatory — there is nothing to delete 'by omission', an explicit target and version are required every time", async () => {
    const client = makeFakeClient({ write: { [PATH]: () => ({ entityName: ENTITY, deleted: true }) } });

    // No `expectedVersion` in the call — the contract's explicit-deletion
    // guarantee (FR-008) has nothing to anchor a delete to without it, so
    // this must reject rather than silently deleting "the latest version"
    // or, worse, silently doing nothing.
    await expect(
      deleteEntityTool.handler(makeContext(client), { tenant: TENANT, app: APP, entity: ENTITY } as any),
    ).rejects.toBeDefined();
  });
});

describe("meta.write_app — LAB-257 T046 (FR-044)", () => {
  const TENANT = "tenant-acme";
  const APP = "intellhouse";
  const PATH = `/api/v1/meta/apps/${TENANT}/${APP}`;

  it('is registered under the contract name "meta.write_app"', () => {
    expect(writeAppTool.name).toBe("meta.write_app");
  });

  it("forwards `menu` UNCHANGED — menu is live (drives sidebar section grouping) and must never be stripped or rejected", async () => {
    const menu = [{ key: "sales", label: "Продажи", path: "/sales", icon: "cart" }];
    const config = { menu, plugins: ["reports"], pluginConfigs: {}, settings: {}, notifications: {} };
    const client = makeFakeClient({
      write: {
        [PATH]: (body: any) => {
          expect(body.config.menu).toEqual(menu);
          return { version: 13, appName: APP };
        },
      },
    });

    const result = await writeAppTool.handler(makeContext(client), {
      tenant: TENANT,
      app: APP,
      expectedVersion: 12,
      config,
      changeReason: "подключён плагин reports",
    });

    expect(result).toEqual({ version: 13, appName: APP });
  });

  it("on a version conflict, surfaces the current version from the server, not a recomputed one", async () => {
    const client = makeFakeClient({
      write: {
        [PATH]: () => {
          throw new PlatformError("stale", "failed_precondition", { params: { currentVersion: 15, expectedVersion: 12 } });
        },
      },
    });

    let caught: any;
    try {
      await writeAppTool.handler(makeContext(client), {
        tenant: TENANT,
        app: APP,
        expectedVersion: 12,
        config: { menu: [], plugins: [], pluginConfigs: {}, settings: {}, notifications: {} },
      });
    } catch (err) {
      caught = err;
    }

    const currentVersion = caught?.currentVersion ?? caught?.details?.currentVersion ?? caught?.details?.params?.currentVersion;
    expect(currentVersion).toBe(15);
  });
});

describe("meta.write_template — LAB-257 T046", () => {
  const TEMPLATE_KEY = "contacts";
  const PATH = `/api/v1/meta/templates/${TEMPLATE_KEY}`;

  it('is registered under the contract name "meta.write_template"', () => {
    expect(writeTemplateTool.name).toBe("meta.write_template");
  });

  it("forwards acknowledgedDependents and returns the server's new version verbatim", async () => {
    const config = { fields: { name: { type: "string" } } };
    const client = makeFakeClient({
      write: {
        [PATH]: (body: any) => {
          expect(body).toMatchObject({ expectedVersion: 3, config, acknowledgedDependents: 3, changeReason: "добавлен телефон в форму" });
          return { version: 4 };
        },
      },
    });

    const result = await writeTemplateTool.handler(makeContext(client), {
      templateKey: TEMPLATE_KEY,
      expectedVersion: 3,
      config,
      acknowledgedDependents: 3,
      changeReason: "добавлен телефон в форму",
    });

    expect(result).toEqual({ version: 4 });
  });

  it("rejects when acknowledgedDependents no longer matches the actual count — the acknowledgement described a different picture", async () => {
    // The mismatch check is the PLATFORM's (server-side), not this tool's —
    // the fake server here plays that role; the tool must only forward the
    // rejection, never decide on its own whether 3 == 3.
    const client = makeFakeClient({
      write: {
        [PATH]: (body: any) => {
          const actualDependents = 5; // changed since meta.template_dependents was called
          if (body.acknowledgedDependents !== actualDependents) {
            throw new PlatformError(
              "Подтверждение относилось к другой картине зависимых",
              "failed_precondition",
              { params: { acknowledgedDependents: body.acknowledgedDependents, actualDependents } },
            );
          }
          return { version: 4 };
        },
      },
    });

    let caught: any;
    try {
      await writeTemplateTool.handler(makeContext(client), {
        templateKey: TEMPLATE_KEY,
        expectedVersion: 3,
        config: { fields: {} },
        acknowledgedDependents: 3,
        changeReason: "добавлен телефон в форму",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const actualDependents = caught?.actualDependents ?? caught?.details?.actualDependents ?? caught?.details?.params?.actualDependents;
    expect(actualDependents).toBe(5);
  });
});
