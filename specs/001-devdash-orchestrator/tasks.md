# Tasks: devdash Multi-Repo Local Dev Orchestrator

**Feature**: `specs/001-devdash-orchestrator` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

**Tech**: Go 1.25, module `github.com/kimaguri/simplx-toolkit`. Reuse `internal/discovery`, `internal/process`, `internal/config`. New packages `internal/orchestrator`, `internal/proxy`. Caddy external binary (admin API :2019). TDD per plan.md testing strategy (and SimplX constitution once populated — currently the unratified template): test-first for all pure logic.

**Legend**: `[P]` = parallelizable (different files, no incomplete-dep). `[USn]` = user story. Setup/Foundational/Polish carry no story label.

---

## Phase 1: Setup

- [X] T001 Create new package dirs with `doc.go` package decls: `internal/orchestrator/doc.go`, `internal/proxy/doc.go`
- [X] T002 [P] Add `caddy` presence check helper + version note to `internal/proxy/caddy.go` (stub: `CaddyAvailable() bool` via `exec.LookPath`)
- [X] T003 [P] Extend `internal/config/persistent.go`: add `ProjectsDir()` → `~/.config/devdash/projects/` and `InstancesDir()` → `~/.config/devdash/instances/` path helpers (no behavior yet)

---

## Phase 2: Foundational (blocking prerequisites for all user stories)

**Config dir migration + project config + instance model + registry + proxy client + port/env helpers. All user stories depend on these.**

- [X] T004 Change config root in `internal/config/persistent.go` from `~/.config/local-dev` to `~/.config/devdash`; add `MigrateFromLegacy()` that, when new dir absent and `~/.config/local-dev` exists, moves `config.json`, `sessions/`, `logs/` before use (FR-008)
- [X] T005 [P] Unit test migration in `internal/config/persistent_test.go`: legacy dir with a session file → migrated, paths resolve, no data loss
- [X] T006 Call `config.MigrateFromLegacy()` at startup in `cmd/devdash/main.go` before `SessionsDir()`/`Reconnect()` so live processes stay reconnectable (FR-008, FR-041)
- [X] T007 [P] Unit test slug derivation in `internal/orchestrator/instance_test.go`: lowercase, `/`&`_`→`-`, strip non `[a-z0-9-]`, collapse/trim `-`; worktree vs single layout (FR-002)
- [X] T008 Implement `Instance`, `ServiceState` types + `Slug(project, branch, layout)` in `internal/orchestrator/instance.go` (data-model) — make T007 pass
- [X] T009 [P] Unit test config resolution precedence in `internal/config/project_test.go`: repo-root `dev.config.json` wins → central `projects/<name>.json` → `ErrNotOrchestratable` (FR-006, FR-007)
- [X] T010 Implement `ProjectConfig`, `ServiceConfig`, `env` map, JSON load + `ResolveProjectConfig(name, repoPaths)` in `internal/config/project.go` — make T009 pass (FR-005)
- [X] T011 [P] Unit test env template resolution in `internal/orchestrator/env_test.go`: `{service}` → full local URL, `{service.host}` → host only; path suffix `{platform}/api/v1`; scheme `ws://{platform.host}/api/rivet`; unknown placeholder → error. **A `remote`-mode sibling MUST still resolve to its local `<slug>-<svc>.<suffix>` proxy domain, NOT the upstream URL** — this is the local/remote transparency guarantee (FR-012, SC-003)
- [X] T012 Implement `ResolveEnv(env, instance)` in `internal/orchestrator/env.go` — make T011 pass (FR-012)
- [X] T013 [P] Unit test mode-override merge in `internal/orchestrator/resolve_test.go`: defaults from config, `--local` forces local, `--remote` forces remote, unknown service warns+ignored (FR-013)
- [X] T014 Implement `ResolveModes(cfg, localOverrides, remoteOverrides)` + worktree lookup by branch (reuse `discovery.parseWorktreeListOutput`/`git worktree list --porcelain`) in `internal/orchestrator/resolve.go` (FR-009, FR-013, FR-014)
- [X] T015 [P] Unit test free-port allocation in `internal/orchestrator/port_test.go`: bind `127.0.0.1:0`, returns distinct usable ports (FR-010)
- [X] T016 Implement `AllocFreePort()` in `internal/orchestrator/port.go` — make T015 pass (FR-010)
- [X] T017 [P] Unit test instance registry read/write/merge in `internal/orchestrator/registry_test.go`: write `instances/<slug>.json`, idempotent merge keeps running + adds missing, delete on down (FR-015, FR-017)
- [X] T018 Implement registry (`WriteInstance`, `ReadInstance`, `ListInstances`, `DeleteInstance`) in `internal/orchestrator/registry.go` — make T017 pass
- [X] T019 [P] Unit test Caddy route JSON builder in `internal/proxy/routes_test.go`: local → `reverse_proxy 127.0.0.1:<port>`; remote → upstream + Host-header rewrite; `@id = <slug>-<service>` (FR-011, R2)
- [X] T020 Define `ProxyClient` interface + `BuildRoute` JSON in `internal/proxy/routes.go` (interface enables fake in tests) — make T019 pass
- [X] T021 Implement Caddy admin-API client in `internal/proxy/caddy.go`: `EnsureRunning()` (ping :2019, `caddy start` detached if absent, bootstrap base config on :80, clear error if bind fails), `AddRoute`, `RemoveRoutesByInstance` (FR-018, FR-019, FR-020, FR-022)

