# maomao TUI — Current Architecture Analysis

**Date:** 2026-02-24
**Branch:** feat/toolkit/enhancements

---

## 1. Project Structure

```
simplx-toolkit/
  cmd/
    maomao/main.go          -- Main binary: multi-repo agent orchestrator (753 lines)
    local/main.go           -- Second binary: devdash (Dev Process Dashboard)
  internal/
    maomao/                  -- maomao-specific packages
      agent/                 -- AI agent management, context, handoff protocol
      config/                -- Global config (~/.config/maomao/config.toml)
      event/                 -- Event system (JSONL log)
      log/                   -- Zerolog logger
      repo/                  -- Git operations (worktree, branch)
      task/                  -- Task persistence (TOML)
      tui/                   -- TUI components (workspace, sidebar, panes, overlays)
    config/                  -- Shared config for devdash
    discovery/               -- Project and worktree discovery
    process/                 -- Process management (PTY, VTerm, LogBuffer, Tunnel)
    tui/                     -- TUI components for devdash (older system)
```

---

## 2. TUI Framework

**Charmbracelet Bubbletea** (Elm Architecture):

| Dependency | Version | Purpose |
|---|---|---|
| `charmbracelet/bubbletea` | v1.3.10 | Core TUI framework |
| `charmbracelet/bubbles` | v1.0.0 | Ready-made components |
| `charmbracelet/lipgloss` | v1.1.0 | Styling and layout |
| `charmbracelet/x/ansi` | v0.11.6 | ANSI processing |
| `charmbracelet/x/vt` | v0.0.0-... | Virtual terminal (SafeEmulator) |
| `creack/pty` | v1.1.24 | PTY management |
| `google/renameio/v2` | v2.0.2 | Atomic file writes |
| `pelletier/go-toml/v2` | v2.2.4 | TOML parser |
| `rs/zerolog` | v1.34.0 | Structured logging |
| `spf13/cobra` | v1.10.2 | CLI framework |
| `atotto/clipboard` | v0.1.4 | System clipboard |
| `aymanbagabas/go-osc52/v2` | v2.0.1 | OSC52 terminal clipboard |

---

## 3. Current Features

### 3.1 Multi-Repo Task Management
- File: `internal/maomao/task/task.go`
- Tasks bound to multiple repos, persisted as TOML (`~/.config/maomao/tasks/<id>/task.toml`)
- Statuses: `active`, `parked`, `review`, `done`
- Auto-creates git worktrees per repo in task
- Park and delete tasks (with option to keep/delete branches)

### 3.2 AI Agent Orchestration
- File: `internal/maomao/agent/`
- Agents configured via `config.toml` (Claude, Codex, etc.)
- Auto-detection of agent availability (`agent.go:13`)
- Context files: `.maomao/AGENT.md` generated per agent (`context.go:78`)
- Auto-appends to `CLAUDE.md` in worktree (`context.go:129`)
- Builds launch commands (`agent.go:34`)

### 3.3 Cross-Repo Handoff Protocol
- File: `internal/maomao/agent/handoff.go`
- Agents create `.maomao/handoff.md` for inter-repo communication
- Periodic scanning every 2 seconds (`tui/handoff.go:28`)
- Parses Target/Priority from markdown
- Marks delivered handoffs (rename to `.delivered`)
- TUI overlay for approve/reject

### 3.4 Embedded Terminal Panes
- File: `internal/maomao/tui/termpane.go`
- Each repo gets its own terminal pane with PTY
- Live rendering via VTerm (`process/vterm.go`)
- Horizontal pane layout (`workspace.go:805-811`)
- Fullscreen mode for focused pane
- 7-color palette for different panes
- Loading spinner during agent startup

### 3.5 Repository/Worktree Discovery
- File: `internal/discovery/worktree.go`
- Scans directories from `scan_dirs` config
- Git repo detection up to 2 levels deep
- Linked worktree discovery via `git worktree list --porcelain`
- Main project detection for worktrees
- Sorted by last commit date

### 3.6 Process Management
- File: `internal/process/manager.go` (549 lines)
- PTY-based process launch (real TTY for interactivity)
- VTerm virtual terminal for live rendering
- Session persistence for reconnect
- Graceful shutdown (SIGTERM -> SIGKILL after 5s)
- Cloudflare Quick Tunnels support
- Ring buffer for logs (10,000 lines)

