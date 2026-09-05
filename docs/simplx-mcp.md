# simplx-mcp — installing and configuring the meta tools server

`packages/simplx-mcp` is an MCP server that exposes SimplX tenant UI metadata
operations (`meta.*`) to an AI agent. It is a thin, stateless wrapper over the
platform's REST API — every tool makes exactly one call to the platform and
forwards its response; no rules, no local validation, no state kept in the
server itself.

This document covers installing and configuring it.

## What's actually available today

The package name is `@simplx/simplx-mcp`, but **it is not published to any
registry**. `npx @simplx/simplx-mcp` does **not** work — and per
`docs/simplx-mcp-publishing.md` (T147), the `@simplx` npm scope is already
owned by an unrelated third party on the public registry, so that exact
name cannot become a working `npx @simplx/simplx-mcp` install without a
namespace change the package owner has not made yet. Until a registry and
namespace are decided (see that document), install from a locally built
tarball.

## Install

From the `packages/simplx-mcp` directory in this repo:

```sh
pnpm install
pnpm pack
```

`pnpm pack` runs the package's own `prepack` script (`pnpm run build`, i.e.
`tsc -p tsconfig.build.json`) first, then produces a tarball named
`simplx-simplx-mcp-<version>.tgz` in the current directory — e.g.
`simplx-simplx-mcp-0.1.0.tgz`.

Whoever will run the server (which may not be you — this is meant to be
handed to an agent's operator, not run only on the machine that built it)
installs and runs it via `npx`, pointing at that tarball with an explicit
`file:` prefix:

```sh
npx --yes "file:/absolute/path/to/simplx-simplx-mcp-0.1.0.tgz"
```

The `file:` prefix matters — `npx <bare-path>` was observed to be misresolved
by `npm`'s CLI (tried to execute the tarball directly rather than install it
as a package) during verification of this guide; `file:<path>` is the form
that reliably installs it as a package first.

### Verified in a genuinely clean environment, not by running it locally

The reason this matters: an earlier version of this package resolved its
`zod` dependency from a `node_modules` directory *above* the package on the
machine it was developed on — not from the package's own dependency tree at
all. Every local run worked; a real `npx` install on anyone else's machine
would have failed with "Cannot find module 'zod'". That class of defect is
invisible from inside the repo and only shows up outside it, so this guide
was verified this way rather than by trusting a local `pnpm test` run:

- built a real tarball with `pnpm pack` as above;
- copied it into an **empty directory with no ancestor `node_modules`
  relevant to this package**, and pointed `npm_config_cache` at a **fresh,
  never-used npm cache directory** (equivalent to a machine that has never
  run this package before);
- ran `npx --yes "file:$(pwd)/simplx-simplx-mcp-0.1.0.tgz"` from there.

Without any environment variables set, this produced:

```
Error: missing required environment variable: SIMPLX_PLATFORM_URL
    at requiredEnv (.../node_modules/@simplx/simplx-mcp/dist/cli.js:7:15)
    at main (.../node_modules/@simplx/simplx-mcp/dist/cli.js:13:18)
```

— a clean, expected failure: the package installed correctly, its own
`dist/cli.js` loaded and ran, and it failed for the right reason (no
configuration yet), not a module-resolution crash. Inspecting the installed
package's own `node_modules` in that fresh cache confirmed `zod` was present
there directly (not resolved from any ancestor directory). With the four
environment variables below set (see "Configure"), the same command started
the server and it stayed alive listening on stdio with no error output — the
full assembly (client, tool registry, all eighteen tools, `StdioServerTransport`)
works end to end from a cold install.

## Configure

`cli.ts` is the entry point `npx` runs (via the `simplx-mcp` bin declared in
`package.json`). It reads its configuration entirely from environment
variables — there is no config file, and no way to select a profile except
through them:

| Variable | Required | Meaning |
|---|---|---|
| `SIMPLX_PLATFORM_URL` | yes | Base URL of the platform's REST API, e.g. `https://platform-test.sadmin.app` |
| `SIMPLX_AUTH_TENANT_SLUG` | yes | Slug sent as the `X-Tenant-Slug` header the platform requires for service-to-service auth; any existing tenant slug works — it does NOT choose which tenant the tools read or write (tenant is a parameter of every call). Legacy name `SIMPLX_TENANT_SLUG` still accepted as an alias. |
| `SIMPLX_BEARER_TOKEN` | yes | The credential sent as `Authorization: Bearer <token>` on every platform call |
| `SIMPLX_MCP_PROFILE` | no (defaults to `prod`) | `test` or `prod` — see below |

### The profile decides which tools exist at all, not merely whether they work

This is the property the whole feature is built around, and it is worth
stating plainly rather than leaving it implied: **`SIMPLX_MCP_PROFILE`
determines which tools the agent can even see.**

