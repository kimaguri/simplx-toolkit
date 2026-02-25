# maomao Enhancement Plan v2

**Date:** 2026-02-25
**Branch:** feat/toolkit/enhancements
**Based on:** Competitive analysis (Pilot, Ralph, Handler, Conductor, Sidecar, dmux, TD) + dead code audit + user requirements

---

## Design Principles

1. **Control first, autonomy as option** — maomao is an interactive tool, not an autopilot
2. **Finish what's started** — connect existing dead code before adding new features
3. **Adopt patterns, don't integrate** — take ideas from competitors, implement in Go/maomao way
4. **Universal tool** — not simplx-specific, works for any multi-repo project
5. **Preserve unique strengths** — multi-repo worktrees, cross-repo handoff, real PTY, Go single binary

---

## Phase 0: Connect Dead Code (1-2 hours)

**Goal:** Unlock session persistence and agent lifecycle tracking by connecting already-written code.

### 0.1 Enable Reconnect on TUI Start
- **File:** `cmd/maomao/main.go` (in `launchWorkspace()`)
- **What:** Call `pm.Reconnect()` before creating the opener callback
- **Why:** tmux sessions survive TUI restart, but UI doesn't find them. This gives crash recovery for free.
- **Detail:** After reconnect, populate `taskPanes` cache from reconnected processes. Match by process key → task ID.

### 0.2 Use ResumeFlag in BuildCommand
- **File:** `internal/maomao/agent/agent.go`
- **What:** In `BuildCommand()`, check if session already exists (SessionID or worktree has `.maomao/` state). If yes, append `conf.ResumeFlag` to args.
- **Why:** Claude Code `--resume` restores previous conversation context. This is the single biggest UX improvement.
- **Depends on:** 0.3 (SessionID must be written first)

### 0.3 Write SessionID to TaskRepo
- **File:** `cmd/maomao/main.go` (opener callback)
- **What:** After `process.Start()`, write the returned session key to `TaskRepo.SessionID`. Save task.
- **File:** `internal/maomao/task/task.go`
- **What:** Add helper `UpdateRepoSession(taskID, repoName, sessionID)`.

### 0.4 Emit Agent Lifecycle Events
- **File:** `internal/process/manager.go` (or wrapper in `cmd/maomao/main.go`)
- **What:** After process exits, emit `AgentStopped` (exit 0) or `AgentCrashed` (non-zero). On restart, emit `AgentRestarted`.
- **How:** Add `OnExit func(key string, exitCode int)` callback to ProcessManager. Wire it in main.go to call `event.Emit()`.

### 0.5 Enable Status Transitions
- **File:** `internal/maomao/tui/workspace.go`
- **What:** Add keybindings in sidebar for status transitions:
  - `R` — mark task as "review"
  - Done status set automatically when all agents stopped + user confirms
- **File:** `internal/maomao/tui/sidebar.go`
- **What:** Show review/done statuses with distinct colors/icons.

---

## Phase 1: Interactive Mode Overhaul (2-3 hours)

**Goal:** Fix daily pain points — graceful exit + proper key forwarding.

### 1.1 Raw Passthrough in Interactive Mode
- **Problem:** Bubbletea v1.3.10 strips key modifiers (Shift, Cmd). `KeyMsg` only has `Alt` bool — no `Shift`, no `Cmd/Super`. Result: Shift+Enter (newline in Claude Code) arrives as plain Enter (submit). ALL modifier combinations are broken.
- **Root cause:** `keyMsgToBytes()` converts parsed KeyMsg back to bytes, but the parsing already lost modifier info.
- **Solution:** In interactive mode, bypass Bubbletea's key parser entirely. Read raw stdin bytes and forward directly to PTY/tmux.
- **Implementation:**
  - Use `tea.WithInputTTY()` or access raw stdin via custom reader
  - In interactive mode: raw bytes → PTY (passthrough)
  - Intercept ONLY: Esc+Esc sequence (exit interactive) and Tab (switch pane)
  - For tmux backend: `tmux send-keys -H` (hex mode) to send raw bytes preserving all escape sequences
