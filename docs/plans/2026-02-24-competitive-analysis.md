# Competitive Analysis: maomao vs Handler, Pilot, Ralph AI

**Date:** 2026-02-24
**Branch:** feat/toolkit/enhancements
**Purpose:** Research competitor TUI projects for maomao enhancement ideas

---

## 1. Handler — A2A Protocol Client TUI

**URL:** https://terminaltrove.com/handler/ | https://github.com/alDuncanson/Handler
**Stack:** Python 99.1%, PyPI, GPL-3.0
**Status:** Beta, 36 stars, 73 commits, 15 releases

### Core Purpose
Command-line and TUI client for the A2A Protocol (Agent-to-Agent communication). Enables developers to interact with AI agents through both CLI and interactive terminal interfaces.

### Key Features
| Feature | Description |
|---------|-------------|
| Real-time messaging | Send and receive A2A messages with streamed responses |
| Agent validation | Validate agent cards from URLs or local files |
| Task inspection | Review and inspect tasks from agents |
| Artifact viewing | Access and view artifacts from agents |
| Session management | Manage sessions and handle authentication |
| MCP server integration | Bridges AI assistants into A2A protocols using stdout and SSE transport |
| Webhook support | Supports push and receive webhooks for agent events |
| Local inference | Compatible with Ollama for local model testing |
| JSON output | Support for JSON output format for scripting and automation |

### UI/UX Patterns
- **Dual mode:** CLI mode (scripting/automation) + TUI mode (interactive exploration)
- **Commands:** `validate`, `send` with context continuity (`context-id`, `task-id`)
- **Logging:** Verbose and debug flags
- **Installation:** `uv tool install`, `pipx install`, pip

### Technology Details
- Protocol: A2A Protocol v0.3.0
- Package: `a2a-handler` on PyPI
- Build: `pyproject.toml` + `uv.lock`
- Dev env: Nix flake for hermetically sealed setup
- Task automation: `justfile`
- CI/CD: GitHub Actions with `.actrc`
- Local inference: Ollama (default `http://localhost:11434`, model `qwen3`)
- Reference server: Google ADK + LiteLLM

### What We Can Take
- **Agent validation/health checks** — verify agent availability before launching
- **JSON output mode** — machine-readable output for automation pipelines
- **A2A protocol awareness** — potential future agent-to-agent communication standard

---

## 2. Pilot by Quantflow — Autonomous Development Pipeline

**URL:** https://pilot.quantflow.studio/ | https://github.com/alekspetrov/pilot
**Stack:** Go 1.22+, single binary, BSL 1.1 license
**Status:** Production-ready, actively maintained

### Core Purpose
Autonomous development pipeline: "Label a ticket, get a PR or a release." Monitors ticket systems, plans implementation, generates code via Claude Code, runs quality gates, opens PRs.

### Key Features

#### Execution & Automation
- **Autopilot modes:** Dev (fast, skip-CI), Stage (CI required), Prod (human approval)
- **Epic decomposition:** Splits complex tickets into sequential subtasks via Haiku API
- **Self-review:** AI identifies issues before PR submission
- **Sequential execution:** Prevents merge conflicts by waiting for PR completion
- **Quality gates:** Automated test, lint, build validation with auto-retry

#### Intelligence & Optimization
- **Model routing:** Haiku for trivial tasks, Opus for complex, Sonnet for guided
- **Effort routing:** Maps task complexity to Claude thinking depth
- **Research subagents:** Parallel Haiku-powered codebase exploration
- **Cross-project memory:** SQLite + knowledge graph, shares patterns across repos
- **Session resume:** 40% token savings through resumable sessions
- **Context engine:** 92% token reduction through strategic documentation loading

#### Integration Ecosystem
- **Ticket systems:** GitHub, GitLab, Linear, Jira, Asana, Azure DevOps (webhooks)
- **Communication:** Slack, email, webhook, PagerDuty notifications
- **Telegram bot:** Chat, research, planning, task modes with mobile execution
- **Scheduled briefs:** Daily reports via Slack/Email/Telegram
- **Cost alerting:** Real-time budget enforcement with hard spending limits

### TUI Dashboard
- Real-time metrics: current task progress, token usage, daily cost
- Recent completions history
- Queue depth with sparkline charts
- Status line: context usage (0-100%), active plan, license, memory status
- **Keyboard:** `CTRL+K` search, `u` hot upgrade
- **Console:** Web UI at localhost:41777 for model/context settings