- `test`: every tool is registered — eleven reads (`meta.get_schema`,
  `meta.list_apps`, `meta.get_entity`, `meta.diff`, `meta.validate`,
  `meta.get_app`, `meta.list_templates`, `meta.get_template`,
  `meta.template_dependents`, `meta.versions`, `meta.inventory`) and seven
  writes (`meta.write_entity`, `meta.delete_entity`, `meta.write_app`,
  `meta.write_template`, `meta.rollback`, `meta.promote_preview`,
  `meta.promote`).
- `prod` (the default — an operator who forgets to set this gets the safe
  option, not the dangerous one): **the seven write tools are not registered
  at all.** They do not appear in the list an agent calling `tools/list`
  sees, so an agent on the prod profile cannot attempt them and be refused —
  it never learns they exist. This is deliberate (contracts/mcp-tools.md:
  promotion to production is a human action, FR-034) and is enforced two
  ways at once: a `ProdProfile` cannot satisfy `registerWriteTool`'s
  parameter type at all (a `tsc` failure, not a runtime check that could be
  disabled), and the platform independently refuses a write from the
  automatic author in production regardless of what any client sends
  (LAB-257 T049/T167) — so a misconfigured client on this end is not the
  only thing standing between an agent and a production write.

Set `SIMPLX_MCP_PROFILE=prod` for any deployment an agent might reach in
production, and `SIMPLX_MCP_PROFILE=test` only for the test environment.

### `.mcp.json` — one entry per profile

A project's `.mcp.json` should carry both profiles as separate server
entries, not one entry with the profile as a runtime toggle a client could
flip:

```json
{
  "mcpServers": {
    "simplx-meta-test": {
      "command": "npx",
      "args": ["--yes", "file:/absolute/path/to/simplx-simplx-mcp-0.1.0.tgz"],
      "env": {
        "SIMPLX_PLATFORM_URL": "https://platform-test.sadmin.app",
        "SIMPLX_AUTH_TENANT_SLUG": "acme",
        "SIMPLX_BEARER_TOKEN": "plt_test_...",
        "SIMPLX_MCP_PROFILE": "test"
      }
    },
    "simplx-meta-prod": {
      "command": "npx",
      "args": ["--yes", "file:/absolute/path/to/simplx-simplx-mcp-0.1.0.tgz"],
      "env": {
        "SIMPLX_PLATFORM_URL": "https://platform.sadmin.app",
        "SIMPLX_AUTH_TENANT_SLUG": "acme",
        "SIMPLX_BEARER_TOKEN": "plt_live_...",
        "SIMPLX_MCP_PROFILE": "prod"
      }
    }
  }
}
```

An agent connected to `simplx-meta-prod` simply has no write tools to
discover — there is nothing to configure wrong at the calling end beyond
picking the right server entry.

### Two environments — two servers; tenant is a call parameter

Each `.mcp.json` entry is one server instance bound to one platform URL and
one profile — `simplx-meta-test` (write tools included) and
`simplx-meta-prod` (read-only, eleven tools). That binding is by platform and
profile only, not by tenant: a single running server instance serves every
tenant on that platform, because `tenant` is an argument passed to each call
(`meta.list_apps`, `meta.get_entity`, and the rest), not something baked into
the server at startup. The only reason `SIMPLX_AUTH_TENANT_SLUG` exists at
all is to populate the `X-Tenant-Slug` auth header the platform's
service-to-service auth requires — it is not a tenant selector, and any
existing tenant slug works there regardless of which tenant a given call
actually targets.

Promoting meta from test to production (LAB-272) is an MCP capability on the
**test profile only** — `meta.promote_preview` and `meta.promote` — never on
`simplx-meta-prod`, matching the write-less `prod` profile above: it has no
write tools of any kind, promotion included. Addressing is by `tenantSlug`
(not the tenant id every other tool uses) + `app`, optionally adding `entity`
for a single entity — OR `templateKey` alone, since templates are
cross-tenant (`tenantSlug`/`app`/`entity` must then be absent, never
combined). The cycle: `meta.promote_preview` (diff and `templateStale` — not
`false` means a dependency template needs promoting first) then
`meta.promote` with `expectedTargetVersion` set to the preview's
`targetVersion`, `null` included; a `version_conflict` means the target moved
since the preview — re-preview, never retry blindly. There is no
`acknowledgedDependents` field — the platform recounts a template's
dependents on the target itself as part of the promote call. Only call these
on the tenant owner's explicit instruction. The prod server's role for an
agent stays verification after a promotion: read the promoted entity or
app back through `simplx-meta-prod`'s read tools and confirm it matches what
was promoted.

