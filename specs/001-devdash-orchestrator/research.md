# Phase 0 Research: devdash Multi-Repo Local Dev Orchestrator

All major decisions were resolved in a brainstorming session before spec authoring; this record captures them in decision/rationale/alternatives form. No open `NEEDS CLARIFICATION` remain.

## R1. Reverse proxy: Caddy, managed as a detached external daemon

- **Decision**: Use Caddy as the reverse proxy. devdash ensures it is running by pinging its admin API at `http://localhost:2019/config/`; if unreachable, it launches `caddy start` (which daemonizes Caddy into its own process). Routes are written/removed at runtime via the admin API. Caddy is **never** a child of devdash.
- **Rationale**: `caddy start` detaches, so the proxy and its routes survive devdash exiting and the Claude session ending (FR-019). The admin API gives hot route add/remove without rewriting a file and without reload races (FR-020). Single static binary, automatic `*.localhost` handling, and future automatic HTTPS with no redesign (FR-021). Zero manual setup for the operator — first `up` bootstraps it.
- **Alternatives considered**:
  - *Traefik file-provider* (original spec suggestion): heavier config surface; file-watch reloads are coarser than an admin API; dashboard is its only real edge here. Rejected for complexity.
  - *Caddy as a devdash child process*: simplest to start, but proxy dies with devdash → all routes lost. Rejected (violates FR-019).
  - *`brew services` / launchd unit*: robust but adds an install step and OS-specific units the operator must set up. Rejected in favor of auto-bootstrap; a launchd unit can be added later as an optional convenience.

## R2. Caddy route shape (local vs remote)

- **Decision**: Per service, generate one Caddy route matched on `Host == <slug>-<service>.<domainSuffix>`. Local → `reverse_proxy` to `127.0.0.1:<os-assigned-port>`. Remote → `reverse_proxy` to the configured upstream (e.g. `https://core-test.sadmin.app`) with the upstream Host header set so TLS SNI/vhost routing on the remote works. Routes are tagged/grouped by instance slug so an instance's routes can be removed as a unit.
- **Rationale**: Uniform hostname scheme means the frontend addresses every sibling the same way regardless of local/remote (FR-011, FR-012, SC-003). Host-header rewrite is required for remote HTTPS upstreams that vhost by Host. Instance tagging enables clean per-instance teardown (FR-020, FR-034) without disturbing other instances.
- **Alternatives considered**: One Caddy site block per instance in a Caddyfile written to disk + reload — rejected (reload races, coarse, no clean partial removal). Path-based routing instead of host-based — rejected (breaks cookie/origin isolation and the stable-domain UX).

## R3. Instance identity, slug, and worktree resolution

- **Decision**: Instance = (project, branch). For `worktree` layout the branch is required and names the task; for `single` layout there is no branch and the instance == project. Slug = lowercase, `/`→`-`, `_`→`-`, strip non `[a-z0-9-]`. Worktrees are located by running `git worktree list --porcelain` in each configured repo and matching the branch — reusing existing `internal/discovery` parsing (`parseWorktreeListOutput`, `discoverLinkedWorktrees`).
- **Rationale**: Matches how the operator actually works (one worktree per task per repo). Reuses proven discovery code (FR-009). Slug rules guarantee a valid single DNS label prefix under `*.localhost` (FR-002, FR-004).
- **Alternatives considered**: Deriving instance from cwd only — too fragile when Claude runs from a common dir; kept as *one* of three resolution inputs (FR-039) rather than the sole mechanism. Hashing the branch for the slug — rejected (opaque, un-memorable domains).

## R4. Config model and resolution precedence

- **Decision**: A per-project config declares `name`, `domainSuffix`, `layout` (`worktree|single`), `repos`, and a `services` map (each: `repo`, `package`, `script`, `mode` default, `remote` upstream when remote). Resolution order per project: repo-root `dev.config.json` (if present) → central `~/.config/devdash/projects/<name>.json` → otherwise not orchestratable (falls back to existing per-process TUI launch). Central store is the default path so the operator never must commit config into a repo they don't own.
- **Rationale**: Satisfies FR-005..007 and the hard constraint that some repos cannot hold a config file. Central-first keeps arbitrary third-party projects orchestratable.
- **Alternatives considered**: Config only in simplx-specs — rejected (simplx-specific, breaks "any project"). Config only per-repo (original ТЗ) — rejected (cannot touch some repos).

## R5. Config directory migration (`local-dev` → `devdash`)

