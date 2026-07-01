# Quickstart / Validation Guide: devdash Orchestrator

End-to-end scenarios that prove the feature works. See [contracts/cli.md](./contracts/cli.md) and [data-model.md](./data-model.md) for shapes.

## Prerequisites

- Go 1.25 toolchain; `make build` produces the `devdash` binary.
- `caddy` on PATH (Caddy v2). Port 80 free.
- A central project config at `~/.config/devdash/projects/simplx.json` (see data-model example), or a `dev.config.json` at a repo root.
- Task worktrees exist for the branch under test (created by the normal git-worktree workflow).

## Scenario A — mixed local/remote up (User Story 1)

```
devdash up --project simplx --branch orders-refactor
```

Expect: `front`/`mfe` spawn as local processes on random ports; `core`/`platform` recorded as remote; Caddy auto-started detached; four routes written; stdout lists four URLs + log paths.

Validate reachability:
```
curl -sI http://orders-refactor-front.simplx.localhost      # 200 from local vite
curl -sI http://orders-refactor-platform.simplx.localhost   # proxied to platform-test
```

## Scenario B — per-invocation override (US1 / US5)

```
devdash up --project simplx --branch orders-refactor --local core
```

Expect: `core` now spawned locally from its worktree; `platform` still remote; frontend env unchanged (still addresses `orders-refactor-core.simplx.localhost`).

## Scenario C — idempotent re-up (US1 AC4)

Run Scenario A twice. Expect: second run creates no duplicate processes, reports already-running services, starts only anything missing.

## Scenario D — logs (User Story 2)

```
devdash logs orders-refactor front           # last ~50 plain-text lines
devdash logs orders-refactor front --tail 10
devdash logs orders-refactor                 # all services, [service]-prefixed
devdash logs orders-refactor front --follow --timeout 15s   # streams then exits
devdash logs orders-refactor platform        # "service is remote (no local log)"
```

Expect: no ANSI escapes; stable file at `~/.config/devdash/logs/dev-orders-refactor-front.log` readable directly.

## Scenario E — status grouped by instance (User Story 3)

```
devdash status
devdash status orders-refactor
```

Expect: instances grouped by `project/branch`; each service row shows mode/URL/port/pid/status/logpath; remote services shown as proxy rows with upstream.

## Scenario F — down leaves others alone (User Story 4)

Bring up two instances (two branches), then:
```
devdash down orders-refactor
```

Expect: `orders-refactor` local processes stopped, its routes + registry entry removed; the other instance still reachable; Caddy still running.

## Scenario G — missing worktree skip (US1 AC3)

Remove/omit one service's worktree, run `up`. Expect: that service skipped with a stderr warning; others come up.

## Scenario H — migration + TUI regression (FR-008 / FR-041)

With an existing `~/.config/local-dev/` and a running process, launch `devdash` once. Expect: config/sessions/logs migrated to `~/.config/devdash/`, the running process reconnected, bare `devdash` opens the TUI, and the process list is grouped under instance headers.

## Scenario I — Claude Code path (User Story 5)

From within a project worktree, `/devup platform local, core remote`. Expect: skill infers project+branch from context, maps free text to `--local platform --remote core`, runs `devdash up ...`; on a failed service Claude runs `devdash logs <instance> <service>` and reports the cause; Claude never runs `pnpm dev` directly.

## Automated test coverage (see plan Testing)

- Unit: slug derivation, config resolution precedence, mode-override merge, Caddy route JSON, status formatting/grouping, log tail + ANSI strip.
- Integration: up→status→logs→down against an echo/sleep dev command with a fake proxy client (no real Caddy / port 80).
