# Research: devdash local-run reliability fixes

Each of spec.md's 6 source bugs was verified against the CURRENT code (not
assumed from the ticket's description — the ticket was written 2026-09-14,
this codebase already has a mature PTY+tmux+reconnect architecture as of
commit 0008161, 2026-09-05, predating the ticket). Findings below are grounded
in file:line citations, not guesses.

## Finding 1 (covers spec bugs 1, 2, 3a, and part of the `up`-repeat symptom): `Reconnect()` exists but is never called by `down`/`status`

`internal/process/reconnect.go` already implements exactly the right thing:
`ProcessManager.Reconnect()` scans persisted session files and re-attaches to
live tmux sessions (`ReconnectTmuxSession`) or live PTY-backed processes
(`IsProcessAlive` + tail the log), populating `pm.processes`. A matching
`StopReconnected()` correctly tears down a reconnected process (tmux
`Kill()`, or process-group SIGTERM→SIGKILL for the PTY case).

**The bug**: `cmd/devdash/main.go` only calls `pm.Reconnect()` once, at line
107 (the interactive TUI launch path). `runDown` (main.go:357, `pm :=
process.NewProcessManager(...)` at :385) and `runStatus` (main.go:311, `pm :=
...` at :330) each construct a **fresh** `ProcessManager` and never call
`Reconnect()` on it before passing it to `orchestrator.Down`/`orchestrator.Status`.

Consequences, traced precisely:
- `orchestrator.Down` (`internal/orchestrator/down.go:36`) calls
  `pm.Stop(svc.SessionName)`. On a fresh, never-reconnected `pm`,
  `pm.processes` is empty, so `Stop` (`internal/process/manager.go:317-324`)
  immediately returns `"process %q not found"`. `Down`'s error handling
  (`down.go:38-43`) treats `"not found"` as "already stopped, non-fatal" and
  silently moves on — **the real tmux session / process group is never
  signaled at all.** This is bugs 1, 2, and 3a in one root cause: the
  process-group kill code (`manager.go:332-354`, correct) and the tmux
  `Kill()` code (`tmux.go:274-305`, correct — it does send Ctrl-C then
  `kill-session`) are both sound, but **`down` never reaches them.**
- `orchestrator.Up` (`internal/orchestrator/up.go:119,132`) uses `pm.Get()`
  the same way to decide whether a service is "already running" and should
  be left alone. On a fresh `pm`, this is always nil, so **every `up` always
  tries to spawn a new process**, even when the prior instance's tmux session
  is still alive (because `down` never killed it — see above, or because the
  service crashed and `remain-on-exit` kept the dead pane around).
  `StartTmuxSession` (`internal/process/tmux.go:94-97`) calls `tmux
  new-session -d -s <name>`, which **fails if a session by that name already
  exists**; the code's fallback comment at `manager.go:164` ("tmux failed,
  fall through to PTY path") then silently spawns a **second**, PTY-backed
  process for the same logical service on a freshly allocated port — this is
  the concrete mechanism behind "the next `up` sees the session name taken
  and silently doesn't start [the expected] process."