## What the server itself teaches the agent (LAB-257 T259)

The knowledge an agent needs to work with SimplX meta ships INSIDE the
server, in three MCP-native layers — so it is versioned with the server and
reaches every client that connects, with no skill file to install:

1. **`instructions`** — returned at `initialize`; clients such as Claude Code
   merge it into the agent's context. It is the rule set: the write cycle
   (`get_entity → validate → diff → write_entity` with `expectedVersion`,
   verify, `rollback` via `versions`), what changes what on screen
   (`routeConfig.navKey` vs `displayName`, whole `constants.labels`,
   `basedOn` overrides, `hideInMenu`), and the never-do list. Source:
   `src/knowledge/instructions.ts`.
2. **Tool descriptions** — the semantics of each call live in its own
   `description` and field `.describe()` texts (`meta.write_entity` carries
   the navKey/labels/version-conflict rules, `meta.rollback` says where
   `targetVersionId` comes from, `meta.validate` explains
   `unknownComponents`). This is what the agent reads at `tools/list`.
3. **Resources and prompts** — the reference on demand:
   `simplx://meta/guide` (shape of an entity, sidebar/name rules, templates
   and overrides, `$ref`, fields, sections, quick actions, plugins, history,
   common mistakes) and `simplx://meta/types` (full type reference); prompts
   `meta_add_field`, `meta_new_entity_from_template`, `meta_rename_entity`
   for the typical jobs. Sources: `src/knowledge/guide.md`,
   `src/knowledge/types-reference.md`, embedded at build time by
   `scripts/embed-knowledge.mjs` into `src/knowledge/embedded.ts`
   (`test/knowledge.test.ts` fails if the embedded copy is stale).

The `prod` profile serves the same instructions and resources — reading the
rules never needs write tools. A client-side skill (e.g. Claude Code's
`simplx-meta`) is reduced to a pointer: connect the server, read its
instructions and `simplx://meta/guide`.

Text guides behaviour; the API enforces it: mandatory `expectedVersion`,
version conflicts, server-side validation and the write-less `prod` profile
hold regardless of whether the agent read anything.

## Tokens: use a platform service key, not the shared platform secret

`SIMPLX_BEARER_TOKEN` needs a credential the platform accepts as
`Authorization: Bearer <token>` and that resolves to a role the meta
endpoints treat as an editor (`assertMetaWritePermission` /
`isMetaEditor`, `platform/.../tenant-management/meta-access.ts`).

