# Quickstart: validating the devdash reliability fixes

Prerequisites: `devdash` built from this branch (`go build -o /tmp/devdash-lab294 ./cmd/devdash`, or run via `go run ./cmd/devdash`), `caddy` and `tmux` on PATH, and an existing `simplx` project instance you can safely start/stop (e.g. any branch with worktrees under `simplx-apps`/`simplx-core`/`platform`).

Use a throwaway instance (a branch not currently in active use) so these steps don't disturb real work.

## SC-001 — `down` → `up` repeatedly, zero manual cleanup (User Story 1)

```bash
devdash up --project simplx --branch <test-branch> --local core
devdash status <test-branch>          # note the reported ports/pids

devdash down <test-branch>
# Before the fix: tmux session `maomao-dev-<slug>-core` and/or the vite
# process group would still be alive here. Check:
tmux -L maomao list-sessions 2>&1 | grep '<slug>' || echo "no leftover tmux sessions — good"
pgrep -fl 'vite' | grep '<slug>' || echo "no leftover vite process — good"

devdash up --project simplx --branch <test-branch> --local core
devdash status <test-branch>          # expect all local services "running", real port/pid
curl -sf http://<slug>-core.simplx.localhost/ >/dev/null && echo "core reachable — good"
```

Repeat the `down`→`up` cycle 3x in a row; every cycle must end with live
services and zero leftover tmux sessions / processes between cycles.

## SC-002 — crash-before-stdout is diagnosable from `devdash logs` alone (User Story 2)

```bash
# Force platform to crash before first stdout line: temporarily rename/hide
# a required secret file in its worktree, then:
devdash up --project simplx --branch <test-branch> --local platform
sleep 2
devdash logs <test-branch> platform --tail 50
# Expect: the actual crash reason (e.g. missing-secret error) appears in the
# log output, not an empty/blank result.
```

## SC-003 — `status` matches real liveness (User Story 3)

```bash
devdash up --project simplx --branch <test-branch> --local core
devdash status <test-branch>          # core: running, pid <real pid>, not 0

# Kill it out-of-band, bypassing devdash:
pgrep -f 'dev-<slug>-core' | xargs kill -9  # or: tmux -L maomao kill-session -t maomao-dev-<slug>-core

devdash status <test-branch>          # core: must now report stopped
```

## SC-004 — `--local platform` actually routes locally (User Story 4)

```bash
devdash up --project simplx --branch <test-branch> --local platform --local core
FRONT_PID=$(pgrep -f 'dev-<slug>-front')
ps eww -p "$FRONT_PID" | tr ' ' '\n' | grep VITE_DEV_PROXY_TARGET
# Expect: resolves to http://<slug>-platform.simplx.localhost, NOT
# https://platform-test.sadmin.app
```

## SC-005 — retry after a partial `up` failure doesn't hit a Caddy 400 (User Story 5)

```bash
# Trigger a partial failure: e.g. temporarily rename a worktree dir so one
# service's `up` step fails after others already registered routes, then:
devdash up --project simplx --branch <test-branch> --local core --local front --local mfe
# (expect a partial failure/warning for the missing-worktree service)

# Restore the worktree, retry:
devdash up --project simplx --branch <test-branch> --local core --local front --local mfe
# Expect: succeeds, no "caddy rejected route ... (status 400)" error.
```

## Cleanup

```bash
devdash down <test-branch>
tmux -L maomao list-sessions 2>&1 | grep '<slug>' || true   # should be empty
```