---

## Phase 3: User Story 1 — Bring up mixed local/remote (Priority P1) 🎯 MVP

**Goal**: `devdash up --project <p> --branch <b> [--local/--remote ...]` brings a task env up with mixed modes, prints URLs+log paths. **Independent test**: quickstart Scenario A/B/C/G.

- [X] T022 [P] [US1] Unit test `up` orchestration with fake ProxyClient + echo dev command in `internal/orchestrator/up_test.go`: local spawns on random port, remote recorded, routes added, registry written, missing worktree skipped+warned, idempotent re-up no duplicates (FR-009..017, US1 AC1–4)
- [X] T023 [US1] Implement `Up(opts)` in `internal/orchestrator/up.go`: resolve config→modes→worktrees, `EnsureRunning`, per-service alloc port + build dev command from `ServiceConfig.package`+`script` (e.g. `pnpm --filter <package> <script>` via `config.DevCommand`, non-interactive) + `process.ProcessManager.Start` (inject `ResolveEnv` + `PORT`), `AddRoute`, merge registry; idempotent (skip running); no-worktrees-at-all → error (FR-009..017, FR-022, FR-040) — make T022 pass
- [X] T024 [US1] Implement `up` result printer in `internal/orchestrator/up.go`: per-service `service mode URL logPath`, footer with example logs/status commands (FR-016; contracts/cli.md)
- [X] T025 [US1] Wire `up` subcommand dispatch + `flag` parsing (`--project`,`--branch`, repeatable `--local`/`--remote`) in `cmd/devdash/main.go`, before TUI fallthrough (FR-041, R8)

**Checkpoint**: `devdash up` works end-to-end (MVP deliverable).

---

## Phase 4: User Story 2 — Inspect logs (Priority P1)

**Goal**: `devdash logs <instance> [service] [--tail N] [--follow --timeout d]` plain-text, ANSI-stripped. **Independent test**: quickstart Scenario D.

- [X] T026 [P] [US2] Unit test log read in `internal/orchestrator/logs_test.go`: tail N default ~50, ANSI stripped via `process.SanitizeForLog`, all-services merge with `[service]` prefix, remote service → "no local log" message, bounded follow self-terminates at timeout (FR-023..028)
- [X] T027 [US2] Implement `Logs(instance, service, opts)` in `internal/orchestrator/logs.go`: resolve log path(s) from registry, tail, strip, merge, bounded follow — make T026 pass
- [X] T028 [US2] Wire `logs` subcommand + flags (`--tail`,`--follow`,`--timeout`) in `cmd/devdash/main.go` (contracts/cli.md)

**Checkpoint**: Claude can read service output on demand.

---

## Phase 5: User Story 3 — Status grouped by instance (Priority P2)

**Goal**: `devdash status [instance]` grouped by project/branch, remote as proxy rows; TUI grouped too. **Independent test**: quickstart Scenario E.

- [X] T029 [P] [US3] Unit test status gather+format in `internal/orchestrator/status_test.go`: read all `instances/*.json`, reconcile pid liveness vs `process.ProcessManager`, group by project/branch, remote proxy rows, single-instance scope (FR-029..031, FR-033)
- [X] T030 [US3] Implement `Status(instanceFilter)` gather+reconcile+text render in `internal/orchestrator/status.go` — make T029 pass
- [X] T031 [US3] Wire `status` subcommand in `cmd/devdash/main.go` (contracts/cli.md)
- [X] T032 [P] [US3] Extend session persistence: add `instance` (slug) + `service` fields to `process.SessionInfo` in `internal/process/state.go` (+ test) so TUI can group; keep back-compat for old session files (FR-032, data-model)
- [X] T033 [US3] Group TUI process list under instance headers, show domain+port, remote proxy rows in `internal/tui/` (FR-032)

**Checkpoint**: parallel instances legible in CLI + TUI.

---

## Phase 6: User Story 4 — Take down (Priority P2)

**Goal**: `devdash down <instance>` stops local, removes routes+registry, leaves others+Caddy. **Independent test**: quickstart Scenario F.

- [X] T034 [P] [US4] Unit test `down` with fake ProxyClient in `internal/orchestrator/down_test.go`: stops local procs, removes instance routes only, deletes registry entry, unknown instance → "not running" exit 0, other instances untouched (FR-034..036)
- [X] T035 [US4] Implement `Down(instance)` in `internal/orchestrator/down.go`: `process.ProcessManager.Stop` per local service, `RemoveRoutesByInstance`, `DeleteInstance`; non-destructive on unknown — make T034 pass
- [X] T036 [US4] Wire `down` subcommand in `cmd/devdash/main.go` (contracts/cli.md)

