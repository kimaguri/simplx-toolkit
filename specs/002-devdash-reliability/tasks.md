# Tasks: devdash local-run reliability fixes

**Input**: Design documents from `specs/002-devdash-reliability/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/cli-behavior-delta.md](./contracts/cli-behavior-delta.md)

**Tests**: Included — this repo's convention (every `internal/` package has co-located `_test.go` files, see research.md "Test convention") is test-first for exactly this kind of change.

**Organization**: Tasks are grouped by user story (spec.md priorities). Per research.md, root causes 1 ("`Reconnect()` never wired into `down`/`status`") and the FR-004 "fail loudly not silently" requirement are **shared** across US1/US3/US4-adjacent behavior, so they live in Phase 2 (Foundational) rather than being duplicated per story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on an incomplete task)
- **[Story]**: Maps to spec.md's User Story 1-5

---

## Phase 1: Setup

No new dependencies, packages, or scaffolding — this feature only touches existing files in `internal/process`, `internal/orchestrator`, `internal/proxy`, `cmd/devdash`. Nothing to do here.

---

## Phase 2: Foundational (blocking prerequisite for US1, US3, and the FR-004 loud-failure requirement)

**Purpose**: Close the "`Reconnect()` exists but nothing calls it at `down`/`status`/`logs` CLI entry points" gap (research.md Finding 1) that is the root cause behind bugs 1, 2, 3a, and the "status lies" (Cause A) bug.

- [X] T001 In `internal/orchestrator/down.go`, change `Down` to call `pm.StopReconnected(svc.SessionName)` instead of `pm.Stop(svc.SessionName)` — `StopReconnected` is the variant that correctly handles a reconnected `RunningProcess` (`Cmd == nil`) by killing the real process group/tmux session directly (see research.md Finding 1 and `internal/process/reconnect.go:98-142`). **Extra fix found during implementation**: `StopReconnected` itself checked `rp.Cmd != nil` before `rp.tmux != nil`, so it mis-routed every reconnected tmux session into the raw-PID kill path (PID always 0 for tmux — root cause 2) instead of `rp.tmux.Kill()`. Fixed in `internal/process/reconnect.go` to check `rp.tmux != nil` first.
- [X] T002 In `cmd/devdash/main.go`, in `runDown` (before `process.NewProcessManager(...)`'s result is passed to `orchestrator.Down`), call `pm.Reconnect()` so `pm.processes` is populated with real tmux/PTY handles for this instance's services before `Down` tries to stop them.
- [X] T003 In `cmd/devdash/main.go`, in `runStatus` (before `orchestrator.Status(...)`), call `pm.Reconnect()` for the same reason — this fixes Cause A of "status lies" (research.md Finding 2).
- [X] T004 [P] `runLogs`/`orchestrator.Logs` never take a `*process.ProcessManager` parameter at all (verified while implementing T002/T003) — there is nothing to reconnect. N/A, no change made.
- [X] T005 [US1] [US3] In `internal/orchestrator/down_test.go`, added `TestDown_CrossInvocation_ActuallyKillsRealProcess`: starts a service via one `ProcessManager`, tears down via a second fresh one (`pm.Reconnect()` + `Down`), and asserts the real tmux session is gone (independent oracle: `tmux -L maomao has-session`). This test is what caught the `StopReconnected` bug in T001.
- [X] T006 [P] [US3] In `internal/orchestrator/status_test.go`, added `TestStatus_CrossInvocation_ReflectsRealLiveness` with the same two-`ProcessManager` pattern, asserting `Status()` reports "running" (not the pre-fix always-"stopped") once reconnected.

**Checkpoint**: With Phase 2 done, `down`/`status` are wired correctly at the CLI layer for both backends' already-correct kill/liveness logic. US1 and US3 still need their own root-cause-specific fixes below (tmux PID recording, tmux name-collision handling) before they're fully done.

---

## Phase 3: User Story 1 - `down` then `up` always yields a clean instance (Priority: P1)

**Goal**: No orphaned process/tmux-session survives `down`; a subsequent `up` never silently duplicate-spawns because a stale tmux session name is still taken.

**Independent Test**: `devdash up` → `devdash down` → `devdash up` (same instance) repeatedly; every cycle ends with all local services live and zero leftover tmux sessions/processes (spec.md SC-001, quickstart.md SC-001 section).

- [X] T007 [US1] **Revised during implementation**: the real fix is wiring `pm.Reconnect()` into `runUp` too (mirroring T002/T003) — `Up()`'s existing idempotency check (`pm.Get`) only works once `pm.processes` is populated, and `Reconnect()` already self-heals a dead-but-`remain-on-exit` tmux session (detects `pane_dead`, calls `onExit()` which kills it) as a side effect of reconnecting, closing off the collision case for the common path. Done in `cmd/devdash/main.go`'s `runUp`. Additionally hardened `internal/process/tmux.go`'s `StartTmuxSession`: on a `new-session` collision it now kills the stale session and retries once (defense-in-depth for the remaining true-race case), instead of the original plan of a pre-check in `manager.go`.
- [X] T008 [US1] In `internal/process/manager.go`, `Start`: restructured so a tmux failure (after T007's retry) now returns an explicit error — the PTY fallback path is reached ONLY when `IsTmuxAvailable() == false`, never as a silent recovery from a tmux error. Satisfies FR-004's "fail loudly, not silently."
- [X] T009 [P] [US1] In `internal/process/tmux_test.go`, added `TestStartTmuxSession_NameCollisionKillsStaleAndRetries`: starts a session, leaves it alive (orphan), starts again with the same name, asserts success and that the second command is what's actually running.
- [X] T010 [US1] In `internal/orchestrator/integration_test.go`, added `TestIntegration_UpDownUp_CrossInvocation`: three separate `ProcessManager` instances (one per simulated CLI invocation) for `up` → `down` → `up`; asserts the second `up` succeeds with exactly one live process for the session, no collision error.

**Checkpoint**: US1 fully done and independently testable/verifiable via quickstart.md's SC-001 steps.

---

## Phase 4: User Story 2 - A crashed service is diagnosable from its log alone (Priority: P1)

**Goal**: A service that crashes before writing any stdout is still diagnosable via `devdash logs`.

**Independent Test**: Force a service to crash before first stdout (missing required secret/env var); `devdash logs` must show the real crash reason (spec.md SC-002, quickstart.md SC-002 section).

> research.md Finding for this story: the tmux backend's `pipe-pane` capture is already wired up *before* the real command starts (`internal/process/tmux.go:100-115`, options configured then `respawn-pane` launches the command), so this should already work for the tmux path — the likely-real gap is the PTY-fallback path (`tmux` not installed).

- [X] T011 [US2] Verified: `readPTY` already writes each read chunk to `logFile` synchronously, before checking the read error, and only returns on a non-nil error (i.e. after draining all available output up to EOF) — confirmed by T012 passing without any code change. No fix needed; research.md's uncertainty here is resolved.
- [X] T012 [P] [US2] Added `TestIntegration_ReadPTY_CapturesInstantCrashOutput` in `internal/process/integration_test.go`: drives `startWithPTY`/`readPTY` directly against a command that writes to stderr and exits immediately; asserts the log file contains the output. Passes against the unmodified code — confirms T011's finding.
- [X] T013 [P] [US2] Added `TestStartTmuxSession_CapturesInstantCrashOutput` in `internal/process/tmux_test.go`: same instant-crash scenario through the tmux backend; asserts `pipe-pane`'s log file contains the output. Passes — locks in the already-correct step ordering (pipe-pane configured before respawn-pane starts the real command).

**Checkpoint**: US2 done — crash-before-stdout is diagnosable on both backends, with regression coverage for the already-correct tmux path.

---

## Phase 5: User Story 3 - `status` reflects real liveness (Priority: P2)

**Goal**: `status` shows real running/stopped state and a real, non-zero pid for tmux-backed services.

**Independent Test**: Start an instance, kill one service directly (bypassing devdash), `status` must show that one as not-live and the others as live (spec.md SC-003, quickstart.md SC-003 section). Depends on Phase 2 (T001-T006) for the liveness-check half; this phase adds the PID-recording half.

- [X] T014 [US3] In `internal/process/tmux.go`, added `panePID(sessName string) int` (queries `#{pane_pid}`, parallel to `paneInfoByName`) and a `TmuxSession.pid` field + `PID()` accessor, populated in both `StartTmuxSession` and `ReconnectTmuxSession`.
- [X] T015 [US3] In `internal/process/manager.go`'s `Start` tmux branch: `info.PID = ts.PID()` before `SaveSession`, so persisted `SessionInfo.PID`/`ServiceState.PID` is real for tmux-backed services.
- [X] T016 [P] [US3] Added `TestTmuxSession_PID` in `internal/process/tmux_test.go`: asserts a started session's PID is positive and `IsProcessAlive` confirms it.
- [X] T017 [P] [US3] In `internal/orchestrator/integration_test.go`, updated `TestIntegration_FullLifecycle`'s subtest A: replaced the now-stale "PID may be 0 for tmux" comment/skip with an assertion that `local.PID > 0`, since tmux now records a real PID too.