**Decision**: wire `pm.Reconnect()` into `runDown` and `runStatus` (and
`runLogs`, for consistency, though `Logs` reads log files from disk directly
and doesn't strictly need in-memory state) before they call into
`orchestrator`. Then route `Down`'s stop call through `pm.StopReconnected`
(which already dispatches correctly to `Stop` when `rp.Cmd != nil`, or the
raw pgid-kill path otherwise) instead of `pm.Stop`. Additionally, harden
`Start()`'s tmux path: if `tmux new-session` fails because the name already
exists, attempt to reconnect+kill the stale session first, then retry, rather
than silently falling back to a duplicate PTY-backed process.

**Alternatives considered**: making every command call `Reconnect()`
unconditionally by moving the call into `NewProcessManager` itself. Rejected
— `Reconnect()` does real I/O (tmux queries, file stats) on every
construction, including in unit tests that build a `ProcessManager` purely as
a value holder; keeping it an explicit, opt-in step at the CLI entry points
(as the TUI path already does) is more testable and keeps `NewProcessManager`
a pure constructor.

## Finding 2 (spec bug 4, "status lies"): two independent causes

**Cause A — same missing-`Reconnect()` gap as Finding 1.**
`orchestrator.Status` (`internal/orchestrator/status.go:34-37`) defines
`live := func(sessionName string) bool { rp := pm.Get(sessionName); return rp
!= nil && ... }`. With `runStatus`'s fresh, never-reconnected `pm`, `pm.Get`
is always nil, so `live()` is always false, so `reconcileStatus`
(`status.go:90-98`) downgrades **every** service whose registry status is
`"running"` to `"stopped"`, unconditionally. This matches the reported
"stopped pid 0" for services that were actually live.

**Cause B — PID is never recorded for tmux-backed services.**
`ProcessManager.Start`'s tmux branch (`internal/process/manager.go:140-161`)
builds `info`/`rp` and calls `SaveSession` **without ever setting
`info.PID`** (contrast the PTY-fallback branch at `manager.go:190`, which
does `info.PID = cmd.Process.Pid`). `orchestrator.Up` then persists whatever
`rp.Info.PID` was into `svc.PID` (`up.go:173`) — for tmux-backed services
this is always the zero value. Since tmux is the preferred backend whenever
`IsTmuxAvailable()` (true on any dev machine with tmux installed, which is
the common case here), **every tmux-backed service's registry entry
permanently shows `pid 0`**, independent of the Cause-A liveness bug.

**Decision**: fix Cause A by reconnecting before `Status` runs (Finding 1's
fix covers this for free). Fix Cause B by having the tmux `Start` branch
resolve and record the actual child PID — tmux exposes it via `#{pane_pid}`
(a `tmux display-message -p '#{pane_pid}'` query, parallel to the existing
`paneInfoByName` helper in `tmux.go:459`) — instead of leaving it at 0.

**Alternatives considered**: dropping the `pid` column from `status` output
for tmux-backed services rather than sourcing a real value. Rejected — the
existing `local-deploy`/`devdash` skill docs and operators already use
`pgrep -fl 'encore run'` as a real-PID cross-check (see `~/.claude/skills/devdash/SKILL.md`,
LAB-294 diagnostic section); a real PID is more useful than hiding the field.

## Finding 3 (spec bug 5, `VITE_DEV_PROXY_TARGET`): not a code bug — config fix, already applied

`internal/orchestrator/env.go`'s `ResolveEnv`/`resolveTemplate` already
implements fully generic `{svc}` / `{svc.host}` placeholder resolution keyed
by **every** service name present in the instance (`env.go:14-30`), already
used for `VITE_SIMPLX_CORE_URL={core}/...` etc. It is not special-cased to
`core`/`mfe` — `{platform}` resolves exactly the same way, to `"http://" +
Domain(slug, "platform", suffix)`, i.e. the same local Caddy-fronted domain
that `up` already points at either the local process or the remote upstream
via `proxy.BuildRoute` (`up.go:183-191`), transparently to the consumer of
the env var.

**Decision**: no devdash code change needed. The bug was purely that
`~/.config/devdash/projects/simplx.json`'s `VITE_DEV_PROXY_TARGET` value was
hardcoded to `"https://platform-test.sadmin.app"` instead of `"{platform}"`.
Already corrected directly in that local config file as part of this
LAB-294 pass (outside this repo/spec — it's user-local machine config, not
version-controlled code).

## Finding 4 (spec bug 6, Caddy 400 on route re-add)

`CaddyClient.AddRoute` (`internal/proxy/caddy.go:138-161`) always does a
plain `POST .../config/apps/http/servers/srv0/routes` (array-append). Caddy's
admin API enforces `@id` uniqueness across the whole config; a `POST` whose
body's `@id` already exists elsewhere in the config is rejected — Caddy
returns 400. This reproduces exactly when a previous `up` already registered
a route for the same instance+service (e.g. a partially-failed `up` that
registered some routes before erroring on a later service) and a retry tries
to `AddRoute` the same `@id` again.

**Decision**: make `AddRoute` an idempotent upsert: first try `PATCH
/id/<r.ID>` (Caddy's in-place object replace, addressed by the same `@id`
tag already set via `CaddyJSON`); if that returns 404 (id not present yet),
fall back to the current `POST .../routes` to create it.

**Alternatives considered**: calling `RemoveRoutesByInstance` (or a
single-route delete) before every `AddRoute`. Rejected — needlessly
introduces a delete+recreate window (brief 404 gap for a route that's
otherwise fine) for the common case where the route doesn't need to change at
all; `PATCH`-then-`POST`-on-404 is a single round trip in the common case and
strictly additive to existing behavior.

## Test convention (for tasks.md)

Every package under `internal/` has co-located `_test.go` files, table-driven
Go tests (see `internal/orchestrator/down_test.go`,
`internal/orchestrator/status_test.go`, `internal/proxy/routes_test.go` for
the existing pattern this feature's tests should match). `ProxyClient` and
`ProcessManager`/`RunningProcess` are already designed for fakes/interfaces in
tests (see `orchestrator/down_test.go`'s pattern of constructing a real
`ProcessManager` against a temp `sessionsDir`/`logsDir` rather than mocking it
— processes really get spawned in tests using short-lived shell commands).
`internal/orchestrator/integration_test.go` and
`internal/process/integration_test.go` hold cross-package integration tests —
the `Reconnect()`-wiring fix and the tmux-name-collision retry belong there
in addition to unit tests on the individual functions.