### 3.7 Event System
- File: `internal/maomao/event/`
- JSONL storage (`events.jsonl`)
- Rotation at 10MB
- Event types: task lifecycle, agent lifecycle, handoff, message, story
- CLI command `maomao logs` for viewing

### 3.8 Cross-Pane Messaging
- File: `internal/maomao/tui/message.go`
- Manual messaging between panes (key `m`)
- Two-step overlay: select target pane -> enter text
- Message injected into target agent PTY

---

## 4. UI Components

### 4.1 Workspace (root component)
- File: `workspace.go:75-108` (1107 lines total — OVER LIMIT)
- Modes: `modeNavigate`, `modeInteractive`, `modeOverlay`
- Focus: `focusSidebar`, `focusPanes`
- Layout: sidebar (25%, min 20, max 40) | panes (rest, horizontal split)

### 4.2 Sidebar
- File: `sidebar.go` (391 lines)
- Logo "マオマオ maomao" in anime style
- Task list with status indicators (blue=running, gray=cached, circle=not started)
- Detail block for selected task (type, status, repos, git status)
- Event timeline (recent events)
- Scrolling with sticky header
- Full border with focus-adaptive color

### 4.3 TermPane
- File: `termpane.go` (261 lines)
- States: idle, running, stopped, error
- Title bar with name and status
- Color-coded borders (dim when unfocused, yellow in interactive mode)
- Direct PTY writing via `keyMsgToBytes()` converter

### 4.4 Overlay System
- File: `overlay.go` (333 lines)
- Types: overlayNewTask, overlayAddRepo, overlayHandoff, overlayMessage
- Two-step process: stepSelectRepo -> stepTypeBranch

### 4.5 StatusBar
- File: `statusbar.go` (133 lines)
- Zellij-style bottom status line
- Colored "pill" with current mode (NAVIGATE / INTERACTIVE)
- Context-sensitive key hints

### 4.6 Wizard
- File: `wizard.go` (202 lines)
- First-run environment check
- Auto-creates configuration
- Three phases: review -> apply -> done

---

## 5. Keybindings

### Navigate Mode — Sidebar Focus
| Key | Action | File:Line |
|-----|--------|-----------|
| `j` / `down` | Navigate down | sidebar.go:38 |
| `k` / `up` | Navigate up | sidebar.go:42 |
| `enter` | Open task | workspace.go:377 |
| `n` | New task | workspace.go:381 |
| `d` | Delete task | workspace.go:389 |
| `r` | Refresh list | workspace.go:396 |
| `tab` | Switch to panes | workspace.go:309 |
| `b` | Toggle sidebar | workspace.go:299 |
| `q` / `ctrl+c` | Quit (confirm) | workspace.go:296 |

### Navigate Mode — Pane Focus
| Key | Action | File:Line |
|-----|--------|-----------|
| `i` | Enter interactive mode | workspace.go:403 |
| `s` | Stop agent | workspace.go:410 |
| `r` | Restart agent | workspace.go:432 |
| `f` | Fullscreen toggle | workspace.go:445 |
| `p` | Park task | workspace.go:448 |
| `a` | Add repo to task | workspace.go:472 |
| `g` | Launch lazygit | workspace.go:493 |
| `t` | Show td status | workspace.go:519 |
| `y` | Copy pane content | workspace.go:527 |
| `m` | Send message to other pane | workspace.go:534 |
| `tab` | Next pane | workspace.go:309 |
| any char | Auto-enter interactive mode | workspace.go:546 |

### Interactive Mode
| Key | Action | File:Line |
|-----|--------|-----------|
| `Esc Esc` (double) | Exit interactive (300ms window) | workspace.go:566 |
| `ctrl+v` | Paste clipboard | workspace.go:582 |
| any other | Forward to agent PTY | workspace.go:592 |

### Mouse Support
- Left click: switch focus (sidebar / pane selection)
- Scroll wheel: PageUp/PageDown in focused pane

---

## 6. Data Flow

### State Management
All state in `Workspace` struct (workspace.go:75-108):
- mode, focus, sidebar, panes[], paneIdx, statusBar
- activeID (current task), taskPanes (cache by task)
- overlay, handoffOvl, msgOverlay

