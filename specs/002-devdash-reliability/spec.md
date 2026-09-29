# Feature Specification: devdash local-run reliability fixes

**Feature Branch**: `002-devdash-reliability`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "LAB-294 devdash reliability fixes (layer 1 — devdash Go tool). Six independent reliability bugs found during real local-dev sessions (LAB-292, LAB-293): process-tree/tmux orphans surviving `down` and blocking the next `up`; misleading/empty logs on crash; `status` lying about liveness; `VITE_DEV_PROXY_TARGET` hardcoded to remote so `--local platform` doesn't actually route locally; Caddy 400 on route re-registration."

**Source**: Plane [LAB-294](https://pub.sadmin.app/simplx/browse/LAB-294/) — "Локальный запуск без плясок: devdash, скрипты core-ui, скиллы local-deploy/devdash". This spec covers layer 1 only (the devdash Go tool itself); layers 2/3 (repo launch scripts, skill docs) were fixed directly in their own repos since they have no spec-kit governance.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - `down` then `up` always yields a clean instance (Priority: P1)

A developer runs `devdash down <instance>` followed by `devdash up` for the same instance (same project+branch), possibly repeatedly across a session. Every `up` must produce fully live services — never a silently-dead service due to leftover state from the prior instance.

**Why this priority**: This is the most common devdash operation (restart a service after a code/env change) and the most frequently broken today — three consecutive `up` calls in a single LAB-292 session all produced dead services with no error.

**Independent Test**: Start an instance, `down` it, `up` it again immediately. All services report live (port/HTTP check) with no manual intervention (no manual `pgrep`/`kill`/`tmux kill-session` needed).

**Acceptance Scenarios**:

1. **Given** a running instance using the process-group backend, **When** the operator runs `down` then `up` again, **Then** no orphaned process from the prior instance holds any service's port, and every service starts and becomes live.
2. **Given** a running instance using the tmux backend, **When** the operator runs `down` then `up` again, **Then** no `tmux` session from the prior instance survives, and every service starts and becomes live inside a fresh session.
3. **Given** a service whose target port is unexpectedly occupied by an unrelated process at `up` time, **When** `up` runs, **Then** `up` reports a clear, specific error naming the port and the service — it does not start a doomed process silently.

---

### User Story 2 - A crashed service is diagnosable from its log alone (Priority: P1)

A developer's service fails to start (e.g. platform crashes on a missing secret before writing any output). The developer must be able to determine why from `devdash logs`, without re-running the service manually in the foreground.

**Why this priority**: LAB-293 documents this costing roughly 30 minutes of a session because the log gave no signal and the operator had to manually run `pnpm run dev` in the foreground to see the real error.

**Independent Test**: Force a service to crash before it emits any stdout (e.g. missing required secret/env var). Run `devdash logs <instance> <service>`. The log must contain the process's stderr output describing the crash, even though stdout was empty.

**Acceptance Scenarios**:

1. **Given** a service process that crashes before writing a single stdout line, **When** the operator reads its log via `devdash logs`, **Then** the log is non-empty and contains the process's stderr output (the actual crash reason).
2. **Given** a service that was stopped and restarted, **When** the operator reads its log immediately after the new `up`, **Then** the log reflects the new process's output, not stale output from a previous, now-dead instance.

---

### User Story 3 - `status` reflects real liveness (Priority: P2)

A developer runs `devdash status` to decide whether to debug a service or move on. The reported state must match reality (is the service actually answering, yes or no).

**Why this priority**: A lying status wastes operator time in both directions — chasing a "stopped" service that's actually fine, or trusting a "running" service that's actually dead. Confirmed on LAB-293: all 4 services were live (HTTP 200/401) while `status` reported "stopped pid 0" for all of them right after a successful `up`.

**Independent Test**: Start an instance. Kill one service's process directly (bypassing devdash). Run `status`. The killed service must report as not-live; the others must report as live.

**Acceptance Scenarios**:

1. **Given** a service process that is alive and answering on its port, **When** `status` is run, **Then** that service is reported as running (not "stopped pid 0").
2. **Given** a service process that has died, **When** `status` is run, **Then** that service is reported as not running (not a stale "pid N").

---

### User Story 4 - `--local platform` actually exercises the local backend (Priority: P2)

A developer runs `up` with platform overridden to local. Requests made through the front app must actually reach the locally-running platform, not silently fall back to the remote test backend.

**Why this priority**: Confirmed on LAB-293 — an operator ran `--local platform`, tested via the browser, and the response came back from remote test with no indication the override had been ignored. This defeats the entire purpose of local backend testing.

**Independent Test**: Start an instance with `--local platform`. Inspect the front dev-server process's environment for its upstream-proxy target. It must point at the local platform's assigned URL, not the remote test URL. A request through the front app must be observably served by the local platform (e.g. a response only the local code path produces).

**Acceptance Scenarios**:

1. **Given** an instance started with `--local platform`, **When** the operator inspects the front process's proxy-target environment variable, **Then** it resolves to the local platform's Caddy-fronted URL for this instance.
2. **Given** an instance started with platform left at its default (remote), **When** the operator inspects the same environment variable, **Then** it resolves to the remote test URL, unchanged from today's behavior.

---

### User Story 5 - Repeated `up` after a failed `up` doesn't hit a routing error (Priority: P3)

A developer's `up` fails partway through (e.g. one service's worktree is missing) after routes for other services were already registered. The developer fixes the issue and runs `up` again for the same instance.

