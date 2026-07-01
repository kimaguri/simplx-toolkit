# Feature Specification: devdash Multi-Repo Local Dev Orchestrator

**Feature Branch**: `001-devdash-orchestrator`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: headless CLI + Claude Code skill that extends the existing `devdash` tool so a whole per-task local environment (spread across several git-worktree repositories) can be brought up, taken down, inspected, and log-read with single deterministic commands — addressing services by stable domain names instead of hand-managed ports, and transparently mixing local processes with remote test-server upstreams.

## Overview

Simplex-style projects consist of several repositories of one application (e.g. `front`, `mfe`, `core`, `platform`). Work happens in parallel `git worktree` branches, one worktree per task per repo. Today, running several tasks at once forces manual port assignment: risk of collisions, remembering which port each service uses, passing ports between services. This is cognitive overhead and a frequent source of breakage.

This feature removes ports from manual handling. Each service is reached by a stable, predictable domain of the form `<slug>-<service>.<domainSuffix>`. A reverse proxy routes by hostname to either a locally spawned dev process (on an OS-assigned random port) or a remote test-server upstream. A human operator drives it from a terminal; Claude Code drives it deterministically via a skill plus thin slash commands, without re-inventing ports or commands each session.

This extends the existing `devdash` Go tool (which already provides git repo/worktree/project discovery, background process lifecycle with persistence, per-process logs, and a TUI). It reuses that discovery, process, and config machinery and adds: a headless command surface, a reverse-proxy routing layer, an instance-grouping model, and Claude Code integration.

## Clarifications

### Session 2026-07-01

- Q: How does a local service learn its siblings' URLs, given real projects use non-uniform env-var names (e.g. `VITE_SIMPLX_CORE_URL`, `VITE_API_URL`, `VITE_MAINFRAME_URL`)? → A: A project-level `env` map of `ENV_NAME → template`, where templates use `{service}` (full local URL) and `{service.host}` (host[:port], no scheme) placeholders. devdash resolves the templates to the services' local domains and injects all entries into every local process. This covers path suffixes (`{platform}/api/v1`), one-service-to-many-names, alternate schemes (`ws://{platform.host}/api/rivet`), and arbitrary env names. The map is per-instance (applied to all local processes); per-service scoping is deferred (YAGNI) until a real need arises.
- Q: Which HTTP port does the shared Caddy proxy bind, given port <1024 may need privileges? → A: Fixed port 80 (clean URLs without a `:port` suffix). devdash relies on the OS/Caddy allowing the bind (macOS permits `:80` for the user; Linux via `cap_net_bind_service` on the caddy binary). If the bind fails, `up` reports a clear error with remediation guidance (grant the capability / one-time sudo) and does NOT report the instance as up. A configurable port is deferred.
- Q: Where do the Claude-integration artifacts (devdash skill + `/devup`/`/devdown`/`/devstatus`/`/devlogs` slash commands) live and how are they installed? → A: They are authored in the `dotclaude` repo (`skills/devdash/`, `commands/dev*.md`), wired into the `simplx` (and `personal`) preset, with `caddy` and the `devdash` binary added to `dotclaude`'s `manifests/system-deps.yaml`, and installed by dotclaude's standard `install.sh` into `~/.claude`. `dotclaude` is the single source of truth for these artifacts. `simplx-toolkit` ships only the `devdash` binary and the `CLAUDE.md` rule mandating devdash-only local startup. This is a cross-repo dependency: authoring/distribution of the skill and slash commands is a `dotclaude` task, tracked separately from the `simplx-toolkit` implementation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bring up a task environment with mixed local/remote services (Priority: P1)

An operator (human or Claude Code) working on task branch `orders-refactor` wants the app running locally: `front` and `mfe` as local dev processes from their worktrees, while `core` and `platform` are served from their respective remote test hosts. One command brings the whole environment up and prints the URLs to reach it.

**Why this priority**: This is the core value — one command replaces manual, per-service, port-juggled startup across multiple repos. Without it nothing else matters.

**Independent Test**: With a project config declaring the four services and their default modes, issuing the "up" command for branch `orders-refactor` yields reachable domains for all four services (two backed by fresh local processes, two proxied to remote hosts), and the frontend can call the other services through their local domains without any port knowledge.

**Acceptance Scenarios**:

