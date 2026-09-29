# Implementation Plan: devdash local-run reliability fixes

**Branch**: `fix/lab-294/devdash-reliability` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-devdash-reliability/spec.md`

## Summary

Six user-facing reliability bugs (spec User Stories 1-5) collapse into four
concrete, code-verified root causes (see research.md for full citations):

1. **`down`/`status` never reconnect to prior-invocation state.**
   `orchestrator.Down` and `orchestrator.Status` (and the CLI entry points
   `runDown`/`runStatus` in `cmd/devdash/main.go`) operate on a freshly
   constructed `ProcessManager` whose in-memory `processes` map is always
   empty, because `pm.Reconnect()` — which already exists and already works
   — is never called before they run. This alone explains: `down` never
   actually killing anything (process-group orphans, tmux `remain-on-exit`
   sessions, and their pipe-pane log writers all survive); the next `up`
   hitting a tmux session-name collision and silently falling back to a
   duplicate PTY-spawned process; and `status` reporting every live service
   as "stopped".
2. **tmux-backed services never record a real PID.** `ProcessManager.Start`'s
   tmux branch never sets `SessionInfo.PID`, so persisted state always shows
   `pid 0` for tmux-backed services regardless of liveness.
3. **`AddRoute` isn't idempotent.** It always does a raw config-array POST,
   which Caddy rejects with 400 if a route with the same `@id` already
   exists (e.g. from a prior partially-failed `up`).
4. **`VITE_DEV_PROXY_TARGET` was a stale hardcoded value in local machine
   config, not a devdash limitation** — the generic `{svc}` placeholder
   templating this needs already exists in `orchestrator.ResolveEnv`. Fixed
   directly in `~/.config/devdash/projects/simplx.json`; no code change, no
   task in this plan.

Approach: fix root causes 1-3 surgically in the existing packages
(`internal/process`, `internal/orchestrator`, `internal/proxy`) with unit +
integration tests proving each spec Acceptance Scenario, rather than a
rewrite. No new packages, no new CLI surface.

## Technical Context

**Language/Version**: Go (module `github.com/kimaguri/simplx-toolkit`, see go.mod)

**Primary Dependencies**: `github.com/creack/pty` (PTY backend), system `tmux` binary (optional preferred backend, `-L maomao` socket), system `caddy` binary (reverse proxy, admin API on :2019)

**Storage**: Flat-file registries under devdash's config dir — per-instance JSON (`orchestrator` registry: `ReadInstance`/`WriteInstance`/`DeleteInstance`) and per-session files (`process.SaveSession`/`LoadAllSessions` in `sessionsDir`) — no database

**Testing**: Go `testing` package, table-driven tests co-located as `_test.go` per package; `internal/orchestrator/integration_test.go` and `internal/process/integration_test.go` for cross-package/real-process integration tests (see research.md "Test convention")

**Target Platform**: macOS/Linux developer workstations (darwin/linux × amd64/arm64 per `.goreleaser.yml`)

**Project Type**: CLI tool (single Go module, `cmd/devdash` entry point, `internal/*` packages)

**Performance Goals**: N/A — this is a reliability/correctness fix, not a performance feature. Existing latencies (tmux poll interval 100ms, Caddy admin API 5s timeout, `Stop`'s 5s SIGTERM grace period) are unchanged.

**Constraints**: Fixes must not change devdash's CLI contract (flags, output format, exit codes) documented in `~/.claude/skills/devdash/SKILL.md` and (if present) `specs/001-devdash-orchestrator/contracts/` — this is a compatible bugfix release, not a breaking one. Must work with both backends (tmux-available and PTY-fallback).

**Scale/Scope**: Single-machine, single-operator CLI; concurrently-running instances are already isolated by slug (out of scope to change that model).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is an unfilled template (all
principle sections are still placeholder text — `[PRINCIPLE_1_NAME]` etc.,
never ratified). No project-specific gates are defined to check against.
This plan instead holds itself to the ambient convention already visible in
the codebase: every package under `internal/` has co-located tests, and
`ProxyClient`/`ProcessManager` are already structured for fakes in tests — so
all new/changed behavior in this plan gets unit tests plus an integration
test, matching existing sibling tests (`down_test.go`, `status_test.go`,
`routes_test.go`). No violations to justify; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-devdash-reliability/
├── plan.md              # This file
├── research.md          # Phase 0 output — root-cause findings with file:line citations
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output — manual validation script
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
internal/
├── process/
│   ├── manager.go       # Start/Stop — add tmux PID recording (root cause 2);
│   │                     harden tmux new-session collision handling
│   ├── reconnect.go      # Reconnect/StopReconnected — already correct, wire it up (root cause 1)
│   └── tmux.go           # add #{pane_pid} query alongside existing paneInfoByName
├── orchestrator/
│   ├── down.go           # Down: use pm.StopReconnected via a pre-populated pm
│   ├── status.go          # Status: unaffected once pm is pre-populated by caller
│   └── up.go              # Up: unaffected once pm is pre-populated by caller
├── proxy/
│   └── caddy.go           # AddRoute: PATCH /id/<id> first, POST on 404 (root cause 3)
cmd/devdash/
└── main.go                # runDown/runStatus (and runLogs, for consistency): call pm.Reconnect() before orchestrator.* calls
```

**Structure Decision**: All changes land inside existing packages —
`internal/process`, `internal/orchestrator`, `internal/proxy`, and the CLI
wiring in `cmd/devdash/main.go`. No new packages. This is deliberately the
smallest-blast-radius structure: root cause 1's fix is "call an existing,
already-correct function at three more call sites," not new machinery.

## Complexity Tracking

*No constitution violations — table intentionally empty.*
