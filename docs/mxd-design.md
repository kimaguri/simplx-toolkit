# mxd — Multi-Repo Agent Orchestrator

## Overview

TUI-утилита для оркестрации AI-агентов across multiple git repositories. Управляет tmux-сессиями, git worktrees, branch naming и контекстом между агентами.

**Stack:** Go + Bubbletea (TUI) + gotmux (tmux) + TOML (config)
**Repo:** `simplx-toolkit` (отдельный бинарник рядом с devdash)

---

## 1. Architecture

```
┌─────────────────────────────────────────────┐
│  TUI Layer (Bubbletea + Lipgloss)           │
│  Lead panel + Agent panes + Status bar      │
├─────────────────────────────────────────────┤
│  Core Layer                                 │
│  Orchestrator │ AgentManager │ RepoManager  │
│  ContextBus   │ BranchEngine │ PluginLoader │
├─────────────────────────────────────────────┤
│  Infrastructure Layer                       │
│  tmux (gotmux) │ git │ Unix sockets │ FS   │
└─────────────────────────────────────────────┘
```

Запуск: `mxd` стартует tmux-сессию. Левый pane — lead TUI (Bubbletea). Правые panes — по одному на каждый подключённый репо с запущенным агентом.

Два режима:
- **Supervised** — lead согласовывает каждое действие с пользователем через TUI
- **Autonomous** — lead самостоятельно делегирует, показывая прогресс

---

## 2. Project Structure

```
simplx-toolkit/
├── cmd/
│   ├── local/main.go          # devdash (as-is)
│   └── mxd/main.go            # mxd entry point
│
├── internal/
│   ├── shared/                 # Общие примитивы
│   │   ├── logbuf.go           # Ring buffer + pub/sub
│   │   ├── pty.go              # PTY spawning
│   │   ├── vterm.go            # VT100 emulator
│   │   ├── sanitize.go         # ANSI sanitizer
│   │   ├── clipboard.go        # OSC52 + native
│   │   └── styles.go           # Lipgloss palette
│   │
│   ├── process/                # devdash process layer (as-is)
│   ├── config/                 # devdash config (as-is)
│   ├── discovery/              # devdash discovery (as-is)
│   ├── tui/                    # devdash TUI (as-is)
│   │
│   └── mxd/                    # mxd — всё новое
│       ├── agent/              # Agent lifecycle, plugin system
│       ├── repo/               # Multi-repo coordination, branches
│       ├── task/               # Task engine, workflow
│       ├── bus/                # Event log, context generation
│       ├── context/            # Prompt assembly, cross-agent context
│       ├── git/                # Push, PR (via gh), status tracking
│       ├── config/             # mxd config (TOML)
│       ├── tmux/               # tmux session/pane management
│       └── tui/                # mxd TUI (Bubbletea)
```

devdash и mxd полностью независимые. Общие только низкоуровневые утилиты в `shared/`.

---

## 3. Agent Plugin System

Каждый AI-агент — плагин, описанный в конфиге:

```toml
# ~/.config/mxd/config.toml

[agents.claude]
name = "Claude Code"
command = "claude"
args = ["--dangerously-skip-permissions"]
interactive = true
detect = "which claude"

[agents.codex]
name = "Codex CLI"
command = "codex"
args = []
interactive = true
detect = "which codex"

[agents.opencode]
name = "OpenCode"
command = "opencode"
args = []
interactive = true
detect = "which opencode"
```

При старте mxd проверяет `detect` для каждого агента. Доступные агенты показываются при создании задачи. Новый агент = новая секция в TOML, без изменения кода.

---

## 4. Multi-Repo & Dynamic Expansion

### Project Config

```toml
# ~/x/simplx/.mxd/project.toml

[project]
name = "simplx"
root = "~/x/simplx"

[[project.repos]]
name = "platform"
path = "platform"
role = "backend"

[[project.repos]]
name = "simplx-core"
path = "simplx-core"
role = "frontend-core"

[[project.repos]]
name = "simplx-apps"
path = "simplx-apps"
role = "frontend-apps"

[branch]
template = "{type}/{taskId}/{slug}"
base = "main"
worktree_dir = ".worktrees"
```

### Dynamic Repo Addition

Задача НЕ обязана стартовать во всех репо. Типичный flow:

```
1. mxd task "fix helpd-58: фильтрация"
   → Выбираем: в каком репо начинаем? → platform
   → Worktree + pane + агент ТОЛЬКО в platform

2. Агент работает, понимает: "нужны изменения на фронте"
   → mxd показывает пользователю запрос
   → Пользователь выбирает: simplx-core / simplx-apps / оба

3. mxd создаёт worktree с ТЕМ ЖЕ префиксом
   → Запускает агента с контекстом того, что уже сделано
```