**Recommended: a platform service key** (`plt_live_...` / `plt_test_...`,
`platform/.../lib/auth/api-key-utils.ts`'s `generatePlatformKey`). A key
resolves to `userRole: 'platform_service'`, `tokenType: 'platform_service_key'`
(`gateway/auth/external-api-key.ts`) — `'platform_service'` is one of the
roles `META_EDITOR_ROLES` accepts, so a platform service key genuinely works
for every `meta.*` tool, both reads and writes, not merely for some
unrelated purpose that happens to authenticate.

Created via `POST /api/v1/platform/service-keys` (platform-admin auth
required) with `{ name, scopes, environment: "live" | "test" }`, one key per
environment — this is what the `test`/`prod` `.mcp.json` split above should
actually be backed by, one key each. **Rough edge worth knowing, not
glossed over:** the platform only defines one formal platform scope today
(`PLATFORM_SCOPES = ['environment:sync']`), and key creation requires at
least one valid scope, so creating a key today means passing
`scopes: ["environment:sync"]` even though the key will be used for meta
operations — the scope name is irrelevant to what actually gates `meta.*`
access (that's `userRole`, checked separately, not the key's `scopes`
array). The response is shown once (`"Save this key now. It won't be shown
again"`) and only the key's prefix is stored afterward — losing it means
issuing a new one, not recovering the old one.

Each key is **individually revocable** (`DELETE
/api/v1/platform/service-keys/:id`) and the schema carries an `expires_at`
column (`db/schema/admin/api-keys.ts`) settable via `PATCH
/api/v1/platform/service-keys/:id` — not set automatically at creation, so a
key does not expire unless one is deliberately given an expiry.

**Why not the single shared platform secret instead.** The platform also
accepts a service-token style credential for internal service-to-service
calls, and it would technically authenticate too. Don't use it here: it is
one secret shared by everything that needs it, which means it can't be
revoked for one consumer without breaking every other consumer of the same
secret, it carries no name or record of who holds a copy, and there is
nothing to individually expire. A leaked or over-broadly-distributed shared
secret is a platform-wide incident; a leaked platform service key is a
`DELETE` call and a new key for the one thing that needed it. Handing every
developer running this server their own named, revocable, environment-scoped
key is the difference between "one secret for everyone, revocable for
nobody" and normal credential hygiene — issue one key per person/agent
deployment that needs one, name it so `listPlatformServiceKeys` output is
legible later, and revoke it the moment it's no longer needed.

## What the eighteen tools cover (and what they don't)

| Tool | Kind | Covers |
|---|---|---|
| `meta.get_schema` | read | Machine-readable metadata rules and their version |
| `meta.list_apps` | read | Every app of a tenant, its own version, its entities' versions |
| `meta.get_entity` | read | One entity's `raw` (edit this) and `resolved` (assembled preview) |
| `meta.diff` | read | Differences between a proposed entity change and its current stored state |
| `meta.validate` | read | Checks a description against the published rules without writing it |
| `meta.get_app` | read | An app's own description (plugins, settings, notifications, menu) |
| `meta.list_templates` | read | Every template available to base an entity on |
| `meta.get_template` | read | A single template's own content |
| `meta.template_dependents` | read | Every entity, across every tenant, depending on a template |
| `meta.versions` | read | Change history of an entity, an app description, or a template |
| `meta.inventory` | read | Full on-demand scan of every active meta row, every tenant, against the published rules — `tenantViolationCount` is the number to act on, see below |
| `meta.write_entity` | write | Creates or updates one entity's description |
| `meta.delete_entity` | write | Explicit soft-delete of one entity |
| `meta.write_app` | write | Creates or updates an app's own description |
| `meta.write_template` | write | Updates a template, with a server-recounted dependents acknowledgement |
| `meta.rollback` | write | Returns an entity, an app description, or a template to a previously saved version |
| `meta.promote_preview` | write | Diff and target version a promotion to prod would produce, without changing anything |
| `meta.promote` | write | Promotes an app, an entity, or a template from test to prod |

**`meta.inventory` is a diagnostic, not a write gate.** It surfaces violations already present in stored meta — including ones the current `META_VALIDATION_MODE` would not currently block on write — and refuses outright (`meta_rules_unavailable`) rather than reporting a false "no violations" if the validation rules themselves can't be loaded. Reading `violations.length` instead of `tenantViolationCount` reproduces the standalone `meta-validation-report.ts` script's own trap: a raw count that is nonzero for annotated `admin`/`host` rows no running consumer even reads.

**Every one of the eighteen tools now publishes a real input schema (LAB-257
T243; LAB-272's two promotion tools followed the same convention from the
start).** Before T241/T243, all sixteen tools that existed then shared one permissive fallback
(`z.record(z.string(), z.unknown()).optional()`) — an agent calling
`tools/list` saw a tool name and an untyped bag, no parameter names, no
types, no descriptions. T241 gave `meta.write_entity`, `meta.write_app`, and
`meta.write_template` real schemas; T243 did the same for the remaining
thirteen and removed the fallback outright — `ToolDefinition.inputSchema`
is now a required field, and a tool without one fails at server assembly,
naming the tool, rather than silently registering as a bag. Every generated
JSON Schema property carries a `.describe()` that says what the value is
and, where relevant, which other tool's output it comes from (e.g.
`meta.get_entity`'s `version` for `meta.write_entity`'s `expectedVersion`).
A handful of tools are genuinely zero-argument (`meta.get_schema`,
`meta.list_templates`, `meta.inventory`) — their schema declares the empty
shape explicitly rather than leaving the field undocumented.

**`expectedVersion` is conditionally required — and the tool schemas now say
so (LAB-257 T241).** `meta.write_entity` and `meta.write_app` accept the same
call for both create and update: omit `expectedVersion` to create, pass it
(the value from your last `meta.get_entity`/`meta.get_app`) to update. The
platform enforces this strictly — pass it while creating and it refuses with
app_code `meta_expected_version_not_allowed`; omit it while updating an
existing record and it refuses with `meta_expected_version_required` — and
each tool's own `expectedVersion` field description spells out both codes and
which getter to re-read from, so an agent reading the tool schema learns this
before the call, not only from the refusal. `meta.write_template` has no
creation path at all (a template that doesn't exist is a `not_found`, not a
create), so `expectedVersion` is declared REQUIRED in its schema — a call
omitting it never reaches the platform; the MCP SDK's own schema validation
rejects it first.

**`meta.versions` and `meta.rollback` cover entities, apps, and templates**
(LAB-257 T175/T203). Pass `templateKey` instead of `tenant`/`app`/`entity` to
address a template's own history or restore a template to a previously saved
version; the two addressing schemes are mutually exclusive, and the tool
schemas say so. A template rollback additionally requires
`acknowledgedDependents` — the count just read via `meta.template_dependents`
— because restoring old template content reaches every dependent tenant
exactly the way an edit does; the platform recounts dependents and refuses if
the picture has changed since that read.