- **Files:** `internal/maomao/tui/workspace.go`, `internal/maomao/tui/termpane.go`, possibly new `internal/maomao/tui/rawinput.go`
- **This fixes:** Shift+Enter, Cmd+key combos (if terminal emulator sends them), all Alt+key combos, any future special keys

### 1.2 Tab Auto-exits Interactive Mode
- **File:** `internal/maomao/tui/workspace.go` → `updateInteractive()`
- **What:** In the raw passthrough, intercept Tab byte (0x09) before forwarding:
  - `Tab` → exit interactive + next pane
  - Mouse click on sidebar/other pane → exit interactive + switch focus
- **Agent continues running** — we just stop forwarding keystrokes.
- **Note:** Since we're in raw mode, we detect Tab as byte 0x09, not as parsed KeyMsg.

### 1.3 Visual Indicator
- **File:** `internal/maomao/tui/termpane.go`
- **What:** When pane is running but NOT interactive, show subtle indicator (e.g. dimmed border or "watching" label). User sees agent is working but they're not typing into it.

### 1.4 Cmd+Enter / macOS Note
- **Cmd+key combinations on macOS are consumed by the terminal emulator** (iTerm2, Terminal.app). They NEVER reach the application, not even in raw mode.
- **Workaround for "delete entire line":** Ctrl+U already mapped in `keyMsgToBytes()` as `\x15` — this is the terminal-standard way to kill a line. Also works in raw passthrough.
- **iTerm2 option:** Users can configure iTerm2 to send custom escape sequences for Cmd+key combos (Preferences → Keys → Key Mappings). Document this for users.

---

## Phase 2: Time Tracking System (4-6 hours)

**Goal:** Track active work time per task with session granularity.

### 2.1 Data Model
- **New file:** `internal/maomao/task/timetrack.go` (~150 lines)

```go
type TimeSession struct {
    ID        string    `toml:"id"`
    StartedAt time.Time `toml:"started_at"`
    EndedAt   time.Time `toml:"ended_at"`    // zero if active
    ActiveSec int       `toml:"active_sec"`  // excludes idle time
    Repos     []string  `toml:"repos"`       // which repos were active
    IdleSec   int       `toml:"idle_sec"`    // detected idle time
}

type TimeLog struct {
    Sessions []TimeSession `toml:"sessions"`
}
```

- **Storage:** `~/.config/maomao/tasks/<id>/timelog.toml`
- **Functions:** `StartSession()`, `EndSession()`, `PauseSession()`, `ResumeSession()`, `GetStats()`, `GetTodayStats()`

### 2.2 Session Lifecycle
- **Start:** task opened + at least one agent running
- **Idle detection:** goroutine checks every 60s — if no PTY output AND no user input for 10 minutes → mark idle start. On next activity → mark idle end, subtract from active time.
- **End triggers:** switch to different task, park task, stop all agents, quit maomao
- **Pause/resume:** switching tasks pauses current, opening previous resumes

### 2.3 Integration Points
- **File:** `cmd/maomao/main.go`
  - `opener` callback → `timetrack.StartSession()`
  - `parker` callback → `timetrack.EndSession()`
  - quit handler → `timetrack.EndSession()` for active task

- **File:** `internal/maomao/tui/workspace.go`
  - Task switch (openTask while another is active) → end old session, start new
  - Track last user input time and last PTY output time for idle detection

### 2.4 Display
- **File:** `internal/maomao/tui/sidebar.go`
  - In task detail block, add:
    ```
    ⏱ Active: 2h 47m (today: 1h 12m)
    📅 Started: Feb 24 | Sessions: 4
    ```
  - Active session shows live counter (updates every minute)

### 2.5 CLI Stats
- **File:** `cmd/maomao/main.go`
  - New subcommand: `maomao stats [task-id]`
  - Output: per-task breakdown, daily aggregation, total active time
  - Format: human-readable table + optional `--json` flag

---

## Phase 3: Session Context Continuity (3-4 hours)

**Goal:** When agent restarts, it knows what happened in the previous session.