### Architecture
```
HTTP/WebSocket Gateway
    -> Adapters (Telegram, GitHub, Jira, Linear, Asana, Azure DevOps)
    -> Orchestrator (task planning, phase management)
    -> Executor (Claude Code process management)
    -> Memory Layer (SQLite + knowledge graph)
```

### Configuration
```bash
pilot init                    # Configure (~/.pilot/config.yaml)
pilot start --github          # Begin polling labeled issues
pilot task "description"      # Execute standalone task
pilot upgrade                 # Self-update
pilot metrics summary         # Usage analytics
pilot brief --now             # Trigger reports
```

### What We Can Take
- **Metrics dashboard** — token usage, cost tracking, sparklines in TUI (HIGH)
- **Model routing** — Haiku for trivial, Opus for complex tasks (MEDIUM)
- **Cross-project memory** — SQLite knowledge graph for patterns (HIGH)
- **Autopilot pipeline** — ticket -> plan -> code -> PR -> merge (HIGH)
- **Hot upgrade** — in-place binary replacement (MEDIUM)
- **Epic decomposition** — break complex tasks into subtasks (HIGH)
- **Session resume** — 40% token savings (HIGH)

---

## 3. Ralph AI TUI — AI Agent Loop Orchestrator

**URL:** https://github.com/syntax-syndicate/ralph-ai-tui (fork of subsy/ralph-tui)
**Stack:** TypeScript 5.9.3, Bun runtime, React 19 + OpenTUI, MIT license
**Status:** Active, 1,291+ commits upstream, 1.9k stars, 188 forks

### Core Purpose
AI Agent Loop Orchestrator — enables autonomous AI coding agents to systematically work through project task lists without human intervention. Automates: task selection -> prompt generation -> agent execution -> completion detection -> iteration.

### Key Features

#### Task Orchestration
- **Multiple task trackers:** prd.json (simple), Beads (git-backed with dependencies), Beads-BV
- **Intelligent task selection:** Priority-based, dependency-aware ordering
- **5-step execution cycle:** task selection -> prompt building -> agent execution -> completion detection -> next iteration
- **Cross-iteration context:** Automatic progress injection into subsequent prompts

#### AI Agent Integration
- **6+ agents:** Claude Code, OpenCode, Factory Droid, Gemini CLI, Codex, Kiro CLI
- **Configurable models:** Claude 3.5 Sonnet variants and others
- **Subagent tracing:** Hierarchical visualization of nested agent calls via JSONL
- **Slash command skills:** `/ralph-tui-prd`, `/ralph-tui-create-json`, `/ralph-tui-create-beads`

#### Execution & Recovery
- **Session persistence:** Pause/resume with state in `.ralph-tui/session-meta.json`
- **Crash recovery:** Stale lock detection, automatic session resumption
- **Rate limit handling:** Exponential backoff with configurable fallback agents
- **Error strategies:** retry, skip (mark as skipped), or abort
- **Sandboxing:** bwrap (Linux) or sandbox-exec (macOS)

#### Interactive TUI
- **Dual-panel layout:** Left (task list/details), Right (agent output/iteration history)
- **22 React components** including: App, RunApp, ProgressDashboard, LeftPanel, RightPanel, IterationHistoryView, TaskDetailView, SubagentTreePanel, ChatView, SettingsView
- **Dark theme:** Primary #1a1b26, status colors (green/yellow/red/blue)
- **Unicode indicators:** checkmark (complete), triangle (active), circle (open), x (blocked)

### Keyboard Controls
| Key | Action |
|-----|--------|
| `s` | Start execution |
| `p` | Pause/resume |
| `d` | Toggle dashboard |
| `i` | Toggle iteration history |
| `u` | Toggle subagent tracing |
| `q` | Quit |
| `?` | Help menu |

### Plugin Architecture

#### Agent Plugin Interface
- **Lifecycle:** initialize(), isReady(), dispose()
- **Execution:** isAvailable(), execute(prompt, context), interrupt()
- **Configuration:** getSetupQuestions(), validateSetup(), validateModelName()
- **Metadata:** streaming support, interruption capabilities, file context, subagent tracing