1. **Given** a configured worktree-layout project with services `front`/`mfe` (local) and `core`/`platform` (remote), **When** the operator brings up instance `orders-refactor`, **Then** local processes for `front` and `mfe` start on OS-assigned free ports, proxy routes are created for all four services at `orders-refactor-<service>.<domainSuffix>`, and the command prints each service's URL, mode, and log-file path.
2. **Given** the same project, **When** the operator brings it up but overrides `core` to local and `platform` stays remote, **Then** `core` is spawned as a local process from its worktree and `platform` continues to proxy to its remote host, with the frontend unaffected (it still addresses both via their local domains).
3. **Given** a worktree is missing for one declared service, **When** the operator brings the instance up, **Then** that service is skipped with a warning and all other services still come up.
4. **Given** an instance is already up, **When** the operator issues "up" again for it, **Then** no duplicate processes are created, only missing services are started, and already-running services are reported as such.

---

### User Story 2 - Inspect logs of a running service (Priority: P1)

An operator needs to see what a running service is doing — especially Claude Code diagnosing a failure — without reading an entire log file and without ANSI/TUI noise.

**Why this priority**: The top pain today is that the automated operator cannot see service output when it launches things. A first-class, clean, on-demand log view is required for the tool to be usable by Claude Code at all.

**Independent Test**: For a running instance, requesting logs for a service returns the last N lines of that service's output as plain text (no ANSI escapes), quickly, and the same content is available at a stable, predictable file path that can be read directly.

**Acceptance Scenarios**:

1. **Given** a running local service, **When** the operator requests its logs, **Then** the last ~50 lines are printed as plain (ANSI-stripped) text by default.
2. **Given** a running local service, **When** the operator requests logs with a tail count, **Then** exactly that many trailing lines are returned.
3. **Given** a running instance, **When** the operator requests logs without naming a service, **Then** output from all of the instance's services is shown, each line attributable to its service.
4. **Given** a running service, **When** the operator requests a bounded follow, **Then** new output streams for at most the specified duration and then the command exits on its own (never hangs indefinitely).

---

### User Story 3 - See everything that is running, grouped by task (Priority: P2)

An operator wants to know what is currently up, organized by task (project + branch), so parallel tasks are legible rather than a flat process soup — both in the terminal (for a human) and in the TUI.

**Why this priority**: Visibility across parallel instances prevents confusion and orphaned processes, but the environment can be operated (up/down/logs) without it, so it ranks below the core lifecycle and logging.

**Independent Test**: With two instances of one project and one instance of another running, a status request lists all instances grouped by project/branch, and for each service shows its mode, URL, port (for local), process id (for local), status, and log path — including remote services shown as proxy rows.

**Acceptance Scenarios**:

1. **Given** several instances running, **When** the operator requests status, **Then** output is grouped by instance (project/branch), and each service row shows mode, URL, port, pid, status, and log path.
2. **Given** an instance with remote services, **When** the operator requests status, **Then** remote services appear as proxy rows showing their upstream target, distinct from local rows.
3. **Given** a specific instance name, **When** the operator requests status for just that instance, **Then** only that instance's services are listed.
4. **Given** the TUI is open, **When** processes are running under multiple instances, **Then** the process list is grouped under instance headers with local domain and port shown per service.

---

### User Story 4 - Take a task environment down (Priority: P2)

An operator finishes with a task and wants its local processes stopped and its routes cleaned up, without disturbing other running tasks or shared infrastructure.

**Why this priority**: Necessary for hygiene and to free resources, but the environment delivers value once "up" and "logs" work; teardown is the natural completion of the lifecycle.

**Independent Test**: With two instances up, taking one down stops exactly that instance's local processes, removes exactly its routes and registry entry, and leaves the other instance fully operational and the shared proxy still running.

**Acceptance Scenarios**:

1. **Given** an instance with local processes and proxy routes, **When** the operator takes it down, **Then** its local processes are stopped, its routes and registry entry are removed, and its remote upstreams and the shared proxy daemon are left untouched.
2. **Given** two instances running, **When** one is taken down, **Then** the other instance's services remain reachable and running.

---

### User Story 5 - Claude Code drives the environment from a free-text phrase (Priority: P2)