Три способа подключить репо:
1. **Агент просит** — через файл-сигнал `.mxd/request-repo.json`
2. **Пользователь** — hotkey `a` в TUI
3. **Lead предлагает** — анализ cross-repo contracts

Branch naming всегда консистентен по шаблону:
```
platform:     fix/helpd-58/add-validation
simplx-core:  fix/helpd-58/update-types
simplx-apps:  fix/helpd-58/fix-imports
```

Если шаблон не задан — fallback: `{type}/{taskId}/{slug}`.

---

## 5. Context & Communication

### Принципы

- CLAUDE.md НЕ модифицируется — содержит стабильные инструкции
- Контекст задачи — отдельные файлы
- Агенты не общаются напрямую, всё через mxd lead

### Task Context Storage

```
~/.config/mxd/tasks/helpd-58/
├── task.toml              # описание, статус, подключённые репо
├── log.jsonl              # хронология событий (append-only)
├── context-platform.md    # что сделано/нужно в platform
├── context-simplx-core.md # что сделано/нужно в simplx-core
└── context-simplx-apps.md # появится когда подключится
```

### Как агент получает контекст

При запуске mxd собирает промпт и передаёт через CLI:

```bash
claude -p "$(cat task-prompt.md)" --session-id mxd-helpd-58-platform
```

Промпт содержит:
- Описание задачи
- Роль агента (какой репо, что делать)
- Что уже сделано в других репо (summary)

### Обновление контекста

mxd отслеживает git diff в worktrees и при значимых изменениях может отправить обновление агенту через tmux send-keys.

---

## 6. tmux Management & TUI

### Layout

```
┌─────────────────────────────────────────────────────┐
│ mxd: helpd-58                                       │
├──────────────────┬──────────────────────────────────┤
│                  │                                  │
│   mxd lead       │   platform-agent (claude)        │
│   (TUI)          │   fix/helpd-58/add-validation    │
│                  │                                  │
│  ┌────────────┐  ├──────────────────────────────────┤
│  │ Task log   │  │                                  │
│  │ > platform │  │   simplx-core-agent (claude)     │
│  │   started  │  │   fix/helpd-58/update-types      │
│  │ > types    │  │                                  │
│  │   changed  │  │                                  │
│  └────────────┘  │                                  │
│                  │                                  │
├──────────────────┴──────────────────────────────────┤
│ [T]est PR  [M]ain PR  [A]dd repo  [S]tatus  [Q]uit │
└─────────────────────────────────────────────────────┘
```

### Hotkeys

| Key | Action |
|-----|--------|
| `a` | Add repo to task |
| `f` / `1-9` | Focus pane агента |
| `s` | Status всех агентов |
| `m` | Отправить сообщение агенту |
| `k` | Kill агента |
| `r` | Restart агента с обновлённым контекстом |
| `p` | Supervised ↔ autonomous |
| `t` | Push + PR в test (все репо) |
| `M` | Push + PR в main (все репо) |
| `w` | Cleanup worktrees (после merge в main) |
| `q` | Завершить (чистый выход, kill panes) |

### Worktree Lifecycle

```
ACTIVE  — агент работает, код пишется
PARKED  — PR в test создан, worktree сохраняется
REVIEW  — PR в main создан, ждём merge
DONE    — merge в main, cleanup worktrees
```

Worktree удаляется ТОЛЬКО после merge в main.

---

## 7. Configuration

### Три уровня (task > project > global)

**Global** — `~/.config/mxd/config.toml`
```toml
default_agent = "claude"
mode = "supervised"

[agents.claude]
name = "Claude Code"
command = "claude"
args = ["--dangerously-skip-permissions"]
detect = "which claude"
```

**Project** — `<project-root>/.mxd/project.toml`
```toml
[project]
name = "simplx"

[[project.repos]]
name = "platform"
path = "platform"
role = "backend"

[branch]
template = "{type}/{taskId}/{slug}"
base = "main"
worktree_dir = ".worktrees"
```

**Task** — `~/.config/mxd/tasks/<id>/task.toml`
```toml
[task]
id = "helpd-58"
type = "fix"
title = "фильтрация не работает"
status = "active"
created = 2026-02-21T14:00:00Z

[[task.repos]]
name = "platform"
branch = "fix/helpd-58/add-validation"
agent = "claude"
status = "in_progress"
pr_test = 42
pr_main = 0
```

---

## 8. CLI Commands

