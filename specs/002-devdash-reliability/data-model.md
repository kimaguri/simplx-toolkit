# Data Model: devdash local-run reliability fixes

No new entities. This feature fixes reliability gaps in the reconciliation
between two existing pieces of state; documented here for clarity since the
bug is precisely about them going out of sync.

## Existing entities touched

### `orchestrator.Instance` / `orchestrator.ServiceState` (persisted registry, `internal/orchestrator/registry.go`)

The durable record of "what devdash believes is running" for one
project+branch instance. Key fields relevant to this feature:
- `ServiceState.Status` — devdash's *intent* ("running"/"stopped"/"remote"),
  set at `up` time.
- `ServiceState.SessionName` — key used to look up live state (`"dev-<slug>-<service>"`).
- `ServiceState.PID` — currently always 0 for tmux-backed services (root
  cause 2, being fixed).

### `process.SessionInfo` (persisted per-session, `internal/process/state.go`)

The durable record devdash writes when it starts a process — survives the
CLI invocation that started it, and is what `Reconnect()` reads back. Fixed
by this feature to include a real PID for tmux-backed sessions.

### `process.RunningProcess` (in-memory only, `internal/process/manager.go`)

The live, in-process view of a running service — either freshly `Start()`ed
or reattached via `Reconnect()`. **This is the piece that was missing**: for
`down`/`status` (and `up`'s idempotency check), the in-memory
`ProcessManager.processes` map was always empty because nothing populated it
via `Reconnect()` before use. This feature's fix does not change this
struct's shape — it changes *when* `Reconnect()` runs, so this map is
populated with entries reattached from `SessionInfo`/tmux/PID state before
`Down`/`Status`/`Up`'s idempotency check reads it.

## State reconciliation (the actual "model" this feature fixes)

```
   CLI invocation A (`devdash up`)          CLI invocation B (`devdash down`, later)
   ──────────────────────────────           ─────────────────────────────────────────
   pm := NewProcessManager()                pm := NewProcessManager()
   pm.Start(info) → RunningProcess           ✗ (missing) pm.Reconnect()
     ├─ writes SessionInfo to disk           pm.Stop(name)
     ├─ writes Instance/ServiceState              └─ pm.processes[name] → nil
     │    to disk                                      → "not found" → treated as
     └─ pm.processes[name] = live rp                      already-stopped, no-op
   (invocation A process exits; B starts
    fresh — in-memory map from A is gone
    with it, only the on-disk records and
    the real OS-level tmux session / process
    group persist)
```

The fix threads `pm.Reconnect()` into invocation B (and status/logs'
equivalent) so that the on-disk `SessionInfo` is used to re-populate
`pm.processes` with a live handle on the real tmux session / process group
*before* `Stop`/liveness-check runs — closing the gap between "what's on
disk" and "what a fresh CLI invocation can see and act on."
