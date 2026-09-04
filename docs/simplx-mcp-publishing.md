# simplx-mcp — preparing for registry publication (not done here)

This document is the T147 output: everything that can be prepared for a
one-line (`npx @scope/simplx-mcp`) install **without** actually publishing,
creating a token, or choosing a namespace — those three are the package
owner's decision, not something built by this task. Nothing in this repo
has been published anywhere as part of this work; the draft workflow below
is committed disabled (manual trigger only) and does not run on its own.

## What the tarball contains, verified

```sh
pnpm pack --pack-destination <somewhere outside the repo>
tar -tzf simplx-simplx-mcp-0.1.0.tgz
```

produces exactly:

- `bin/simplx-mcp.js` — the executable entry point `npx` runs.
- `dist/**/*.js` — compiled output, one file per `src/**/*.ts` module.
- `dist/**/*.d.ts` — type declarations, so a TypeScript consumer of the
  library (as opposed to someone only running the `simplx-mcp` binary) gets
  types.
- `dist/**/*.js.map` — source maps. `tsconfig.json` has `sourceMap: true`
  but not `inlineSources`, so these carry mappings and relative source
  paths only, not embedded source text.
- `package.json`.

Nothing else — no `src/`, no `test/`, no `node_modules`, no `.tgz` files,
no stray build artifacts. This matches `package.json`'s existing `"files":
["dist", "bin"]` exactly (npm always includes `package.json` regardless of
`files`; there is no `README`/`LICENSE` in the package directory today, so
npm did not add one — see "decisions" below, a `README` is worth adding
regardless of where this is published, since the current `dist/index.d.ts`
+ the install guide in `docs/simplx-mcp.md` are the only documentation a
consumer of a published tarball would have).

`publishConfig` is deliberately **not** added to `package.json` by this
task — see "Decision 1" below for why it can't be chosen yet.

## Decision 1 — namespace and registry (owner must choose)

**The scope `@simplx` is already registered on the public npm registry, by
an unrelated third party.** Checked directly, not assumed:

```
$ curl -s https://registry.npmjs.org/-/org/simplx/package
{"@simplx/simplxcli":"write","simplxcli":"write"}

$ npm view @simplx/simplxcli
@simplx/simplxcli@1.0.0 | ISC | ...
maintainers:
- simplx <dev@simplx.fr>
published over a year ago by simplx <dev@simplx.fr>
```

`dev@simplx.fr` — a French domain, publishing an unrelated "simple command
line interface" — has nothing to do with this project. **`@simplx/simplx-
mcp` cannot be published to the public npm registry under its current name
without that org's cooperation, which we have no reason to expect and no
relationship to request.** This is not a hypothetical risk to flag for
later; it is a concrete, already-true blocker for the name the package
currently carries.

Options, none chosen here:

1. **Rename the npm scope.** Keep the package on public npm, pick a scope
   this project actually controls — e.g. something under the `sadmin.app`
   domain already used elsewhere in this codebase (`platform.sadmin.app`
   etc.), or a scope matching whatever GitHub org/npm account is meant to
   own SimplX packages going forward. Cheapest to do, but changes the
   package's name (`@simplx/simplx-mcp` → `@<new-scope>/simplx-mcp`),
   which touches this guide, `docs/simplx-mcp.md`'s examples, and anyone
   who has already started using the old name informally.
2. **Publish to GitHub Packages instead of public npm**, scoped to this
   repo's actual GitHub owner (`github.com/kimaguri/simplx-toolkit` — this
   repo's own `origin` remote). No separate npm org purchase or scope
   negotiation needed; access is controlled by the same GitHub permissions
   already governing this repo. Consumers need a `.npmrc` pointing at
   `npm.pkg.github.com` for this scope and a GitHub token with
   `read:packages`, which is a real (small) extra step at install time
   compared to plain public npm — worth weighing against option 1's
   name-availability risk.
3. **A private registry** (Verdaccio, a hosted private-npm product, etc.)
   if this should never be reachable outside the org's own network at all
   — see Decision 2, which argues this may be the right call independent
   of the namespace question.

## Decision 2 — should this be public at all?

Worth raising because it is exactly the kind of thing that is easy to skip
past while solving the namespace problem: **a published package's `dist/`
is not minified or obfuscated — every platform REST path this server calls
is a plain string literal in the compiled JS**, and `docs/simplx-mcp.md`
(T057) documents, in prose, the full authentication mechanism this server
relies on: the `plt_live_`/`plt_test_` platform service-key format, the
exact endpoint that creates one (`POST /api/v1/platform/service-keys`), and
which internal user roles (`platform_admin`, `platform_service`, `service`,
`service_role`, `super_admin`) the platform's meta endpoints treat as
editors.

None of that is a credential — no token, no connection string, nothing
that authenticates anything by itself. But it IS a complete map of the
platform's tenant-metadata write surface and how to authenticate against
it, handed to anyone who runs `npm view` or reads the published README,
whether or not they have any relationship with SimplX. Today that
information is protected only by not being written down anywhere public;
publishing this package (with its current documentation) removes that
protection specifically for the meta-editing surface, independent of
whatever access control the platform itself enforces at request time.

This argues for a private registry (option 3 above), or at minimum for
trimming what `docs/simplx-mcp.md` documents about the auth mechanism
before choosing to publish publicly under option 1 or 2. Not a recommendation
to block publishing — a fact to weigh, since it is the kind of detail that
gets glossed over precisely because raising it slows things down.

## Draft release step (credential left as a placeholder)

`.github/workflows/publish-simplx-mcp.yml` (committed, `workflow_dispatch`
only — it does not run on push/tag, and running it manually still requires
a real secret that does not exist in this repo's settings, so it cannot
publish anything by existing):

```yaml
name: Publish simplx-mcp (manual)