### Component Communication
Message-based (standard Bubbletea):
- `taskOpenMsg` — open task
- `paneRefreshMsg` — VTerm refresh every 50ms
- `overlayResultMsg` — overlay result
- `handoffScanMsg/handoffDetectedMsg/handoffResultMsg` — handoff lifecycle
- `messageResultMsg` — cross-pane message result

### Task Lifecycle
```
1. User presses 'n' in sidebar
2. overlayNewTask: select repo -> enter branch
3. overlayResultMsg -> Workspace.handleOverlayResult()
4. createTask callback: repo.CreateWorktree() + task.Save()
5. taskOpenMsg -> Workspace.openTask()
6. opener callback: task.Load() -> agent.WriteContext() -> agent.BuildCommand()
7. process.Start() with PTY -> VTerm -> paneRefreshMsg every 50ms
8. Panes cached in taskPanes for fast switching
```

### Callback Architecture (main.go:154-484)
- `TaskOpener` — open task and launch agents
- `TaskCreator` — create new task
- `RepoAdder` — add repo to task
- `TaskParker` — park task
- `TaskDeleter` — delete task
- `PaneLauncher` — launch arbitrary processes (lazygit)
- `PaneController` — stop/restart processes
- `loadTasks` / `loadRepos` — data loading

---

## 7. File Size Map

| File | Lines | Role | Status |
|------|-------|------|--------|
| `cmd/maomao/main.go` | **753** | CLI + callback wiring | OVER LIMIT |
| `internal/maomao/tui/workspace.go` | **1107** | Root TUI component | CRITICAL |
| `internal/process/manager.go` | **549** | Process lifecycle | OVER LIMIT |
| `internal/maomao/tui/sidebar.go` | 391 | Sidebar panel | OK |
| `internal/maomao/tui/overlay.go` | 333 | Modal overlays | OK |
| `internal/maomao/tui/termpane.go` | 261 | Terminal pane | OK |
| `internal/maomao/tui/wizard.go` | 202 | Setup wizard | OK |
| `internal/maomao/tui/message.go` | 163 | Cross-pane messaging | OK |
| `internal/maomao/tui/handoff.go` | 153 | Handoff UI | OK |
| `internal/maomao/tui/statusbar.go` | 133 | Status line | OK |
| `internal/maomao/agent/context.go` | 145 | Agent context gen | OK |
| `internal/maomao/event/store.go` | 140 | Event JSONL store | OK |
| `internal/maomao/event/event.go` | 121 | Event types | OK |
| `internal/maomao/config/config.go` | 102 | Global config | OK |
| `internal/maomao/repo/repo.go` | 83 | Git operations | OK |
| `internal/maomao/task/task.go` | 157 | Task persistence | OK |
| `internal/discovery/worktree.go` | 278 | Worktree discovery | OK |
| `internal/discovery/project.go` | 363 | Project discovery | OK |
| `internal/process/logbuf.go` | 165 | Ring buffer logs | OK |
| `internal/process/tunnel.go` | 151 | Cloudflare tunnels | OK |

---

## 8. Refactoring Recommendations

### High Priority
1. **Split workspace.go (1107 lines)** into:
   - `workspace_navigate.go` — updateNavigate, updateSidebarKeys, updatePaneKeys
   - `workspace_interactive.go` — updateInteractive
   - `workspace_overlay.go` — updateOverlay, handleOverlayResult
   - `workspace_handoff.go` — handleHandoffScan/Detected/Result, deliverHandoff
   - `workspace_view.go` — View() and confirmation overlays
   - `workspace_helpers.go` — utility methods

2. **Split main.go (753 lines)** — extract callbacks from `launchWorkspace()` (359 lines) into `cmd/maomao/callbacks.go`

3. **Deduplicate** `createTaskDirect()` vs `createTask` callback — shared branch parsing and Task creation logic should be in `task` or `repo` package

### Medium Priority
4. **Split process/manager.go (549 lines)** — extract `readPTY`, `tailFile`, `findPnpm`
5. **Centralize styles** — move repeated inline styles into `styles.go`
6. **Add GoDoc** on all public exports

### Low Priority
7. **Evaluate `bubbles` dependency** — may not be used in maomao TUI
8. **Add tests** for `cmd/maomao` and `internal/config`
9. **Consider interfaces** instead of callback types for `TaskOpener`, `TaskCreator`, etc.
