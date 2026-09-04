import type { z } from "zod";
import type { PlatformClient } from "../client/platform-client.js";
import type { Profile, WriteCapableProfile } from "../profiles/types.js";

export interface ToolContext {
  readonly profile: Profile;
  readonly client: PlatformClient;
}

/** Whether a tool mutates platform state. Declared BY the tool, next to
 * its own definition — the one place this fact has a single owner, rather
 * than being inferred (unreliably: `meta.validate` POSTs without writing
 * anything, so "which HTTP verb / client method it calls" is NOT a valid
 * proxy for this) or re-declared in the assembly code that registers it
 * (LAB-257 T162 — see `createToolRegistry`'s runtime check below, which
 * exists because self-declaration alone would not catch server.ts routing
 * a `"write"` tool through `registerReadTool` by mistake). */
export type ToolKind = "read" | "write";

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** The Zod shape the MCP SDK turns into this tool's JSON Schema, shown
   * to the calling agent BEFORE it ever invokes the tool (T241) — this is
   * how a field-level requirement (e.g. `expectedVersion` on an existing
   * record) reaches the agent ahead of a runtime refusal, not merely
   * documented in a JSDoc comment that never leaves this source file.
   *
   * REQUIRED on every tool (LAB-257 T243) — there is no permissive
   * fallback left in `server.ts` to fall back to. A zero-argument tool
   * (e.g. `meta.get_schema`) declares the empty shape `{}` explicitly,
   * which is itself informative (the agent sees "no properties", not
   * "properties undocumented"). `registerReadTool`/`registerWriteTool`
   * below both refuse a tool missing this at registration time, so a new
   * tool added without one fails loudly instead of silently shipping as
   * an untyped bag. */
  readonly inputSchema: z.ZodRawShape;
  readonly handler: (context: ToolContext, args: TArgs) => Promise<TResult>;
}

/** How a tool ended up in a registry — which registration method it went
 * through. See {@link ToolRegistry.listWithProvenance}: `list()` alone
 * erases this (both registration methods insert into the same map), so a
 * tool that ended up registered through the wrong one would be
 * indistinguishable from a correctly-registered one by output alone
 * (LAB-257 T162). */
export type ToolProvenance = ToolKind;

/** One tool as held by a {@link ToolRegistry}, tagged with how it got there. */
export interface ToolRegistryEntry {
  readonly tool: ToolDefinition;
  readonly registeredAs: ToolProvenance;
}

export interface ToolRegistry {
  readonly registerReadTool: <TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>) => void;
  readonly registerWriteTool: <TArgs, TResult>(
    profile: WriteCapableProfile,
    tool: ToolDefinition<TArgs, TResult>,
  ) => void;
  readonly get: (name: string) => ToolDefinition | undefined;
  readonly list: () => readonly ToolDefinition[];
  /** Every tool this registry holds, each tagged with which registration
   * method actually admitted it. */
  readonly listWithProvenance: () => readonly ToolRegistryEntry[];
}

/**
 * Holds the tools exposed by this server instance. Tool *implementations*
 * arrive in later tasks (T045-T057) — this is registration plumbing only.
 *
 * The write boundary: {@link ToolRegistry.registerWriteTool} takes a
 * {@link WriteCapableProfile}, not the {@link Profile} union. A
 * `ProdProfile` has no `write` member, so `registerWriteTool(prodProfile,
 * tool)` is rejected by `tsc` before the code runs — there is no
 * `if (profile.name === "prod") throw` anywhere in this module. See
 * `test/profiles.type-test.ts` for the compile-time proof.
 */
export const createToolRegistry = (): ToolRegistry => {
  const tools = new Map<string, ToolRegistryEntry>();

  const registerReadTool = <TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>): void => {
    // LAB-257 T162: catches a write tool routed through the read call by
    // mistake immediately, at server assembly time — not merely in a test
    // that could itself go stale the way `test/profiles.test.ts`'s
    // hardcoded write-tool-name list did for `meta.rollback`.
    if (tool.kind !== "read") {
      throw new Error(`registerReadTool: "${tool.name}" declares kind "${tool.kind}", not "read"`);
    }
    // LAB-257 T243: a tool with no inputSchema at all (bypassing the
    // required-field type via `as unknown as ToolDefinition`, or a
    // future refactor that makes the field optional again) must fail
    // HERE, at server assembly, not ship silently as an untyped bag.
    if (tool.inputSchema === undefined) {
      throw new Error(`registerReadTool: "${tool.name}" has no inputSchema`);
    }
    tools.set(tool.name, { tool: tool as ToolDefinition, registeredAs: "read" });
  };

  const registerWriteTool = <TArgs, TResult>(
    _profile: WriteCapableProfile,
    tool: ToolDefinition<TArgs, TResult>,
  ): void => {
    if (tool.kind !== "write") {
      throw new Error(`registerWriteTool: "${tool.name}" declares kind "${tool.kind}", not "write"`);
    }
    // LAB-257 T243: see registerReadTool's identical check above.
    if (tool.inputSchema === undefined) {
      throw new Error(`registerWriteTool: "${tool.name}" has no inputSchema`);
    }
    tools.set(tool.name, { tool: tool as ToolDefinition, registeredAs: "write" });
  };

  const get = (name: string): ToolDefinition | undefined => tools.get(name)?.tool;

  const list = (): readonly ToolDefinition[] => [...tools.values()].map((entry) => entry.tool);

  const listWithProvenance = (): readonly ToolRegistryEntry[] => [...tools.values()];

  return { registerReadTool, registerWriteTool, get, list, listWithProvenance };
};
