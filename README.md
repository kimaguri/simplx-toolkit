# devdash

TUI dashboard for launching, monitoring, and managing local dev processes. Built with [Bubbletea](https://github.com/charmbracelet/bubbletea).

Processes run in the background and persist after quitting — re-running `devdash` reconnects to them automatically.

![Go](https://img.shields.io/badge/Go-1.25-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Install

```bash
# Homebrew (macOS/Linux)
brew install kimaguri/simplx-toolkit/devdash

# Go install
go install github.com/kimaguri/simplx-toolkit/cmd/devdash@latest

# From source
git clone https://github.com/kimaguri/simplx-toolkit.git
cd simplx-toolkit
make build
```

## Quick Start

```bash
devdash
```

On first run, the Settings overlay opens automatically. Add one or more **scan directories** — parent folders containing your git repos (e.g. `~/projects`). devdash will discover all repos, worktrees, and launchable projects within them.

Press `n` to launch a process, `enter` to view logs fullscreen, `q` to quit (processes keep running).

## Features

- **Auto-discovery** — scans for git repos, worktrees, Encore apps, and Node.js projects
- **Split-pane dashboard** — process list + live log viewer side by side
- **Fullscreen log view** — dedicated log viewer with search, visual selection, and copy
- **Process persistence** — processes survive TUI restarts; reconnect seamlessly
- **Interactive mode** — forward keyboard input directly to a running process PTY
- **Clipboard** — copy logs via OSC52 (works over SSH) with native fallback
- **Monorepo support** — detects pnpm workspaces, uses `--filter` automatically
- **Port management** — auto-detects ports from config files, saves overrides per project

## Views

### Dashboard (default)

Split-pane view: process list on the left, log viewer on the right.

```
┌─ Sessions ──────────┬─ Logs ──────────────────────────────┐
│ * api-gateway :4000  │ [12:30:01] Server started on :4000  │
│   core-ui     :4173  │ [12:30:02] Ready in 1.2s            │
│ ! foreman-bot :3001  │ [12:30:03] Watching for changes...  │
│                      │                                     │
└──────────────────────┴─────────────────────────────────────┘
 n:launch  k:kill  r:restart  enter:fullscreen  s:settings  q:quit
```

Status indicators: `*` running (green), `-` stopped (yellow), `!` error (red).

### Fullscreen Log View

Press `enter` on any session. Full-width log viewer with search (`/`), visual selection (`v`), and interactive mode (`i`).

### Launch Wizard

Press `n` to start. Five steps:

1. **Worktree** — pick a git repo (sorted by last commit)
2. **Project** — pick a project within the repo
3. **Script** — pick a dev script from package.json (skipped for Encore)
4. **Port** — set the port (auto-detected or manual)
5. **Confirm** — review and launch

### Settings

Press `s` to manage scan directories. Add paths, remove old ones, or rescan to pick up new repos.

## Keyboard Shortcuts

### Global

| Key | Action |
|-----|--------|
| `n` | Launch new process |
| `k` | Kill selected process |
| `r` | Restart selected process |
| `enter` | Fullscreen log view |
| `s` | Settings |
| `tab` | Switch focus between panels |
| `q` / `ctrl+c` | Quit (processes keep running) |

### Process List

| Key | Action |
|-----|--------|
| `up` / `k` | Select previous |
| `down` / `j` | Select next |

### Log Viewer (dashboard + fullscreen)

| Key | Action |
|-----|--------|
| `G` | Jump to bottom (enable auto-scroll) |
| `g` | Jump to top |
| `c` | Copy visible lines to clipboard |
| `y` | Copy entire log buffer to clipboard |
| `v` | Enter visual line selection |
| `/` | Open search |
| `i` | Enter interactive mode |

### Search (activate with `/`)

| Key | Action |
|-----|--------|
| *type* | Search query (case-insensitive) |
| `enter` | Confirm query, enter navigate mode |
| `n` | Next match |
| `N` | Previous match |
| `esc` | Close search |

Match count shown as `[3/15]` in the search bar.

### Visual Selection (activate with `v`)

| Key | Action |
|-----|--------|
| `j` / `down` | Extend selection down |
| `k` / `up` | Extend selection up |
| `G` | Select to end |
| `g` | Select to start |
| `ctrl+d` | Page down |
| `ctrl+u` | Page up |
| `y` | Copy selection and exit |
| `esc` | Cancel selection |

### Interactive Mode (activate with `i`)

Forwards all input to the running process PTY. Useful for interactive prompts, password entry, or debugging.

| Key | Action |
|-----|--------|
| `esc esc` | Exit interactive mode (two Esc presses within 500ms) |
| *everything else* | Sent to process stdin |

### Fullscreen Log View

| Key | Action |
|-----|--------|
| `q` / `esc` | Return to dashboard |
| All log viewer keys | Same as above |

### Launch Wizard

| Key | Action |
|-----|--------|
| `up` / `k` | Previous item |
| `down` / `j` | Next item |
| `enter` | Next step / confirm |
| `esc` | Previous step / cancel |

### Settings

| Key | Action |
|-----|--------|
| `a` | Add scan directory |
| `d` / `x` | Remove selected directory |
| `r` | Rescan directories |
| `esc` | Close and save |

### Confirmation Dialog

| Key | Action |
|-----|--------|
| `y` | Confirm |
| `n` | Cancel |
| `tab` / arrows | Switch between Yes/No |
| `enter` | Select focused button |
| `esc` | Cancel |

## Project Detection

devdash auto-discovers projects in your scan directories:

| Type | Detection | Command |
|------|-----------|---------|
| **Encore** | `encore.app` file | `encore run --port {PORT}` |
| **pnpm workspace** | `pnpm-workspace.yaml` + packages | `pnpm --filter {pkg} run {script}` |
| **Node.js (pnpm)** | `pnpm-lock.yaml` | `pnpm run {script}` |
| **Node.js (npm)** | `package-lock.json` | `npm run {script}` |
| **Node.js (yarn)** | `yarn.lock` | `yarn run {script}` |
| **Node.js (bun)** | `bun.lockb` | `bun run {script}` |

**Port detection** — automatically parsed from `vite.config.ts`, `webpack.config.js`, and `.env.local`.

**Git worktrees** — detected and grouped with their parent repo, sorted by last commit time.

## Configuration

All data stored in `~/.config/devdash/` (migrated automatically from the
legacy `~/.config/local-dev/` — see [Config directory migration](#config-directory-migration)):

```
~/.config/devdash/
├── config.json       # Scan directories and port overrides
├── sessions/         # Session state (one JSON per process)
├── logs/             # Process logs (persist across restarts)
├── projects/         # Central per-project orchestrator config (<name>.json)
└── instances/         # Orchestrator instance registry (<slug>.json)
```

### config.json

```json
{
  "scan_dirs": [
    "/Users/me/projects",
    "/Users/me/work"
  ],
  "port_overrides": {
    "platform:gateway": 4000,
    "simplx-apps:host": 5173
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `scan_dirs` | `string[]` | Directories to scan for git repos |
| `port_overrides` | `map[string]int` | Saved port per `worktree:project` pair |

### Session Files

Each running process has a session file at `~/.config/devdash/sessions/{name}.json`:

```json
{
  "name": "dev-platform-gateway",
  "pid": 12345,
  "port": 4000,
  "command": "encore",
  "args": ["run", "--port", "4000"],
  "work_dir": "/Users/me/projects/platform",
  "started_at": 1705333200
}
```

Sessions are cleaned up when a process is killed via devdash.

## Process Lifecycle

### Launch

1. Wizard collects worktree, project, script, and port
2. Process spawned with PTY (pseudo-terminal) in a new process group
3. Session file written, log file created
4. Live output streams to dashboard

### Background Persistence

Quitting devdash (`q`) does **not** stop processes. They continue running in the background. Re-launching devdash reconnects to all active sessions via PID check.

### Kill

Sends `SIGTERM` to the entire process group (including child processes), waits up to 5 seconds, then `SIGKILL` if still running. Session file is deleted.

### Restart

Kills the process, then re-launches with the same configuration.

## Clipboard

Copy operations work two ways:

1. **OSC52** — terminal escape sequence that works over SSH and in most modern terminals (iTerm2, WezTerm, Alacritty, kitty, etc.)
2. **Native fallback** — `pbcopy` on macOS, `xclip`/`xsel` on Linux

Feedback shown in the status bar: `[Copied N lines]`.

## CLI

```
devdash              Start the TUI dashboard
devdash --help       Show help
devdash --version    Show version
```

## Multi-Repo Orchestrator

Beyond the TUI, devdash can bring up a whole per-task environment spread
across several git-worktree repositories with a single deterministic
command — no manual port assignment, no hand-managed URLs. Each service is
reached at a stable domain `<slug>-<service>.<domainSuffix>` behind a
shared [Caddy](https://caddyserver.com/) reverse proxy, transparently
mixing locally-spawned dev processes with remote test-server upstreams.

### Commands

#### `devdash up`

```
devdash up --project <name> [--branch <branch>] [--local <svc>]... [--remote <svc>]...
```

Resolves the project config, resolves each service's mode (config default,
overridden by `--local`/`--remote`), locates each local service's worktree
by branch, spawns it on an OS-assigned free port, ensures Caddy is running,
writes routes for every service (local and remote), and records instance
state in the registry. Idempotent — re-running `up` for an already-up
instance starts only what's missing.

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

#### `devdash down`

```
devdash down <instance>
```

Stops the instance's local processes, removes its routes (the
`<slug>-*` group) and registry entry. Remote upstreams and the shared
Caddy daemon are left untouched, and other instances are unaffected. An
unknown or already-down instance is reported as "not running" (exit 0,
non-destructive).

#### `devdash status`

```
devdash status [instance]
```

Lists running instances grouped by `project/branch` (or just one, when
named). Each row shows mode, URL, port and pid (local), status, and log
path; remote services appear as proxy rows with their upstream.

```
▾ simplx / orders-refactor
    front      local   running  :53412  pid 4123   http://orders-refactor-front.simplx.localhost   ~/.config/devdash/logs/dev-orders-refactor-front.log
    core       local   running  :53588  pid 4130   http://orders-refactor-core.simplx.localhost    ~/.config/devdash/logs/dev-orders-refactor-core.log
    platform   remote  proxy             http://orders-refactor-platform.simplx.localhost → https://platform-test.sadmin.app
```

#### `devdash logs`

```
devdash logs <instance> [service] [--tail N] [--follow] [--timeout <dur>]
```

Prints a service's output as plain text with ANSI escapes stripped.
Omitting `[service]` merges all of the instance's services, each line
prefixed `[service]`. `--tail N` defaults to 50 trailing lines.
`--follow` streams new output until `--timeout` elapses (default cap
60s — never blocks indefinitely). Requesting logs for a remote service
reports "service is remote (no local log)" rather than erroring.

Run `devdash <sub> --help` or `devdash help <sub>` for full flag and
example details on any of the above.

### Project configuration

A project can be configured either in a repo-root `dev.config.json` file
(takes precedence when present) or centrally at
`~/.config/devdash/projects/<name>.json`. Central config lets an operator
fully configure a project without needing write access to any of its
repos.

Example (`~/.config/devdash/projects/simplx.json`):

```json
{
  "name": "simplx",
  "domainSuffix": "simplx.localhost",
  "layout": "worktree",
  "repos": {
    "apps": "~/x/simplx/simplx-apps",
    "core": "~/x/simplx/simplx-core",
    "platform": "~/x/simplx/platform"
  },
  "services": {
    "front":    { "repo": "apps",     "package": "host",    "script": "dev", "mode": "local" },
    "mfe":      { "repo": "apps",     "package": "plugins", "script": "dev", "mode": "local" },
    "core":     { "repo": "core",     "package": "core-ui", "script": "dev", "mode": "remote", "remote": "https://core-test.sadmin.app" },
    "platform": { "repo": "platform", "package": "",        "script": "dev", "mode": "remote", "remote": "https://platform-test.sadmin.app" }
  },
  "env": {
    "VITE_SIMPLX_CORE_URL": "{core}",
    "VITE_API_URL":         "{platform}/api/v1",
    "VITE_MAINFRAME_URL":   "ws://{platform.host}/api/rivet"
  }
}
```

- `layout`: `worktree` (instances keyed by branch) or `single` (the
  project itself is the one instance, no branch).
- `repos`: repo key → main-repo path, used to locate each service's
  worktree when local.
- `services`: per-service `repo`/`package`/`script` (for `pnpm --filter`),
  default `mode` (`local`/`remote`, overridable per `up` invocation), and
  `remote` upstream URL (required when the mode is or can become `remote`).
- `env`: a map of `ENV_NAME → template` injected into every local
  process, so a service addresses its siblings by stable domain without
  caring whether a sibling is local or remote (this is the local/remote
  transparency guarantee). Templates support two placeholders:
  - `{service}` → the sibling's full local URL, e.g.
    `VITE_SIMPLX_CORE_URL: "{core}"` resolves to
    `http://orders-refactor-core.simplx.localhost`.
  - `{service.host}` → host[:port] only, no scheme — for path suffixes
    (`VITE_API_URL: "{platform}/api/v1"`) or alternate schemes
    (`VITE_MAINFRAME_URL: "ws://{platform.host}/api/rivet"`).

### Caddy prerequisite

The orchestrator relies on [Caddy](https://caddyserver.com/) as the shared
reverse proxy. One-time setup:

- Install `caddy` and make sure it's on `PATH`.
- Nothing else to configure — `devdash up` auto-starts Caddy detached
  (admin API on `:2019`) the first time it's needed, and reuses the same
  running instance for subsequent instances.
- Caddy binds the standard HTTP port `:80` (clean URLs, no `:port`
  suffix). On macOS this is normally permitted for the user; on Linux you
  may need to grant the binary the capability once:
  `sudo setcap cap_net_bind_service=+ep $(which caddy)`. If the bind
  fails, `up` reports a clear error and does not report the instance as
  up — it does not silently fall back to another port.

### Config directory migration

Prior versions stored everything under `~/.config/local-dev/`. This is
migrated automatically and transparently to `~/.config/devdash/` (config,
`sessions/`, `logs/`) the first time any devdash command runs after
upgrading — no manual steps, and already-running processes stay
reconnectable.

## Development

```bash
# Build
make build

# Run tests
make test

# Static analysis
make vet
```

## License

MIT