### 3.1 Session Summary on Stop
- **File:** `internal/maomao/agent/context.go`
- **New function:** `WriteSessionSummary(params SessionSummaryParams) error`
- **Params:** worktreeDir, lastOutputLines ([]string), timestamp
- **Action:**
  1. Run `git diff --stat` in worktree → list of changed files
  2. Run `git log --oneline -5` → recent commits
  3. Take last 30 lines of agent PTY output (from LogBuf)
  4. Write to `.maomao/session-summary.md`:
     ```markdown
     ## Previous Session (2026-02-25 14:30)

     ### Changes Made
     - internal/auth/handler.go | 45 ++-
     - internal/auth/service.go | 12 +-

     ### Recent Commits
     - abc1234 feat: add JWT validation

     ### Last Agent Output (truncated)
     > Completed implementing JWT validation...
     > Ready to move on to refresh token logic.
     ```

### 3.2 Inject Summary on Restart
- **File:** `internal/maomao/agent/context.go` → `WriteContext()`
- **Change:** Before writing AGENT.md, check if `.maomao/session-summary.md` exists.
  If yes, append its content to AGENT.md under "## Previous Session" section.
- **Result:** Agent reads AGENT.md → sees previous work → continues from context.

### 3.3 Wire into Lifecycle
- **File:** `cmd/maomao/main.go`
  - On agent stop (PaneController.Stop) → call `WriteSessionSummary()`
  - On park → call for all repos in task
  - On quit → call for all active repos
  - On agent crash (via OnExit callback from P0.4) → call with whatever output is available

### 3.4 UI State Persistence
- **New file:** `internal/maomao/config/session.go` (~80 lines)
- **Save on quit:**
  ```toml
  # ~/.config/maomao/session.toml
  last_task = "toolkit"
  focus = "panes"
  pane_idx = 0
  sidebar_hidden = false
  ```
- **Restore on start:** auto-open last task if session.toml exists

---

## Phase 4: Deepen TD Integration (2-3 hours)

**Goal:** Use TD as the structured task/handoff layer instead of reinventing.

### 4.1 Parse TD Output
- **File:** `internal/maomao/tui/tdhelper.go`
- **What:** Instead of raw `td status` text, parse structured data:
  - Task count by status (open/in_progress/in_review/closed)
  - Current task details (title, priority, session info)
- **How:** Use `td status --json` if available, or parse text output with regex

### 4.2 TD-Aware Sidebar
- **File:** `internal/maomao/tui/sidebar.go`
- **What:** Show TD task progress alongside maomao task info:
  ```
  Task: fix/auth-bug
  ⏱ Active: 2h 47m | Sessions: 4
  📋 TD: 3/7 done | 2 in_progress | 1 blocked
  ```

### 4.3 Auto-Handoff via TD
- **File:** `internal/maomao/agent/context.go`
- **What:** On agent stop, run `td handoff` in worktree (best-effort) to create structured handoff entry in TD. This gives next session structured context through TD's handoff system.

### 4.4 TD Session Linking
- **What:** When creating TD session (`td usage --new-session`), capture the session ID and store in TaskRepo.SessionID. Use for analytics and linking.

---

## Phase 5: Diff Pane (2-3 hours)

**Goal:** Quick diff review without leaving TUI (pattern from Sidecar/Conductor).

### 5.1 Diff View
- **File:** `internal/maomao/tui/diffview.go` (~200 lines)
- **What:** New component that renders `git diff` output with syntax coloring:
  - Green = additions, Red = deletions, Cyan = file headers
  - Scrollable with j/k
  - Press `Enter` on file → show full file diff
  - Press `s` → stage file
  - Press `q` or `Esc` → close diff view

### 5.2 Integration
- **Keybinding:** `d` in navigate mode (pane focus) → toggle diff overlay for focused pane's worktree
- **Alternative:** Replace `t` (td status) with a combined status view: diff + td + git status

---

## Phase 6: Lifecycle Hooks (2-3 hours)

**Goal:** Extensibility without code changes (pattern from dmux).

### 6.1 Hook Configuration
- **File:** `internal/maomao/config/config.go`
```toml
[hooks]
on_task_create = ""
on_task_open = ""
on_task_park = ""
on_agent_start = ""
on_agent_stop = "td handoff --auto"
pre_merge = "pnpm test && pnpm type-check"
post_merge = ""
```