**Checkpoint**: full up→status→logs→down lifecycle.

---

## Phase 7: User Story 5 — Claude Code integration (Priority P2)

**Goal**: deterministic Claude driving. **Note**: skill + `/devup`/`/devdown`/`/devstatus`/`/devlogs` are authored/distributed in the **dotclaude** repo (cross-repo, separate task per Clarifications Q3); this repo delivers the binary + CLAUDE.md rule.

- [X] T037 [US5] Add rule to `simplx-toolkit/CLAUDE.md`: local envs started/stopped ONLY via devdash; `pnpm dev`/`npm run dev` forbidden; interactive host dev mode not used (FR-040)
- [X] T038 [US5] Author `up --help`/`down`/`status`/`logs --help` text + a `devdash help <sub>` covering instance model, config resolution, examples, so the dotclaude skill can rely on a stable CLI contract (FR-037, FR-039)
- [X] T039 [US5] Write cross-repo handoff `simplx-toolkit/.maomao/handoff.md` (or dotclaude task note) specifying: `skills/devdash/SKILL.md` content (instance=project+branch, free-text→`--local`/`--remote` mapping, log-on-failure), 4 thin slash commands forwarding `$ARGUMENTS`, `simplx`/`personal` preset wiring, `caddy`+`devdash` in `manifests/system-deps.yaml` (FR-037, FR-038; Dependencies)

**Checkpoint**: Claude runs envs deterministically; dotclaude packaging task is specified.

**OUT OF SCOPE (this feature)**: Module Federation dynamic remote resolution — the host resolving the `mfe` remoteEntry URL at runtime as `<slug>-mfe.<suffix>`. Until that separate spec lands, the `mfe` service's full local/remote transparency (US1) is NOT guaranteed; `mfe` local-mode works as a plain dev process, but host↔mfe federation wiring is tracked elsewhere (spec.md Dependencies). Do not treat US1 acceptance as delivering MF transparency for `mfe`.

---

## Phase 8: Polish & Cross-Cutting

- [X] T040 [P] Integration test full lifecycle in `internal/orchestrator/integration_test.go`: up→status→logs→down with echo/sleep dev command + fake ProxyClient, no real Caddy/port 80 (quickstart Scenarios A–F; SC-001..007)
- [X] T041 [P] Update `README.md`: new `up`/`down`/`status`/`logs` commands, config schema (`dev.config.json` + central `projects/<name>.json` with `env` block), Caddy one-time setup, `~/.config/devdash` migration note
- [X] T042 [P] Update `cmd/devdash/main.go` `printUsage()` + config-dir strings (`local-dev`→`devdash`) and add subcommand summary
- [X] T043 Run `make vet` + `make test`; fix regressions; verify bare `devdash` still opens TUI and reconnects (FR-041, SC-007)

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2)** → user stories.
- **Foundational blocks everything**: T004–T021 must complete before any `up`/`down`/`status`/`logs`.
- **US1 (P3)** is the MVP; **US2 (P4)** depends only on Foundational + a running instance to read logs from (test uses fixture). **US3/US4 (P5/P6)** depend on Foundational + registry; independent of each other. **US5 (P7)** depends on the CLI existing (US1–4). **Polish (P8)** last.
- Within a story: test task `[P]` first (TDD RED), then implementation (GREEN).

## Parallel Opportunities

- Setup: T002, T003 parallel.
- Foundational tests are highly parallel: T005, T007, T009, T011, T013, T015, T017, T019 (different files) can be written together; each paired impl follows.
- Cross-story once Foundational done: US2 (T026/T027), US3 (T029/T030), US4 (T034/T035) implementations touch different files → parallelizable.
- Polish: T040, T041, T042 parallel.

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3 (US1)**: bring-up with mixed local/remote. Delivers the core value (zero manual ports, one command).
- Then US2 (logs) — the top operator pain — immediately after MVP.
- Then US3/US4 for visibility + teardown, US5 for Claude ergonomics, Polish for regression safety.
- Ship incrementally: each checkpoint is independently demoable.

## MVP Scope

**User Story 1 (Phases 1–3, T001–T025)** — `devdash up` end-to-end with mixed local/remote, idempotent, URLs+log paths printed.

## Discovered Follow-ups (fold-back, not done in this pass)

- [X] T044 [US3 follow-up] TUI instance grouping is inert until the **legacy** `internal/devdash.SessionInfo` gains `Instance`/`Service` fields AND `up` tags sessions with them. Today the orchestrator (`up`/`status`) uses `internal/process`, while the bubbletea TUI uses a separate `internal/devdash` ProcessManager fork; T032 added the fields to `internal/process.SessionInfo` only, so `internal/tui/dashboard.go` always renders the `(ungrouped)` fallback. Fix: add the two `omitempty` fields to `internal/devdash/state.go` and unify session writing so the TUI reads instance-tagged sessions. FR-032 fully satisfied only after this. Non-blocking — CLI `devdash status` grouping already works.