**Checkpoint**: US3 done — `status`, after Phase 2 + this phase, reports both accurate liveness and a real pid.

---

## Phase 6: User Story 4 - `--local platform` actually exercises the local backend (Priority: P2)

**Goal**: `VITE_DEV_PROXY_TARGET` resolves to the current instance's platform URL (local or remote, whichever `up` actually assigned), not a hardcoded remote value.

**Independent Test**: spec.md SC-004, quickstart.md SC-004 section.

> **No devdash code change required** (research.md Finding 3) — `internal/orchestrator/env.go`'s `{svc}` placeholder resolution is already fully generic across every service name in the instance, not special-cased to `core`/`mfe`. The bug was a stale hardcoded value in `~/.config/devdash/projects/simplx.json`, already corrected directly as part of this LAB-294 pass (outside this repo — local machine config, not version-controlled code). This phase only adds a regression test locking in the generic behavior, since today's `env_test.go` may only exercise the `core`/`mfe` cases that happened to already work.

- [X] T018 [US4] Checked `internal/orchestrator/env_test.go` before writing a new test: it already covers `{platform}` (not just `core`) extensively — `TestResolveEnv_KeepsPathSuffix`, `TestResolveEnv_HostOnlyAlternateScheme`, and especially `TestResolveEnv_RemoteModeSiblingStillYieldsLocalDomain` (platform is remote-mode in the fixture and the test asserts resolution still yields the local proxy domain, not the upstream — exactly the `VITE_DEV_PROXY_TARGET` scenario). No new test needed; research.md's assumption that coverage was core/mfe-only was wrong.