### 6.2 Hook Runner
- **New file:** `internal/maomao/hooks/runner.go` (~100 lines)
- **What:** Execute hook scripts with environment variables:
  - `MAOMAO_TASK_ID`, `MAOMAO_REPO_NAME`, `MAOMAO_WORKTREE_DIR`, `MAOMAO_BRANCH`
- **Timeout:** 30 seconds per hook
- **Output:** Captured and shown in event log

### 6.3 Wire Hooks
- Add `hooks.Run("on_agent_stop", env)` calls at each lifecycle point in main.go callbacks

---

## Phase 7: Refactoring (ongoing, parallel)

**Goal:** Bring oversized files under 500-line limit.

### 7.1 Split workspace.go (1221 → 6 files)
- `workspace.go` — struct, Init, Update dispatch, helpers (~200 lines)
- `workspace_navigate.go` — updateNavigate, updateSidebarKeys, updatePaneKeys (~250 lines)
- `workspace_interactive.go` — updateInteractive (~50 lines)
- `workspace_overlay.go` — updateOverlay, handleOverlayResult (~200 lines)
- `workspace_view.go` — View(), renderConfirmation, renderTdOverlay (~200 lines)
- `workspace_handoff.go` — handoff scan/detect/deliver/result (~100 lines)

### 7.2 Split main.go (759 → 2 files)
- `main.go` — CLI commands, flags, init (~250 lines)
- `callbacks.go` — all launchWorkspace callbacks extracted (~450 lines, then further split)

### 7.3 Split manager.go (699 → 3 files)
- `manager.go` — Start, Stop, Restart, core lifecycle (~300 lines)
- `reconnect.go` — Reconnect logic (~100 lines)
- `io.go` — readPTY, tailFile, helpers (~200 lines)

### 7.4 Centralize Styles
- **New file:** `internal/maomao/tui/styles.go`
- Move all repeated lipgloss styles from sidebar.go, workspace.go, statusbar.go, termpane.go

---

## Execution Order

```
Phase 0 (1-2h)     ← FIRST: connect dead code, instant value
  ↓
Phase 1 (2-3h)      ← Interactive mode: raw passthrough + Tab auto-exit
  ↓
Phase 7.1 (2-3h)    ← Refactor workspace.go (prerequisite for Phase 2-5)
  ↓
Phase 2 (4-6h)      ← Time tracking (highest user value)
  ↓
Phase 3 (3-4h)      ← Session context continuity
  ↓
Phase 4 (2-3h)      ← TD integration deepening
  ↓
Phase 5 (2-3h)      ← Diff pane
  ↓
Phase 6 (2-3h)      ← Lifecycle hooks
  ↓
Phase 7.2-7.4        ← Remaining refactoring (parallel with any phase)
```

**Total estimated active work: ~22-30 hours across all phases.**

---

## What We DON'T Build (and why)

| Rejected Idea | Source | Why Not |
|---|---|---|
| Full execution engine / autopilot | Ralph, Pilot | User wants control first; autonomy is future option |
| Plugin system (shared libs) | Ralph | 2 agents, TOML config sufficient; Go plugins are problematic |
| Token/cost metrics | Pilot | Can't extract from PTY; focus on TIME instead |
| A2A protocol support | Handler | Premature, no ecosystem yet |
| Ticket system integrations (Jira, Linear) | Pilot | Different product category |
| Handlebars prompt templates | Ralph | AGENT.md is simpler and agent-agnostic |
| Model routing (Haiku/Opus/Sonnet) | Pilot | We don't control which model the agent uses |
| A/B agent comparison | dmux | Nice-to-have, not core need; revisit later |
| Web console | Pilot | TUI-first philosophy |

---

## Future Backlog (post v2)

- Autonomous execution mode (config.mode = "autonomous")
- A/B agent comparison (run 2 agents on same task)
- PR creation/tracking in TUI
- Conversation history aggregation (like Sidecar)
- Cross-project memory (SQLite knowledge graph like Pilot)
- Webhook notifications (Slack/Telegram)
- `maomao brief` — daily summary report
- Hot upgrade (`maomao upgrade`)
