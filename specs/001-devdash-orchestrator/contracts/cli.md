# CLI Contract: devdash headless commands

The bare `devdash` (no recognized subcommand) still launches the TUI. `--help`/`--version` unchanged. Four new subcommands are deterministic and script-friendly. Text → stdout; warnings/errors → stderr; exit 0 on success, non-zero on failure. `--json` is NOT implemented this version.

## `devdash up`

```
devdash up --project <name> [--branch <branch>] [--local <svc>]... [--remote <svc>]...
```

- `--project` (required): project id resolved via config precedence (repo-root `dev.config.json` → central).
- `--branch` (required for `worktree` layout; omitted for `single`).
- `--local <svc>` / `--remote <svc>` (repeatable): override that service's default mode.
- Behavior: resolve config → resolve modes → for each service: local ⇒ find worktree by branch in its repo, allocate OS port, `ProcessManager.Start`; remote ⇒ record upstream. Ensure Caddy running (bootstrap detached if absent). Write per-service routes. Write/merge registry. Idempotent: skip already-running services, add missing, never duplicate.
- Missing worktree for a service ⇒ warn to stderr, skip, continue.
- No worktrees for any service ⇒ error "nothing to launch for instance".
- Caddy/port-80 failure ⇒ error, do NOT report instance up.
- Output (stdout): per service one line — `service  mode  URL  [logPath]`; footer with example `devdash logs`/`status` commands.

Example:
```
$ devdash up --project simplx --branch orders-refactor --local core
instance simplx/orders-refactor (slug orders-refactor)
  front     local   http://orders-refactor-front.simplx.localhost      ~/.config/devdash/logs/dev-orders-refactor-front.log
  mfe       local   http://orders-refactor-mfe.simplx.localhost        ~/.config/devdash/logs/dev-orders-refactor-mfe.log
  core      local   http://orders-refactor-core.simplx.localhost       ~/.config/devdash/logs/dev-orders-refactor-core.log
  platform  remote  http://orders-refactor-platform.simplx.localhost   → https://platform-test.sadmin.app
logs:   devdash logs orders-refactor [service] [--tail N]
status: devdash status orders-refactor
```

## `devdash down`

```
devdash down <instance>
```

- `<instance>`: slug (or project name for single layout).
- Behavior: stop the instance's local processes (`ProcessManager.Stop`), remove its Caddy routes (by `<slug>-*` id group), delete its registry file. Remote upstreams and the shared Caddy daemon untouched; other instances unaffected.
- Unknown/already-down instance ⇒ report "not running", exit 0 (non-destructive), no error stack.

## `devdash status`

```
devdash status [instance]
```

- No arg ⇒ all instances grouped by `project/branch`. With arg ⇒ only that instance.
- Per service row: mode, URL, port (local), pid (local), status, log path. Remote services shown as proxy rows with upstream. Reconciles registry intent against live pids.
- Output (text) example:
```
▾ simplx / orders-refactor
    front      local   running  :53412  pid 4123   http://orders-refactor-front.simplx.localhost   ~/.config/devdash/logs/dev-orders-refactor-front.log
    core       local   running  :53588  pid 4130   http://orders-refactor-core.simplx.localhost    ~/.config/devdash/logs/dev-orders-refactor-core.log
    platform   remote  proxy             http://orders-refactor-platform.simplx.localhost → https://platform-test.sadmin.app
```

## `devdash logs`

```
devdash logs <instance> [service] [--tail N] [--follow] [--timeout <dur>]
```

- `<instance>` required; `service` optional (omitted ⇒ all services of the instance, lines prefixed `[service]`).
- `--tail N`: trailing N lines (default exactly **50**).
- `--follow` with `--timeout <dur>` (e.g. `30s`): stream new lines, self-terminate at deadline. Without `--timeout`, follow uses a default cap of **60s**; never blocks indefinitely.
- Output is plain text, ANSI-stripped (`SanitizeForLog`).
- Logs requested for a remote service ⇒ message "service is remote (no local log)", exit 0.

## Exit codes (all subcommands)

| Code | Meaning |
|------|---------|
| 0 | success (including non-destructive no-ops like down of unknown instance) |
| 1 | usage/config error (bad flags, project not orchestratable) |
| 2 | runtime failure (Caddy could not start, port 80 unavailable, process spawn failed) |
