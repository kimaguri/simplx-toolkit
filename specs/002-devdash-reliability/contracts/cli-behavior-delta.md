# CLI behavior delta: devdash reliability fixes

Supplements `specs/001-devdash-orchestrator/contracts/cli.md`. No flags,
output format, or exit codes change. The following observable behaviors
change (all strictly toward correctness — a caller that only checked exit
codes / grepped for known strings is unaffected):

## `devdash down <instance>`

- **Before**: always reported "instance not running"/success even when local
  processes/tmux sessions were, in reality, still alive afterward.
- **After**: actually terminates every local process/tmux session it
  previously started for the instance before removing routes and deleting
  the registry entry. Still returns `(false, nil)` / exit 0 for an
  already-absent instance (unchanged no-op contract).

## `devdash status [instance]`

- **Before**: local services always rendered as `stopped` regardless of real
  state; `pid` was always `0` for tmux-backed services.
- **After**: `running`/`stopped` reflects real liveness; `pid` is a real,
  non-zero process id for tmux-backed services once running.

## `devdash up ...`

- **New failure mode**: if a service's target port is occupied by a process
  outside this `up` invocation's own management, `up` now fails with an
  explicit error naming the service and port, instead of silently spawning a
  process that immediately dies. This is a new, additive error case — it
  does not change behavior for the success path.
- Retrying `up` after a prior attempt partially registered Caddy routes no
  longer fails with `"caddy rejected route ... (status 400)"`.

## `devdash logs <instance> [service]`

- Unaffected directly, but benefits from the `down`/`up` fixes: log content
  for a freshly `up`'d service is no longer contaminated by, or confused
  with, a still-alive prior instance's output.
