package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `
default_agent = "claude"
mode = "supervised"
scan_dirs = ["~/x/simplx", "~/x/other"]

[branch]
template = "{type}/{taskId}/{slug}"
base = "main"
worktree_dir = ".worktrees"

[agents.claude]
name = "Claude Code"
command = "claude"
args = ["--dangerously-skip-permissions"]
detect = "which claude"
interactive = true
resume_flag = "--resume"

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
	if len(cfg.ScanDirs) != 2 {
		t.Fatalf("scan_dirs count = %d, want 2", len(cfg.ScanDirs))
	}
	if cfg.ScanDirs[0] != "~/x/simplx" {
		t.Errorf("scan_dirs[0] = %q, want %q", cfg.ScanDirs[0], "~/x/simplx")
	}
	if cfg.Branch.Template != "{type}/{taskId}/{slug}" {
		t.Errorf("branch template = %q", cfg.Branch.Template)
	}
	if cfg.Branch.Base != "main" {
		t.Errorf("branch base = %q", cfg.Branch.Base)
	}
	claude, ok := cfg.Agents["claude"]
	if !ok {
		t.Fatal("missing agent 'claude'")
	}
	if claude.ResumeFlag != "--resume" {
		t.Errorf("claude resume_flag = %q, want %q", claude.ResumeFlag, "--resume")
	}
}

func TestLoadGlobalConfigDefaults(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(""), 0o644)

	cfg, err := LoadGlobalConfig(dir)
	if err != nil {
		t.Fatalf("LoadGlobalConfig: %v", err)
	}
	if cfg.DefaultAgent != "claude" {
		t.Errorf("default_agent = %q, want %q", cfg.DefaultAgent, "claude")
	}
	if cfg.Branch.Base != "main" {
		t.Errorf("branch base = %q, want %q", cfg.Branch.Base, "main")
	}
	if cfg.Branch.Template != "{type}/{taskId}/{slug}" {
		t.Errorf("branch template = %q", cfg.Branch.Template)
	}
}

func TestSaveGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	cfg := &GlobalConfig{
		DefaultAgent: "claude",
		ScanDirs:     []string{"/tmp/repos"},
	}
	if err := SaveGlobalConfig(dir, cfg); err != nil {
		t.Fatalf("SaveGlobalConfig: %v", err)
	}
	loaded, err := LoadGlobalConfig(dir)
	if err != nil {
		t.Fatalf("LoadGlobalConfig after save: %v", err)
	}
	if len(loaded.ScanDirs) != 1 || loaded.ScanDirs[0] != "/tmp/repos" {
		t.Errorf("scan_dirs = %v, want [/tmp/repos]", loaded.ScanDirs)
	}
}