#### Tracker Plugin Interface
- **Tasks:** getTasks(), getNextTask(), completeTask(), updateTaskStatus(), sync()
- **Status:** isTaskReady(), isComplete(), getEpics()
- **Task Model:** id, title, status (open|in_progress|blocked|completed|cancelled), priority (0-4), description, labels, assignee, dependencies

### Prompt Template Engine
- **Handlebars templates** with three-tier loading (custom path -> user config -> built-in)
- **Tracker-specific templates** auto-selected by tracker type
- **Context variables:** task metadata, epic info, acceptance criteria, recent progress
- **Completion detection:** JSONL output parsing for result events

### Session Persistence
- **State file:** `.ralph-tui/session-meta.json` (id, status, agent/tracker plugins, iteration count, tasks completed)
- **Lock file:** `.ralph-tui/ralph.lock` (PID-based crash detection)
- **Resume:** metadata recovery -> stale lock cleanup -> lock reacquisition

### Configuration (Zod validated)
- **Global:** `~/.config/ralph-tui/config.toml`
- **Project:** `.ralph-tui/config.toml` (overrides global)
- **Agent setup:** agents[], defaultAgent, fallbackAgents[], rateLimitHandling
- **Tracker setup:** trackers[], defaultTracker
- **Execution:** maxIterations, iterationDelay, outputDir, progressFile
- **Advanced:** prompt_template, skills_dir, autoCommit, subagentTracingDetail, sandbox

### What We Can Take
- **Execution engine / agent loop** — 5-step autonomous cycle (CRITICAL)
- **Task dependency graph** — Beads format with priorities (HIGH)
- **Session pause/resume** — crash recovery with lock files (HIGH)
- **Subagent tracing** — hierarchical visualization of nested calls (HIGH)
- **Plugin architecture** — formal AgentPlugin/TrackerPlugin interfaces (HIGH)
- **Rate limit handling** — exponential backoff + fallback agents (MEDIUM)
- **Prompt templates** — Handlebars with task context injection (MEDIUM)
- **Iteration history** — navigate previous attempts (MEDIUM)
- **Progress dashboard** — real-time task completion tracking (MEDIUM)

---

## 4. Synthesis: Enhancement Priorities for maomao

### What maomao already does better than all three

| Strength | Details |
|----------|---------|
| **Multi-repo orchestration** | None of the competitors manage multiple repos with worktrees simultaneously |
| **Cross-repo handoff** | `.maomao/handoff.md` protocol for inter-agent communication is unique |
| **Real PTY panes** | Full terminal emulation with VTerm, not just output streaming |
| **Go single binary** | Fast startup, zero dependencies (vs Python/TypeScript/Bun) |
| **Visual multi-pane layout** | Side-by-side terminal panes for simultaneous repo work |

### Enhancement Clusters (by priority)

#### Cluster A: Execution Engine (HIGH)
Source: Ralph + Pilot
- Autonomous task loop: select -> prompt -> execute -> detect completion -> iterate
- Completion detection via agent output parsing (JSONL, exit codes)
- Configurable autonomy levels (manual/semi-auto/full-auto)
- Cross-iteration context injection

#### Cluster B: Observability (HIGH)
Source: Pilot + Ralph
- Token usage tracking per task/agent
- Cost dashboard with sparklines
- Subagent tracing tree visualization
- Iteration history with navigation
- Event timeline in sidebar (partially exists)

#### Cluster C: Task Graph (HIGH)
Source: Ralph
- Task dependencies (blocked-by/blocks relationships)
- Priority levels (0-4)
- Automatic ordering respecting dependency graph
- Status progression: open -> in_progress -> blocked -> completed

#### Cluster D: Session Persistence (HIGH)
Source: Ralph
- Lock files for crash detection
- Session state serialization (current task, iteration, agent state)
- Pause/resume without losing context
- Stale lock cleanup on restart

#### Cluster E: Plugin System (MEDIUM)
Source: Ralph
- Formal AgentPlugin interface with lifecycle methods
- TrackerPlugin interface for task source integration
- Plugin registry and discovery
- Setup wizard per plugin

#### Cluster F: Refactoring (PREREQUISITE)
Source: Internal analysis
- Split workspace.go (1107 -> 6 files)
- Split main.go (753 -> 2 files)
- Split process/manager.go (549 -> 3 files)
- Centralize styles
- Deduplicate task creation logic