**Checkpoint**: US4 done (config fix already applied outside this repo; this phase is regression-test-only).

---

## Phase 7: User Story 5 - Repeated `up` after a failed `up` doesn't hit a routing error (Priority: P3)

**Goal**: Re-running `up` after a route was already registered by a prior attempt doesn't fail with a Caddy 400.

**Independent Test**: spec.md SC-005, quickstart.md SC-005 section.

- [X] T019 [US5] In `internal/proxy/caddy.go`, `AddRoute` now attempts `PATCH /id/<r.ID>` first, falling back to `POST .../routes` only on 404. Added a `baseURL` test seam (`CaddyClient.base()`) since `adminBaseURL` was previously a hardcoded unexported constant with no way to point tests at a fake server — needed for T020 to test the real implementation rather than a reimplementation.
- [X] T020 [P] [US5] Created `internal/proxy/caddy_test.go` with `fakeCaddyAdmin` (`httptest`-based fake Caddy admin API). `TestAddRoute_FirstCall_CreatesViaPost`, `TestAddRoute_SecondCall_ReplacesViaPatch_NoDuplicateError` (the core regression test — same route added twice must not 400), `TestAddRoute_DifferentServices_BothCreatedIndependently`.

**Checkpoint**: US5 done — repeated `up` after partial failure no longer surfaces a Caddy 400.

