# Phase 1 Data Model: devdash Multi-Repo Local Dev Orchestrator

Entities are Go structs serialized to JSON on disk under `~/.config/devdash/`. Field names below are the intended JSON keys; Go field names are the exported CamelCase equivalents. Values shown are synthetic examples.

## ProjectConfig

Declarative description of an orchestratable project. Loaded from repo-root `dev.config.json` (wins) or central `~/.config/devdash/projects/<name>.json`.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Unique project id, e.g. `"simplx"`. Central file name is `<name>.json`. |
| `domainSuffix` | string | e.g. `"simplx.localhost"`. Per project, not global (FR-003). |
| `layout` | enum `worktree \| single` | `worktree` → instances keyed by branch; `single` → one instance == project (FR-001). |
| `repos` | map[string]string | repo key → absolute or `~`-relative main-repo path. e.g. `{"apps": "~/x/simplx/simplx-apps", "core": "~/x/simplx/simplx-core", "platform": "~/x/simplx/platform"}`. |
| `services` | map[string]ServiceConfig | service key → its config. Key is the `<service>` in the domain. |
| `env` | map[string]string | env-var name → template injected into every local process. Templates use `{service}` (full local URL `http://<slug>-<service>.<suffix>`) and `{service.host}` (host[:port], no scheme). Supports path suffixes and alternate schemes. e.g. `{"VITE_SIMPLX_CORE_URL":"{core}", "VITE_API_URL":"{platform}/api/v1", "VITE_MAINFRAME_URL":"ws://{platform.host}/api/rivet"}`. |

**Validation**: `name` non-empty; `domainSuffix` a valid DNS suffix; `layout` one of the two; every `service.repo` (when local-capable) present in `repos`; a `remote`-default service must have a `remote` URL; every `{service}`/`{service.host}` placeholder in `env` references a declared service.

**Env template resolution (pure, unit-tested)**: `resolveEnv(env, instance)` replaces `{svc}` → `http://<slug>-<svc>.<suffix>`-form URL and `{svc.host}` → `<slug>-<svc>.<suffix>` (host only) for each entry, for all services in the instance regardless of local/remote (always the local domain). Returns `map[ENV_NAME]value` injected into every local process's environment.

### ServiceConfig (nested in ProjectConfig.services)

| Field | Type | Notes |
|-------|------|-------|
| `repo` | string | key into `repos`; where the worktree is looked up when local. Optional for always-remote services. |
| `package` | string | workspace package name for `pnpm --filter` (empty for standalone). |
| `script` | string | dev script name (default `"dev"`). |
| `mode` | enum `local \| remote` | default mode; overridable per `up` invocation (FR-013). |
| `remote` | string | upstream URL when remote, e.g. `"https://core-test.sadmin.app"`. Required if `mode: remote` or if ever forced remote. |

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

## Instance

A concrete runnable unit. Derived at `up` time; persisted in the registry.

| Field | Type | Notes |
|-------|------|-------|
| `project` | string | ProjectConfig.name. |
| `branch` | string | task branch; empty for `single` layout. |
| `slug` | string | derived id: lowercase, `/`&`_`→`-`, strip non `[a-z0-9-]`. e.g. `orders-refactor`. |
| `domainSuffix` | string | copied from project for convenience. |
| `services` | ServiceState[] | resolved per-service runtime records. |
| `createdAt` | int64 | unix seconds (epoch). Stamped by the caller, not inside pure logic. |

**Slug derivation rule (pure, unit-tested)**: `slug(project, branch)` = for `single` → sanitize(project); for `worktree` → sanitize(branch). `sanitize(s)` = lowercase → replace `/`,`_` with `-` → drop every char not in `[a-z0-9-]` → collapse repeated `-` → trim leading/trailing `-`.

## ServiceState

Per-service runtime record inside an Instance. This is the unit the registry tracks and status/logs/down read.

| Field | Type | Notes |
|-------|------|-------|
| `service` | string | service key, e.g. `"front"`. |
| `mode` | enum `local \| remote` | resolved mode after applying overrides. |
| `domain` | string | `<slug>-<service>.<domainSuffix>`, e.g. `orders-refactor-front.simplx.localhost`. |
| `url` | string | `http://<domain>`. |
| `port` | int | local loopback port (0 for remote). |
| `pid` | int | process id (0 for remote). |
| `sessionName` | string | ties to existing `process.SessionInfo.Name` / log file. |
| `worktreePath` | string | resolved worktree dir (empty for remote). |
| `upstream` | string | remote upstream URL (empty for local). |
| `status` | enum `running \| stopped \| error \| remote` | `remote` = proxy row, no local process. |
| `logPath` | string | stable path `~/.config/devdash/logs/<sessionName>.log` (empty for remote). |

**Relationship to existing `process.SessionInfo`**: `sessionName`, `port`, `pid`, `worktreePath` mirror fields devdash already persists per process; ServiceState adds the instance/domain/mode/upstream layer on top. Existing session files are extended (not replaced) with `instance` (slug) and `service` keys so the TUI can group by instance and reconnection still works.

## Registry

Persisted collection of instances. One JSON file per instance at `~/.config/devdash/instances/<slug>.json` containing the `Instance` (with its `ServiceState[]`). The directory listing is the set of active instances.

**Operations**:
- `up` writes/updates `<slug>.json` (idempotent merge: keep running services, add missing — FR-015).
- `status` reads all `instances/*.json`, cross-checks liveness via `process.ProcessManager` (pid alive), groups by `project`/`branch`.
- `down` reads `<slug>.json`, stops local services, removes their routes, deletes the file (FR-034).

**Liveness reconciliation**: a ServiceState marked `running` whose pid is dead is reported `error`/`stopped` on next status; the registry is the intent, the ProcessManager is the truth.

## Route (proxy, not persisted by devdash)

Ephemeral Caddy admin-API object; source of truth lives in Caddy, keyed by instance for group removal.

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `<slug>-<service>` — Caddy `@id` for targeted delete. |
| `hostMatch` | string | `<slug>-<service>.<domainSuffix>`. |
| `upstream` | string | `127.0.0.1:<port>` (local) or the remote URL host:port. |
| `hostHeader` | string | upstream host to present (remote only). |

## State transitions (ServiceState.status)

```
(absent) --up local--> running --down/kill--> stopped
                         |
                         +--pid dies--> error --up--> running
(absent) --up remote--> remote  (no process; removed on down)
```

## Config resolution (pure, unit-tested)

`resolveProjectConfig(projectName, repoPaths)`:
1. For each candidate repo root, if `dev.config.json` exists → parse and return it (repo-root wins).
2. Else if `~/.config/devdash/projects/<projectName>.json` exists → parse and return it.
3. Else return `nil, ErrNotOrchestratable`.

`resolveModes(cfg, localOverrides, remoteOverrides)`: start from each service's default `mode`; apply `--local` (force local), then `--remote` (force remote); unknown service names in overrides produce a warning and are ignored.
