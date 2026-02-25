package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
)

// ContextParams holds the data needed to generate agent context files.
type ContextParams struct {
	RepoName    string
	TaskID      string
	TaskType    string
	TaskTitle   string
	TaskStatus  string
	Branch      string
	AllRepos    []task.TaskRepo
	WorktreeDir string
}

const agentMDTemplate = `# maomao Agent Context

## Your Role
You are working on **{{.RepoName}}** as part of task {{.TaskID}}.

## Task
- **ID:** {{.TaskID}}
- **Type:** {{.TaskType}}
- **Title:** {{.TaskTitle}}
- **Branch:** {{.Branch}}

## Repos in This Task
{{- range .AllRepos}}
- **{{.Name}}** ({{.Status}}){{if eq .Name $.RepoName}} ← you are here{{end}}
{{- end}}

## Cross-Repo Handoff Protocol
If you need changes in a sibling repo, create ` + "`.maomao/handoff.md`" + `:
` + "```" + `
Target: <repo-name>
Priority: high|medium|low

## What Changed
<list your changes>

## What Needs to Change
<what target repo should do>

## API Contract
<interfaces/types/endpoints that must match>
` + "```" + `

The orchestrator (maomao) will detect and deliver this to the target agent.

## Workspace Rules
- Stay within this worktree directory
- Do not access files outside your repo
- Commit to branch: {{.Branch}}
`

const claudeMDAugment = `
# maomao Workspace Context
Read ` + "`.maomao/AGENT.md`" + ` for your task context and cross-repo communication protocol.
If you need changes in a sibling repo, create ` + "`.maomao/handoff.md`" + ` per the format in AGENT.md.
`

const claudeMDMarker = "# maomao Workspace Context"

// WriteContext generates .maomao/AGENT.md and augments CLAUDE.md in the worktree.
func WriteContext(params ContextParams) error {
	if params.WorktreeDir == "" {
		return fmt.Errorf("WorktreeDir is required")
	}

	content, err := renderAgentMD(params)
	if err != nil {
		return fmt.Errorf("render AGENT.md: %w", err)
	}

	// Inject previous session summary if available
	summaryPath := filepath.Join(params.WorktreeDir, ".maomao", "session-summary.md")
	if summaryData, readErr := os.ReadFile(summaryPath); readErr == nil && len(summaryData) > 0 {
		content += "\n" + string(summaryData) + "\n"
	}

	maomaoDir := filepath.Join(params.WorktreeDir, ".maomao")
	if err := os.MkdirAll(maomaoDir, 0o755); err != nil {
		return fmt.Errorf("create .maomao dir: %w", err)
	}

	agentPath := filepath.Join(maomaoDir, "AGENT.md")
	if err := os.WriteFile(agentPath, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write AGENT.md: %w", err)
	}

	if err := augmentClaudeMD(params.WorktreeDir); err != nil {
		return fmt.Errorf("augment CLAUDE.md: %w", err)
	}

	// Create td session in worktree (best-effort, silent)
	createTdSession(params.WorktreeDir)

	return nil
}

// SessionSummaryParams holds the data needed to write a session summary.
type SessionSummaryParams struct {
	WorktreeDir     string
	LastOutputLines []string // last N lines of agent PTY output
	Timestamp       time.Time
}

// WriteSessionSummary captures the state of a worktree at agent stop/crash.
// Writes to .maomao/session-summary.md for injection into next session's AGENT.md.
func WriteSessionSummary(params SessionSummaryParams) error {
	if params.WorktreeDir == "" {
		return nil
	}
	if params.Timestamp.IsZero() {
		params.Timestamp = time.Now()
	}

	var sections []string
	sections = append(sections, fmt.Sprintf("## Previous Session (%s)",
		params.Timestamp.Format("2006-01-02 15:04")))

	// Git diff --stat (changed files)
	diffStat := runGitCmd(params.WorktreeDir, "diff", "--stat")
	if diffStat != "" {
		sections = append(sections, "\n### Changes Made\n```\n"+diffStat+"\n```")
	}

	// Git log --oneline -5 (recent commits)
	gitLog := runGitCmd(params.WorktreeDir, "log", "--oneline", "-5")
	if gitLog != "" {
		sections = append(sections, "\n### Recent Commits\n```\n"+gitLog+"\n```")
	}

	// Last agent output
	if len(params.LastOutputLines) > 0 {
		lines := params.LastOutputLines
		if len(lines) > 30 {
			lines = lines[len(lines)-30:]
		}
		output := strings.Join(lines, "\n")
		sections = append(sections, "\n### Last Agent Output (truncated)\n```\n"+output+"\n```")
	}

	content := strings.Join(sections, "\n")

	summaryPath := filepath.Join(params.WorktreeDir, ".maomao", "session-summary.md")
	dir := filepath.Dir(summaryPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create .maomao dir: %w", err)
	}
	return os.WriteFile(summaryPath, []byte(content), 0o644)
}

// runGitCmd runs a git command in the given directory and returns stdout.
// Returns empty string on error (best-effort).
func runGitCmd(workDir string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = workDir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func renderAgentMD(params ContextParams) (string, error) {
	tmpl, err := template.New("agent").Parse(agentMDTemplate)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, params); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// createTdSession starts a new td session in the worktree (best-effort).
func createTdSession(workDir string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "td", "usage", "--new-session")
	cmd.Dir = workDir
	cmd.Run() // best-effort, ignore errors
}

func augmentClaudeMD(worktreeDir string) error {
	claudePath := filepath.Join(worktreeDir, "CLAUDE.md")

	existing, err := os.ReadFile(claudePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	// Idempotent: don't add if already present
	if strings.Contains(string(existing), claudeMDMarker) {
		return nil
	}

	content := string(existing) + claudeMDAugment
	return os.WriteFile(claudePath, []byte(content), 0o644)
}

