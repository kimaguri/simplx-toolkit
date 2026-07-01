# Implementation Plan: devdash Multi-Repo Local Dev Orchestrator

**Branch**: `001-devdash-orchestrator` | **Date**: 2026-07-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-devdash-orchestrator/spec.md`

## Summary

Extend the existing `devdash` Go tool with a headless, deterministic command surface (`up` / `down` / `status` / `logs`), an instance model (project + branch) layered over the existing worktree/process/config machinery, and a Caddy reverse-proxy routing layer so services are addressed by stable `<slug>-<service>.<domainSuffix>` domains instead of hand-managed ports. Local services run as background dev processes on OS-assigned ports; remote services proxy to declared test hosts; the frontend addresses siblings by domain and is agnostic to local vs remote. A Claude Code skill plus thin slash commands translate free-text ("platform local, core remote") into strict CLI invocations. The bare `devdash` TUI, background persistence, and reconnection are preserved; the TUI additionally groups processes by instance.

Reuse (do NOT rebuild): `internal/discovery` (worktree/project scan), `internal/process` (PTY/tmux lifecycle, persistence, reconnection, `SegmentedLog`, `SanitizeForLog` ANSI stripping), `internal/config` (persistent config, `DevCommand`, session naming). Add new packages: `internal/orchestrator` (instance model + config resolution + up/down/status orchestration), `internal/proxy` (Caddy lifecycle + admin-API route management), and headless CLI dispatch in `cmd/devdash`.

## Technical Context

**Language/Version**: Go 1.25 (existing module `github.com/kimaguri/simplx-toolkit`).

**Primary Dependencies**: existing — Bubbletea (TUI), creack/pty, tmux backend; new — Caddy (external binary, managed via `caddy start` + admin API on `:2019`, no Go-library embed); standard library `net/http` for admin-API calls and `os/exec` for process spawning. No new heavy Go deps.

**Storage**: JSON files under `~/.config/devdash/` (migrated from `~/.config/local-dev/`): `config.json` (scan dirs, port overrides — retained), `projects/<name>.json` (central project configs — new), `sessions/<name>.json` (per-process session state — retained, extended with instance/service fields), `instances/<slug>.json` (instance registry — new), `logs/<name>.log` (plain-text per-process logs — retained). Per-repo `dev.config.json` at repo roots (new, optional).

**Testing**: `go test` (existing pattern: `_test.go` alongside sources, table-driven; integration tests in `internal/process/integration_test.go`). New unit tests for slug derivation, config resolution precedence, mode override merge, Caddy route JSON generation, status grouping/formatting, log tail/ANSI-strip. Integration test for up→status→logs→down against a fake/echo dev command with the proxy step stubbed (admin API faked) so tests need no real Caddy or port 80.

**Target Platform**: macOS + Linux developer workstation (`*.localhost` loopback, Caddy on port 80).

**Project Type**: Single Go CLI/TUI project (existing `cmd/` + `internal/` layout).

**Performance Goals**: `up` for a 3–4 service instance completes in a few seconds (bounded by dev-server startup, not the tool); `status`/`logs` return effectively instantly (sub-100ms for reading registry + tailing files).

**Constraints**: No `/etc/hosts` edits. Proxy must survive tool exit (detached `caddy start`). Idempotent `up`. Logs plain-text (ANSI-stripped) at stable paths. Config migration must not lose reconnection to already-running processes. HTTP only this version (HTTPS-ready design). No `--json` status yet (later).

**Scale/Scope**: A handful of projects, each 1–6 services, a handful of concurrent instances per developer machine. Not a multi-user or high-throughput system.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is the unpopulated template — no ratified numbered principles yet. No hard gates to enforce or violate. This plan nonetheless follows the constitution template's advisory spirit:

- **CLI interface / text I/O**: headless commands emit human-readable text to stdout, warnings/errors to stderr; `--json` deferred but the design keeps rendering separable from data so it can be added.
- **Test-first**: `/speckit-tasks` will generate test-first tasks; new pure logic (slug, config resolution, route JSON, formatting) is unit-tested before wiring.
- **Simplicity / YAGNI**: reuse existing discovery/process/config; no new abstractions beyond the two new packages the feature genuinely needs; Caddy managed as an external process rather than embedded.
- **Observability**: plain-text logs at stable paths are a first-class requirement (FR-023..028).

Result: **PASS** (no violations; Complexity Tracking left empty).

## Project Structure

### Documentation (this feature)

```text
specs/001-devdash-orchestrator/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── cli.md           # Headless command contracts (args, output shape, exit codes)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
cmd/devdash/
└── main.go              # MODIFY: dispatch subcommands (up/down/status/logs) before TUI; bare invocation still runs TUI

internal/
├── config/
│   ├── persistent.go    # MODIFY: config dir ~/.config/local-dev → ~/.config/devdash (+ migration); add projects-store paths
│   ├── project.go       # NEW: ProjectConfig type (name, domainSuffix, layout, repos, services), load+resolve (repo-root dev.config.json > central > none)
│   └── config.go        # REUSE DevCommand/SessionName (minor extension: random-port env injection)
├── discovery/           # REUSE as-is: ScanWorktrees, discoverLinkedWorktrees, DetectProjects
├── process/             # REUSE as-is: ProcessManager.Start/Stop/List/Get, SegmentedLog, SanitizeForLog, Reconnect
├── orchestrator/        # NEW package
│   ├── instance.go      # Instance model, slug derivation, service-state assembly
│   ├── resolve.go       # project+branch resolution; worktree lookup per repo by branch; mode-override merge
│   ├── up.go            # bring-up orchestration (idempotent): free-port alloc, ProcessManager.Start, proxy routes, registry write, output
│   ├── down.go          # teardown: stop local procs, remove routes, remove registry entry
│   ├── status.go        # gather registry + live state, group by instance, render text
│   ├── logs.go          # resolve instance/service log path(s), tail N, ANSI-strip (SanitizeForLog), bounded follow
│   └── registry.go      # instance registry read/write under ~/.config/devdash/instances/
├── proxy/               # NEW package
│   ├── caddy.go         # ensure detached daemon (ping admin :2019, `caddy start` if absent), base config bootstrap
│   └── routes.go        # add/remove per-instance routes via admin API; local→127.0.0.1:port, remote→upstream+Host rewrite
└── tui/                 # MODIFY: group process list by instance headers; show domain+port; remote rows

.claude/
├── skills/devdash/SKILL.md   # NEW: instance model, config resolution, free-text→flags mapping, log-on-failure guidance
└── commands/
    ├── devup.md / devdown.md / devstatus.md / devlogs.md   # NEW: thin, load skill + forward $ARGUMENTS
CLAUDE.md                      # MODIFY: rule — local envs only via devdash; pnpm/npm dev forbidden
```

**Structure Decision**: Single Go project, existing `cmd/`+`internal/` layout. Two new internal packages (`orchestrator`, `proxy`) hold all genuinely new logic; existing packages are reused, with surgical modifications to `config` (dir migration + project-config loading), `cmd/devdash/main.go` (subcommand dispatch), and `tui` (instance grouping). Claude integration artifacts live under `.claude/` and `CLAUDE.md`.

## Complexity Tracking

> No constitution violations. Section intentionally empty.