```bash
# TUI
mxd                              # Запуск TUI / reconnect
mxd task "fix helpd-58: описание"  # Создать задачу + TUI
mxd task list                    # Список задач
mxd task resume helpd-58         # Вернуться к задаче

# Repos
mxd repo add simplx-core         # Подключить репо
mxd repo status                  # Git status всех репо

# Git workflow
mxd pr test                      # Push + PR в test
mxd pr main                      # Push + PR в main
mxd cleanup                      # Удалить worktrees

# Config
mxd init                         # Создать .mxd/project.toml
mxd agents                       # Доступные агенты
mxd config                       # Глобальный конфиг

# Info
mxd status                       # Текущая задача, PRs
mxd log                          # Хронология событий
```

---

## 9. Implementation Phases

### Phase 1 — Skeleton (MVP)

```
cmd/mxd/main.go
internal/mxd/config/      — TOML parsing (global + project)
internal/mxd/tmux/         — session create, split panes, kill
internal/mxd/repo/         — git worktree add/remove, branch naming
internal/mxd/tui/          — minimal TUI: repo list + task log
```

Result: `mxd task "fix helpd-58"` → worktree + tmux pane + claude + clean quit

### Phase 2 — Multi-Repo & Agents

```
internal/mxd/agent/        — plugin system, spawn, detect
internal/mxd/task/         — task.toml persistence, lifecycle
```

Result: multiple repos, hotkey `a`, different agents, task list/resume

### Phase 3 — Git Workflow

```
internal/mxd/git/          — push, PR (via gh), status tracking
```

Result: `t` PR test, `M` PR main, `w` cleanup, PR status display

### Phase 4 — Context & Communication

```
internal/mxd/bus/          — event log, context generation
internal/mxd/context/      — prompt assembly, cross-agent context
```

Result: context at spawn, git diff tracking, supervised/autonomous, repo requests

---

## 10. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `charmbracelet/bubbletea` | v1.3.10 | TUI framework (already in project) |
| `charmbracelet/lipgloss` | v1.1.0 | TUI styling (already in project) |
| `charmbracelet/bubbles` | v1.0.0 | TUI components (already in project) |
| `GianlucaP106/gotmux` | v0.5.0 | tmux session/pane control |
| `pelletier/go-toml/v2` | v2.2.4 | TOML config parsing + marshal |
| `spf13/cobra` | v1.10.2 | CLI subcommands |
| `rs/zerolog` | v1.34.0 | JSON logging to file (not stdout) |
| `google/renameio/v2` | v2.0.2 | Atomic config/state file writes |

**External CLI tools (runtime):** `tmux`, `git`, `gh` (GitHub CLI), `claude`/`codex`/`opencode`

**Go minimum version:** 1.23 (driven by zerolog)

---

## 10.1 Agent State Detection

### Claude Code: Hooks (preferred)

mxd запускает локальный HTTP-сервер. Claude hooks шлют события:

```json
// ~/.claude/settings.json (injected by mxd at setup)
{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://localhost:7777/agent-event -d @-"}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://localhost:7777/agent-event -d @-"}]}]
  }
}
```

Events: `Stop` (агент закончил), `Notification` (idle, permission needed)

### Claude Code: Launch Patterns

```bash
# Interactive в tmux pane (человек видит агента)
tmux send-keys -t pane 'claude "initial task description"' Enter

# Headless subprocess (для автоматизации)
claude -p "task" --output-format stream-json --resume <session-id>
```

Важно: первый промпт передавать при запуске (`claude "prompt"`), НЕ через send-keys после старта.

### Codex CLI
```bash
codex exec --json "task"   # NDJSON на stdout
```

### OpenCode
```bash
opencode serve --port 4096  # HTTP API — самый чистый вариант
# Go делает POST /session/{id}/message
```

---

## 11. Key Design Decisions

1. **Separate from devdash** — mxd is agent orchestration, devdash is process management
2. **tmux-based** — agents need real terminals, not in-process PTY
3. **TOML config** — human-readable, supports comments
4. **No CLAUDE.md modification** — stable instructions stay stable, task context is separate
5. **Dynamic repo expansion** — start with one repo, add more as needed
6. **Explicit git workflow** — hotkeys for PR test/main/cleanup, no guessing
7. **Plugin agents** — new agent = new TOML section, zero code changes
8. **Worktree lifecycle** — delete only after merge to main

---

## 12. Autonomous Loop Pattern (from Ralph Wiggum)

For long-running tasks, mxd can use the Stop hook loop pattern:

```bash
# Agent finishes → Stop hook fires → mxd checks:
#   - Task done? → mark complete, notify user
#   - More work? → restart agent with updated context
```

This enables "set and forget" mode: start a task, mxd keeps agents
working across iterations until acceptance criteria are met.

Config per task:
```toml
[task.loop]
enabled = false        # opt-in per task
max_iterations = 10    # safety limit
```