---

## Phase 8: Polish & Cross-Cutting

- [X] T021 `go vet ./...` clean. `go test ./...` — entire module passes, zero failures (all pre-existing packages + this feature's new tests).
- [X] T022 Ran live against a REAL previously-orphaned instance (`fix-intel-176-charge-codes-bugs`, core+front+mfe — genuinely orphaned from a much earlier, pre-fix session, still holding tmux sessions and stale registry state going into this test): `down` actually killed all 3 tmux sessions + cleaned session/instance files (previously impossible — this exact instance had been silently unkillable garbage before this fix). Two full `down`→`up` cycles in a row: zero orphans, all services report `running` with real, live-verified PIDs (cross-checked against `tmux display-message -p '#{pane_pid}'` directly), HTTP 200 through the local Caddy route. Confirmed `VITE_DEV_PROXY_TARGET` in the persisted session env resolves to the local platform Caddy domain, not the hardcoded remote test URL.

---

## Dependencies & Execution Order

- **Phase 2 (Foundational)** blocks Phase 3 (US1) and Phase 5 (US3) — both need `Reconnect()` wired in before their story-specific fixes are testable end-to-end.
- **Phase 3 (US1)**, **Phase 4 (US2)**, **Phase 6 (US4)**, **Phase 7 (US5)** are independent of each other once Phase 2 is done — can be implemented/tested in any order or in parallel (different files).
- **Phase 5 (US3)** depends on Phase 2 only (not on Phase 3/4/6/7).
- **Phase 8 (Polish)** runs last, after all stories are done.

```
Phase 2 (Foundational: T001-T006)
   ├──> Phase 3 (US1: T007-T010)
   └──> Phase 5 (US3: T014-T017)
Phase 4 (US2: T011-T013)        — independent, no Phase 2 dependency
Phase 6 (US4: T018)             — independent, no Phase 2 dependency
Phase 7 (US5: T019-T020)        — independent, no Phase 2 dependency
Phase 8 (Polish: T021-T022)     — after everything else
```

## Parallel Execution Examples

Within Phase 2, T004 can run alongside T001-T003 (different concern, same file `main.go` but a different function — sequence to avoid merge conflicts within the file if working solo; genuinely parallelizable across two agents only if careful about the shared file).

Once Phase 2 is merged, these can run fully in parallel (different files, no shared state):
- T007-T010 (US1, `internal/process/manager.go` + its tests)
- T011-T013 (US2, PTY-fallback logging + tests)
- T014-T017 (US3, tmux PID recording + tests) — note T015 touches `manager.go` too; sequence against T007/T008 if the same person is doing both, otherwise fine in parallel across agents working on different functions in the same file (merge, don't overwrite).
- T018 (US4, test-only)
- T019-T020 (US5, `internal/proxy/caddy.go` + new test file)

## Implementation Strategy

**MVP scope**: Phase 2 (Foundational) + Phase 3 (US1) — this closes the highest-frequency, highest-cost bug (orphans surviving `down`, blocking the next `up`), which spec.md's Why-this-priority notes as costing entire sessions (LAB-292/293). Phase 5 (US3, status accuracy) is a close second since it's what an operator uses to *tell* whether Phase 3's fix worked.

**Incremental delivery**: Phase 2 → Phase 3 → Phase 5 → Phase 4 → Phase 7 → Phase 6 (Phase 6 last since its actual fix is already shipped outside this repo; the task there is regression-test-only) → Phase 8.