The operator tells Claude Code, in natural language, which parts of a task to run locally vs. from the test server (e.g. "platform local, core remote"), and Claude Code deterministically brings the right environment up — inferring which project and branch from the working context — without inventing ports or commands.

**Why this priority**: This is the ergonomic payoff that motivates the whole feature, but it sits on top of the deterministic CLI (Stories 1–4); the CLI must exist and be correct first.

**Independent Test**: Given the operator is working within a known project/worktree context and issues the up slash-command with free text naming per-service overrides, Claude Code resolves the correct project and branch, translates the phrase into strict per-service mode selections, and the corresponding environment comes up — and Claude Code never starts a dev server by any means other than devdash.

**Acceptance Scenarios**:

1. **Given** Claude Code is operating inside a project's worktree/common directory, **When** the operator invokes the up command with free-text service overrides, **Then** the project and branch are inferred from context and the overrides are applied to the correct instance.
2. **Given** Claude Code is operating elsewhere but is told which project and task branch to use, **When** the operator invokes the up command, **Then** the project is resolved from central configuration and the task's worktrees are located across the project's repos by branch.
3. **Given** a service has failed to start, **When** Claude Code inspects the situation, **Then** it retrieves that service's logs via the logs command/path and reports the cause.
4. **Given** any request to run a local dev server, **When** Claude Code acts, **Then** it uses devdash exclusively and never invokes a package-manager dev command directly.

---

### Edge Cases

- **No config for project**: a scanned repo has neither a repo-root config file nor a central project entry → the project is simply not orchestratable as an instance; it remains launchable per-process via the existing TUI flow, and instance commands report it as unconfigured.
- **Proxy not running on first up**: the shared proxy is not yet up when the first instance is brought up → it is started automatically (detached) before routes are written.
- **Proxy already running**: subsequent ups reuse the existing proxy and only add their routes.
- **Port 80 unavailable / permission denied**: bringing up cannot bind the shared HTTP entrypoint → the operator is told clearly why the proxy could not start, and no partial/misleading "success" is reported.
- **Duplicate up (idempotency)**: covered in Story 1 — no duplicate processes; missing services filled in; running ones reported.
- **Branch has no worktree in any repo**: up finds no worktrees for the branch at all → the operator is told the instance has nothing to launch rather than silently doing nothing.
- **Down of an unknown/already-down instance**: reported as not-running rather than erroring destructively.
- **Config directory migration**: the existing on-disk config/sessions/logs location differs from the new one → prior running processes and saved settings are migrated or clearly re-homed so persistence and reconnection are not silently lost.
- **Service name collision across slugs**: two different task branches use the same services → their domains differ by slug, so routes never collide.
- **Logs requested for a remote (proxied) service**: there is no local process/log → the operator is told the service is remote and has no local log, without erroring.
- **Free-text override names an unknown service**: Claude Code's parsed override references a service not in the project config → the operator is warned and the unknown service is ignored rather than fabricated.

## Requirements *(mandatory)*

### Functional Requirements

#### Instance & naming model

- **FR-001**: The system MUST model a runnable unit as an "instance" identified by project plus branch; for worktree-layout projects the branch names the task, and for single-layout projects the instance is the project itself with no branch.
- **FR-002**: The system MUST derive a "slug" from the instance identity by lowercasing, replacing `/` and `_` with `-`, and stripping characters invalid in a hostname label.
- **FR-003**: The system MUST address each service of an instance by the domain `<slug>-<service>.<domainSuffix>`, where `domainSuffix` is taken from the project's configuration (not a global constant).
- **FR-004**: The system MUST route service domains without requiring edits to the OS hosts file (relying on `*.localhost` resolving to loopback).

#### Configuration

- **FR-005**: The system MUST read a per-project configuration that declares: project name, domain suffix, layout (worktree or single), the set of repositories, and a map of services; each service declares its repository, package/script to run, default mode (local or remote), and — when remote — its upstream target.
- **FR-006**: The system MUST resolve configuration in this order: a config file at a repository root takes precedence when present; otherwise a central per-project config store is used; otherwise the project is treated as not orchestratable.
- **FR-007**: The system MUST allow a project to be fully configured centrally so the operator is never required to place a config file into a repository they cannot or should not modify.
- **FR-008**: The system MUST migrate or re-home the existing on-disk configuration, sessions, and logs to the new location such that previously running processes remain reconnectable and saved settings are preserved.