**Why this priority**: Lower frequency than the others but still blocks recovery from a common failure path (partial `up`) without a manual Caddy cleanup step.

**Independent Test**: Trigger a partial `up` failure after at least one route was registered. Fix the underlying issue and run `up` again. It must succeed without a Caddy routing error.

**Acceptance Scenarios**:

1. **Given** an instance whose routes were partially registered by a previous failed `up`, **When** `up` is run again for the same instance, **Then** existing routes are replaced (not rejected as duplicates) and the instance comes up successfully.

### Edge Cases

- What happens when the operator runs `down` for an instance that has no orphans at all (already clean)? Must succeed with no errors, same as today.
- What happens when a service takes several seconds to start responding after `up` returns? `status`/liveness checks must not report a genuinely-still-starting service as failed — see FR-006 for the intended grace period.
- What happens when two different instances (different slugs) each have a service on a distinct port — does one instance's port-conflict check or orphan cleanup ever affect the other instance's processes? It must not.
- What happens when the `{platform}`-style placeholder in `VITE_DEV_PROXY_TARGET` is used for a project/service combination that doesn't exist in config? Must fail with a clear config-resolution error, not resolve to an empty/garbage URL.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `down` MUST terminate every process it started for the instance, including all descendants of each spawned process (not just the direct child), regardless of which process backend (plain process group or tmux) is in use.
- **FR-002**: `down` MUST leave no process holding any port that instance's services used, verifiable immediately after `down` returns.
- **FR-003**: `down` MUST terminate any log-writer process it spawned for the instance, together with the service it was writing for.
- **FR-004**: `up` MUST verify each service's target port is free before spawning that service; if a port is occupied by a process not belonging to this `up` invocation, `up` MUST fail with an error identifying the service and the port, rather than spawning a process that will fail silently.
- **FR-005**: devdash MUST capture and persist a crashed service's stderr output to its log even when the service produced zero stdout output before exiting.
- **FR-006**: `status` MUST determine each service's running/stopped state via an actual liveness check (port and/or HTTP reachability) rather than solely trusting a previously-recorded process id.
- **FR-007**: Project configuration MUST support resolving an env value to any configured service's assigned instance URL via a placeholder token (extending the existing `{core}`/`{mfe}`-style resolution already used elsewhere in the same config), so that `VITE_DEV_PROXY_TARGET` can be set to resolve to the platform service's local-or-remote URL for the current instance.
- **FR-008**: `up` MUST register each service's route idempotently — re-registering a route that already exists (from this or a prior `up`) MUST replace it rather than fail.
- **FR-009**: Log content for a given service instance MUST reflect only that instance's process — an operator reading a service's log right after `up` MUST NOT see stale output left over from a previous, already-terminated instance of that service.

### Key Entities

- **Instance**: A running (project + branch) devdash deployment — the unit that `up`/`down`/`status`/`logs` operate on.
- **Service**: One named process (e.g. `front`, `core`, `mfe`, `platform`) within an instance, either `local` (devdash-managed process) or `remote` (proxied upstream).
- **Process backend**: The mechanism devdash uses to spawn/track a local service's process (plain process group, or tmux session) — both must satisfy the same cleanup guarantees.
- **Route**: The Caddy entry mapping an instance+service's public URL to its local port or remote upstream.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can run `down` immediately followed by `up` for the same instance, any number of times in a row, and every service reaches a live state with zero manual cleanup steps (no manual `pgrep`/`kill`/`tmux kill-session`).
- **SC-002**: When a service crashes before producing any stdout, the operator can identify the root cause from `devdash logs` alone, without needing to manually re-run the service's command in the foreground.
- **SC-003**: `devdash status`, read immediately after a successful `up`, reports 100% of actually-live services as running (zero false "stopped" reports).
- **SC-004**: With `--local platform` specified, requests made through the front app are observably served by the local platform, not the remote test backend.
- **SC-005**: Re-running `up` after a partial failure succeeds on the first retry without a Caddy routing error, with no manual route cleanup.

## Assumptions

- The two existing process backends (plain process group and tmux, per LAB-294's writeup) both remain supported after this fix; the reliability guarantees (FR-001 through FR-003, FR-009) apply equally to both.
- "Local" service liveness for `status`/`up`'s port-check (FR-004, FR-006) means the process is listening on its assigned port; where a lightweight HTTP check is cheaper/more accurate for a given service type, that is an implementation choice, not a scope change.
- The `{platform}` (or equivalent) placeholder mechanism for `VITE_DEV_PROXY_TARGET` (FR-007) is added to the same config-resolution path that already resolves `{core}`/`{mfe}`-style tokens — this spec does not introduce a second, separate templating mechanism.
- Existing users of the `up`/`down`/`status`/`logs` CLI contract (flags, output format) are unaffected — these are reliability fixes to existing behavior, not new CLI surface, except where a new failure mode now produces an explicit error (FR-004) where it previously failed silently.
- Out of scope: layers 2 and 3 of LAB-294 (repo launch scripts in `platform`/`simplx-core`, and skill docs in `~/.claude/skills/`) — already addressed directly in their own repos, no spec-kit governance there.