- **Decision**: Move the config root from `~/.config/local-dev/` to `~/.config/devdash/`. On startup, if the new dir is absent and the old one exists, migrate `config.json`, `sessions/`, and `logs/` (move or copy) before initializing the ProcessManager, so reconnection to already-running processes (which reads session files by path) still works.
- **Rationale**: FR-008 and the reconnect flow in `cmd/devdash/main.go` depend on session-file paths; a silent rename would orphan live processes' session records. Explicit migration preserves persistence (SC-007).
- **Alternatives considered**: Keep `local-dev` name — rejected (user asked for `devdash`). Symlink old→new — rejected (leaves ambiguity; a one-time migration is cleaner).

## R6. OS-assigned free ports

- **Decision**: Allocate a local port by binding `127.0.0.1:0` (let the OS pick), read the assigned port, close the listener, and pass that port to the dev process via `PORT` env (reusing `config.DevCommand`'s `PORT=` mechanism). Record it in the registry and in the Caddy route.
- **Rationale**: Eliminates collisions across parallel instances with zero manual choice (FR-010, SC-001). Reuses the existing port-as-env launch path.
- **Alternatives considered**: A devdash-managed incrementing port pool — rejected (state to maintain, still collision-prone across machines/other apps). The tiny bind-close-reuse race window is acceptable for a single-developer local tool.

## R7. Plain-text logs, tail, and bounded follow

- **Decision**: Reuse the existing per-process log file (`~/.config/devdash/logs/<session>.log`) and `SanitizeForLog` to strip ANSI, writing/serving a plain-text view distinct from the TUI vterm buffer. `logs` command: default tail ~50 lines; `--tail N` for N; no service arg → merge all instance services with `[service]` line prefixes; `--follow --timeout <dur>` streams new lines then self-terminates at the deadline.
- **Rationale**: Directly addresses the top pain (Claude can't see output) with a cheap "last output" read (FR-023..028, SC-002). Bounded follow guarantees the command never hangs an automated caller.
- **Alternatives considered**: True live attach to the detached process — impossible for a process devdash didn't keep a pipe to; `--tail` is the correct substitute. Structured/JSON logs — out of scope now.

## R8. Headless CLI dispatch coexisting with the TUI

- **Decision**: In `cmd/devdash/main.go`, if `os.Args[1]` is a known subcommand (`up|down|status|logs`), dispatch to the orchestrator and exit; otherwise fall through to the existing TUI path (bare `devdash` and `--help/--version` unchanged). Keep flag parsing per-subcommand with the standard library `flag` package.
- **Rationale**: Preserves FR-041 (bare invocation = TUI, persistence intact) while adding a deterministic scriptable surface (FR-016, FR-029, FR-034). Std `flag` avoids a new dependency.
- **Alternatives considered**: A separate binary `devctl` — rejected (two binaries to install/version; the skill/commands target one name). A cobra/urfave CLI framework — rejected (unnecessary dependency for four subcommands).

## R9. Claude Code integration surface

- **Decision**: One skill `.claude/skills/devdash/SKILL.md` encodes the instance model, config resolution, free-text→flags mapping, and log-on-failure guidance. Four thin slash commands (`/devup`, `/devdown`, `/devstatus`, `/devlogs`) load the skill and forward `$ARGUMENTS`. A `CLAUDE.md` rule forbids direct `pnpm dev`/`npm run dev` and mandates devdash for start/stop.
- **Rationale**: Determinism (slash → skill → strict CLI) with natural-language ergonomics (FR-037..040). The CLAUDE.md prohibition is what actually removes the interactive `pnpm dev` host path.
- **Alternatives considered**: Slash-only (no skill) — can't reliably map free text to flags. Skill-only — no guarantee the model routes through devdash vs improvising. Both together is the resolved design.

## R10. Testing strategy without real Caddy / port 80

- **Decision**: Unit-test pure logic (slug, config precedence, mode-override merge, route-JSON builder, status formatting, log tail/strip). For the up→status→logs→down integration test, run a trivial echo/sleep dev command and inject a fake proxy client (interface over the admin-API calls) so no real Caddy or port 80 is needed in CI.
- **Rationale**: Keeps tests hermetic and fast; isolates the one piece (Caddy) that needs a real external binary behind an interface. Supports TDD per the SimplX constitution.
- **Alternatives considered**: Spinning real Caddy in tests — rejected (flaky, needs port 80/privileges). Skipping integration tests — rejected (up/down lifecycle is the core value and must be covered).