#### Bring up

- **FR-009**: The system MUST, on "up", locate each service's worktree by branch across the project's repositories.
- **FR-010**: The system MUST spawn each local-mode service as a background dev process bound to an OS-assigned free port, never a hand-chosen fixed port.
- **FR-011**: The system MUST create a routing rule per service: local services route to their local loopback port; remote services route to the configured upstream with the upstream's host identity presented to that upstream.
- **FR-012**: The system MUST inject sibling addresses into every local process via a project-level `env` map (`ENV_NAME → template`), where templates use `{service}` (the service's full local domain URL) and `{service.host}` (host[:port] without scheme) placeholders; the system MUST resolve these templates to the services' local domains at bring-up so that a service addresses its siblings by domain and is unaware whether a sibling is local or remote. The map MUST support path suffixes (e.g. `{platform}/api/v1`), multiple env names pointing at one service, and non-HTTP schemes (e.g. `ws://{platform.host}/api/rivet`).
- **FR-013**: The system MUST allow per-invocation overrides of a service's default mode (force a service local, or force it remote) without editing configuration.
- **FR-014**: The system MUST skip a declared service whose worktree is absent, emit a warning, and continue bringing up the remaining services.
- **FR-015**: The system MUST be idempotent on repeated "up" for the same instance: it MUST NOT create duplicate processes, MUST start only services not already running, and MUST report already-running services.
- **FR-016**: The system MUST, after "up", print each service's resulting URL, its mode, its log-file path, and example commands for reading logs.
- **FR-017**: The system MUST record instance state (which services, their modes, ports, process ids, worktree paths, upstreams) in a registry used to prevent duplicate launches, drive status, and enable correct teardown.

#### Reverse proxy lifecycle

- **FR-018**: The system MUST ensure a single shared reverse proxy is running before writing routes, starting it automatically if absent.
- **FR-019**: The system MUST run the shared proxy detached from the tool's own process lifetime, so the proxy and its routes survive the tool exiting and the controlling session ending.
- **FR-020**: The system MUST add and remove per-instance routes on the running proxy without disrupting routes belonging to other instances.
- **FR-021**: The system MUST serve over plain HTTP on the standard HTTP port for this version, with the routing design not precluding a later addition of HTTPS.
- **FR-022**: When the shared proxy cannot be started (e.g. the HTTP port is unavailable), the system MUST report the failure clearly and MUST NOT report the affected instance as successfully up.

#### Logs

- **FR-023**: The system MUST expose each service's output as plain text with ANSI escape sequences removed, distinct from any TUI rendering buffer.
- **FR-024**: The system MUST return, on request, the trailing lines of a service's log (a sensible default count, and an operator-specified count when given).
- **FR-025**: The system MUST support requesting logs for a whole instance (all its services) with each line attributable to its originating service.
- **FR-026**: The system MUST support a bounded follow mode that streams new output for at most an operator-specified duration and then terminates on its own.
- **FR-027**: The system MUST write logs to stable, predictable file paths so they can be read directly without going through the tool.
- **FR-028**: When logs are requested for a remote (proxied) service, the system MUST report that the service has no local log rather than erroring.

#### Status & visibility

- **FR-029**: The system MUST list running state grouped by instance (project/branch), showing for each service its mode, URL, port and process id (for local), status, and log path.
- **FR-030**: The system MUST include remote services in status output, presented as proxy rows showing their upstream target and distinguishable from local rows.
- **FR-031**: The system MUST support scoping status output to a single named instance.
- **FR-032**: The system MUST group the TUI process list under instance headers and show each service's local domain and port.
- **FR-033**: The system MUST provide status as human-readable text in this version; a machine-readable form is a planned later addition and not required now.

#### Teardown

- **FR-034**: The system MUST, on "down", stop the named instance's local processes, remove its routes, and remove its registry entry.
- **FR-035**: The system MUST leave remote upstreams and the shared proxy daemon untouched on "down", so other instances continue running.
- **FR-036**: The system MUST report a down request for an unknown or already-stopped instance as not-running rather than performing a destructive or misleading action.

#### Claude Code integration

- **FR-037**: The system MUST provide a Claude Code skill that encodes the instance (project+branch) model, configuration resolution, translation of a free-text per-service request into strict per-service mode selections, and where to read logs on failure.
- **FR-038**: The system MUST provide thin slash commands for up, down, status, and logs whose behavior is to load the skill and forward the operator's free text, so the skill produces deterministic tool invocations.
- **FR-039**: The system MUST support inferring the target project and branch from the working context when Claude Code operates inside a project's worktree or common directory, and resolving them from stated project + branch (via central config) otherwise, and from an explicitly provided path + branch for arbitrary projects.
- **FR-040**: The project MUST carry an instruction that local environments are started and stopped only through this tool and that direct package-manager dev commands are forbidden, so startup is deterministic and the interactive host dev mode is not needed (the tool runs it non-interactively in the background).
- **FR-041**: The existing bare invocation of the tool MUST continue to open the TUI, and existing background-process persistence and reconnection MUST keep working.

### Key Entities *(include if feature involves data)*

- **Project**: a named application spanning one or more repositories; carries domain suffix, layout (worktree/single), the list of repositories, and the service map. Source of truth for what an instance can contain.
- **Service**: one addressable component of a project (e.g. `front`, `mfe`, `core`, `platform`, `bot`); has a default mode (local/remote), the repository/package/script to run when local, and an upstream target when remote.
- **Instance**: a concrete running unit = project + branch (or project alone for single-layout). Has a slug and a set of live service states.
- **Service State**: per-service runtime record within an instance — resolved mode, local port and process id (when local), upstream (when remote), status, domain, worktree path, and log path.
- **Registry**: the persisted collection of instances and their service states, used to prevent duplicate launches, render status, and drive teardown.
- **Route**: a proxy rule mapping a service domain to a destination (local loopback port or remote upstream) for a given instance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can bring up a full multi-repo task environment with a single command and zero manual port decisions; across any number of simultaneously running task instances there are zero port collisions.
- **SC-002**: A running service's most recent output can be inspected in a single command that returns plain text and does not require reading the whole log.
- **SC-003**: A frontend service reaches its sibling services identically whether a sibling is local or remote; switching one sibling between local and remote requires no change to the frontend.
- **SC-004**: Bringing up an already-running instance a second time results in the same set of processes (no duplicates) and a clear report of what was already running.
- **SC-005**: Taking one instance down leaves every other running instance fully reachable and the shared proxy still serving.
- **SC-006**: Claude Code translates a natural-language "which parts local, which remote" instruction into the correct environment without the operator specifying ports or dev commands, and never starts a dev server outside the tool.
- **SC-007**: The pre-existing TUI, background-process persistence, and reconnection continue to work after the change (no regression).

## Assumptions

- `*.localhost` resolves to loopback on the operator's OS (current macOS/Linux behavior), so no hosts-file editing is needed.
- The standard HTTP port is available for the shared proxy on the operator's machine; if not, the operator resolves the conflict (the tool reports it clearly).
- Each remote service has a single, stable test-server upstream declared in configuration; different services may have different upstream hosts.
- One Claude Code session generally corresponds to one task (one worktree/branch), which is what makes context-based instance inference reliable; explicit project+branch is the fallback when it does not.
- The operator has the repositories checked out with per-task worktrees created by their normal workflow; this feature locates existing worktrees and does not create them.
- HTTPS, and a machine-readable status format, are intentionally deferred and not part of this version.

## Dependencies

- **Module Federation dynamic remote resolution (separate spec)**: For the front/mfe pair, the host must resolve the mfe remote entry URL at runtime as `<slug>-mfe.<domainSuffix>` instead of a static build-time remote. This spec assumes that work is handled separately; full transparency of local/remote for the mfe service depends on it.
- **Existing devdash capabilities (reused, not rebuilt)**: git repo/worktree/project discovery, background process lifecycle with persistence and reconnection, per-process log capture, and existing configuration handling.
- **A reverse proxy with a runtime admin/route API and a detached run mode** available on the operator's machine.
- **dotclaude packaging (cross-repo, separate task)**: the devdash skill and `/devup`/`/devdown`/`/devstatus`/`/devlogs` slash commands are authored in and distributed by the `dotclaude` repo (via the `simplx`/`personal` presets and `manifests/system-deps.yaml` listing `caddy` + `devdash`); this `simplx-toolkit` feature delivers the binary and the `CLAUDE.md` rule, while skill/command authoring and install wiring are tracked as a `dotclaude` task.
