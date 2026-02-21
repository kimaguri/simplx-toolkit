package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadProjectConfig(t *testing.T) {
	dir := t.TempDir()
	mxdDir := filepath.Join(dir, ".mxd")
	os.MkdirAll(mxdDir, 0o755)

	tomlContent := `
[project]
name = "simplx"

[[project.repos]]
name = "platform"
path = "platform"
role = "backend"

[[project.repos]]
name = "simplx-core"
path = "simplx-core"
role = "frontend-core"

[branch]
template = "{type}/{taskId}/{slug}"
base = "main"
worktree_dir = ".worktrees"
`
	os.WriteFile(filepath.Join(mxdDir, "project.toml"), []byte(tomlContent), 0o644)

	cfg, err := LoadProjectConfig(dir)
	if err != nil {
		t.Fatalf("LoadProjectConfig: %v", err)
	}

	if cfg.Project.Name != "simplx" {
		t.Errorf("project name = %q, want %q", cfg.Project.Name, "simplx")
	}
	if len(cfg.Project.Repos) != 2 {
		t.Fatalf("repos count = %d, want 2", len(cfg.Project.Repos))
	}
	if cfg.Project.Repos[0].Name != "platform" {
		t.Errorf("repo[0].name = %q, want %q", cfg.Project.Repos[0].Name, "platform")
	}
	if cfg.Branch.Template != "{type}/{taskId}/{slug}" {
		t.Errorf("branch template = %q, want %q", cfg.Branch.Template, "{type}/{taskId}/{slug}")
	}
	if cfg.Branch.Base != "main" {
		t.Errorf("branch base = %q, want %q", cfg.Branch.Base, "main")
	}
}

func TestLoadProjectConfigMissing(t *testing.T) {
	dir := t.TempDir()
	_, err := LoadProjectConfig(dir)
	if err == nil {
		t.Fatal("expected error for missing config, got nil")
	}
}

func TestLoadGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `
default_agent = "claude"
mode = "supervised"

[agents.claude]
name = "Claude Code"
command = "claude"
args = ["--dangerously-skip-permissions"]
detect = "which claude"
interactive = true

[agents.codex]
name = "Codex CLI"
command = "codex"
args = []
detect = "which codex"
`
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(tomlContent), 0o644)

	cfg, err := LoadGlobalConfig(dir)
	if err != nil {
		t.Fatalf("LoadGlobalConfig: %v", err)
	}

	if cfg.DefaultAgent != "claude" {
		t.Errorf("default_agent = %q, want %q", cfg.DefaultAgent, "claude")
	}
	if cfg.Mode != "supervised" {
		t.Errorf("mode = %q, want %q", cfg.Mode, "supervised")
	}
	if len(cfg.Agents) != 2 {
		t.Fatalf("agents count = %d, want 2", len(cfg.Agents))
	}
	claude, ok := cfg.Agents["claude"]
	if !ok {
		t.Fatal("missing agent 'claude'")
	}
	if claude.Command != "claude" {
		t.Errorf("claude command = %q, want %q", claude.Command, "claude")
	}
	if len(claude.Args) != 1 || claude.Args[0] != "--dangerously-skip-permissions" {
		t.Errorf("claude args = %v, want [--dangerously-skip-permissions]", claude.Args)
	}
	if !claude.Interactive {
		t.Errorf("claude interactive = %v, want true", claude.Interactive)
	}
}