on:
  workflow_dispatch:
    inputs:
      confirm:
        description: 'Type "publish" to confirm — this pushes a real package version'
        required: true

jobs:
  publish:
    runs-on: ubuntu-latest
    if: github.event.inputs.confirm == 'publish'
    defaults:
      run:
        working-directory: packages/simplx-mcp
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          # DECISION 1 (this document): registry-url must match whichever
          # option the owner picks — public npm ("https://registry.npmjs.org")
          # or GitHub Packages ("https://npm.pkg.github.com").
          registry-url: "REGISTRY_URL_PLACEHOLDER"
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm pack
      - run: pnpm publish --no-git-checks
        env:
          # NAMED PLACEHOLDER, not a real secret. Whoever sets up this
          # workflow for real creates the token (npm access token for
          # public npm, or a GitHub PAT with write:packages for GitHub
          # Packages — Decision 1 above) and adds it under this exact
          # name in the repo's Actions secrets.
          NODE_AUTH_TOKEN: ${{ secrets.SIMPLX_MCP_PUBLISH_TOKEN }}
```

This file is intentionally inert until someone (a) picks a registry, (b)
sets `registry-url` accordingly, (c) creates `SIMPLX_MCP_PUBLISH_TOKEN` in
the repo's secrets, and (d) runs it by hand with `confirm: publish` typed
in — four separate deliberate actions, none of which this task performs.

## What's ready vs. what the owner must decide

**Ready:**
- The tarball is minimal and correct (`files: ["dist", "bin"]` verified by
  `pnpm pack` + `tar -tzf`, contents listed above).
- `bin`/`main`/`types`/`exports` in `package.json` all already point at the
  right build outputs; `prepack` already runs the build, so both `pnpm
  pack` and a future `pnpm publish` produce a freshly-built tarball rather
  than a stale one.
- A draft, disabled CI workflow exists to run the actual publish once the
  two decisions below are made.
- The clean-room install path (T057) already proves the tarball itself
  installs and runs correctly outside this machine — publishing changes
  only how the tarball reaches a consumer, not whether it works once it
  does.

**The owner must decide:**
1. **Namespace/registry** — rename the npm scope to something this project
   controls, publish to GitHub Packages under this repo's existing owner,
   or use a fully private registry. `@simplx/simplx-mcp` as currently
   named cannot go to public npm; that specific option is foreclosed, not
   merely undecided.
2. **Public vs. private, independent of #1** — whether documenting the
   platform's meta-editing auth mechanism and endpoint surface in a
   publicly-readable package is acceptable, or whether that argues for a
   private registry regardless of which scope is chosen.

Once both are decided, `SIMPLX_MCP_PUBLISH_TOKEN` and `registry-url` in the
workflow above are the only two things left to fill in.
