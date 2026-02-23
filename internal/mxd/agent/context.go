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

	"github.com/kimaguri/simplx-toolkit/internal/mxd/task"
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

const agentMDTemplate = `# mxd Agent Context

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
If you need changes in a sibling repo, create ` + "`.mxd/handoff.md`" + `:
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

The orchestrator (mxd) will detect and deliver this to the target agent.

## Task Management (td)
Run ` + "`td usage -q`" + ` to see current tasks and session context.
Use ` + "`td`" + ` for issue tracking — create, update, and close issues as you work.
Run ` + "`td handoff <issue-id>`" + ` before stopping to preserve context for the next session.

## Workspace Rules
- Stay within this worktree directory
- Do not access files outside your repo
- Commit to branch: {{.Branch}}
`

const claudeMDAugment = `
# mxd Workspace Context
Read ` + "`.mxd/AGENT.md`" + ` for your task context and cross-repo communication protocol.
If you need changes in a sibling repo, create ` + "`.mxd/handoff.md`" + ` per the format in AGENT.md.
`

const claudeMDMarker = "# mxd Workspace Context"

// WriteContext generates .mxd/AGENT.md and augments CLAUDE.md in the worktree.
func WriteContext(params ContextParams) error {
	if params.WorktreeDir == "" {
		return fmt.Errorf("WorktreeDir is required")
	}

	content, err := renderAgentMD(params)
	if err != nil {
		return fmt.Errorf("render AGENT.md: %w", err)
	}

	mxdDir := filepath.Join(params.WorktreeDir, ".mxd")
	if err := os.MkdirAll(mxdDir, 0o755); err != nil {
		return fmt.Errorf("create .mxd dir: %w", err)
	}

	agentPath := filepath.Join(mxdDir, "AGENT.md")
	if err := os.WriteFile(agentPath, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write AGENT.md: %w", err)
	}

	if err := augmentClaudeMD(params.WorktreeDir); err != nil {
		return fmt.Errorf("augment CLAUDE.md: %w", err)
	}

	// Create td session in worktree (best-effort)
	createTdSession(params.WorktreeDir)

	return nil
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

// createTdSession starts a new td session in the worktree (best-effort).
func createTdSession(workDir string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "td", "usage", "--new-session")
	cmd.Dir = workDir
	cmd.Run() // best-effort, ignore errors
}
