package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// exampleProjectConfigJSON mirrors the fixture from
// specs/001-devdash-orchestrator/data-model.md.
const exampleProjectConfigJSON = `{
  "name": "simplx",
  "domainSuffix": "simplx.localhost",
  "layout": "worktree",
  "repos": {
    "apps": "~/x/simplx/simplx-apps",
    "core": "~/x/simplx/simplx-core",
    "platform": "~/x/simplx/platform"
  },
  "services": {
    "front":    { "repo": "apps",     "package": "host",    "script": "dev", "mode": "local" },
    "mfe":      { "repo": "apps",     "package": "plugins", "script": "dev", "mode": "local" },
    "core":     { "repo": "core",     "package": "core-ui", "script": "dev", "mode": "remote", "remote": "https://core-test.sadmin.app" },
    "platform": { "repo": "platform", "package": "",        "script": "dev", "mode": "remote", "remote": "https://platform-test.sadmin.app" }
  },
  "env": {
    "VITE_SIMPLX_CORE_URL": "{core}",
    "VITE_API_URL":         "{platform}/api/v1",
    "VITE_MAINFRAME_URL":   "ws://{platform.host}/api/rivet"
  }
}`

func assertExampleProjectConfig(t *testing.T, cfg *ProjectConfig) {
	t.Helper()

	if cfg.Name != "simplx" {
		t.Errorf("Name = %q, want %q", cfg.Name, "simplx")
	}
	if cfg.DomainSuffix != "simplx.localhost" {
		t.Errorf("DomainSuffix = %q, want %q", cfg.DomainSuffix, "simplx.localhost")
	}
	if cfg.Layout != "worktree" {
		t.Errorf("Layout = %q, want %q", cfg.Layout, "worktree")
	}
	if got, want := cfg.Repos["apps"], "~/x/simplx/simplx-apps"; got != want {
		t.Errorf("Repos[apps] = %q, want %q", got, want)
	}

	front, ok := cfg.Services["front"]
	if !ok {
		t.Fatalf("Services[front] missing")
	}
	if front.Repo != "apps" || front.Package != "host" || front.Script != "dev" || front.Mode != "local" {
		t.Errorf("Services[front] = %+v, unexpected", front)
	}

	core, ok := cfg.Services["core"]
	if !ok {
		t.Fatalf("Services[core] missing")
	}
	if core.Mode != "remote" || core.Remote != "https://core-test.sadmin.app" {
		t.Errorf("Services[core] = %+v, unexpected", core)
	}

	if got, want := cfg.Env["VITE_SIMPLX_CORE_URL"], "{core}"; got != want {
		t.Errorf("Env[VITE_SIMPLX_CORE_URL] = %q, want %q", got, want)
	}
	if got, want := cfg.Env["VITE_MAINFRAME_URL"], "ws://{platform.host}/api/rivet"; got != want {
		t.Errorf("Env[VITE_MAINFRAME_URL] = %q, want %q", got, want)
	}
}

func TestResolveProjectConfig_RepoRootWinsOverCentral(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	repoRoot := filepath.Join(tmp, "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("setup repo root: %v", err)
	}

	// Write a distinct central config to prove repo-root wins over it.
	centralDir := ProjectsDir()
	if err := os.MkdirAll(centralDir, 0o755); err != nil {
		t.Fatalf("setup central dir: %v", err)
	}
	centralJSON := `{"name":"simplx","domainSuffix":"central.localhost","layout":"single"}`
	if err := os.WriteFile(filepath.Join(centralDir, "simplx.json"), []byte(centralJSON), 0o644); err != nil {
		t.Fatalf("write central config: %v", err)
	}

	// Write the repo-root dev.config.json with the example fixture.
	if err := os.WriteFile(filepath.Join(repoRoot, "dev.config.json"), []byte(exampleProjectConfigJSON), 0o644); err != nil {
		t.Fatalf("write repo-root dev.config.json: %v", err)
	}

	cfg, err := ResolveProjectConfig("simplx", []string{repoRoot})
	if err != nil {
		t.Fatalf("ResolveProjectConfig() error = %v", err)
	}
	if cfg == nil {
		t.Fatalf("ResolveProjectConfig() returned nil config")
	}

	assertExampleProjectConfig(t, cfg)
	if cfg.DomainSuffix == "central.localhost" {
		t.Errorf("expected repo-root config to win, got central config instead")
	}
}

func TestResolveProjectConfig_CentralUsedWhenNoRepoFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	repoRoot := filepath.Join(tmp, "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("setup repo root (no dev.config.json): %v", err)
	}

	centralDir := ProjectsDir()
	if err := os.MkdirAll(centralDir, 0o755); err != nil {
		t.Fatalf("setup central dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(centralDir, "simplx.json"), []byte(exampleProjectConfigJSON), 0o644); err != nil {
		t.Fatalf("write central config: %v", err)
	}

	cfg, err := ResolveProjectConfig("simplx", []string{repoRoot})
	if err != nil {
		t.Fatalf("ResolveProjectConfig() error = %v", err)
	}
	if cfg == nil {
		t.Fatalf("ResolveProjectConfig() returned nil config")
	}

	assertExampleProjectConfig(t, cfg)
}

func TestResolveProjectConfig_ErrNotOrchestratableWhenNeither(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	repoRoot := filepath.Join(tmp, "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatalf("setup repo root: %v", err)
	}

	cfg, err := ResolveProjectConfig("simplx", []string{repoRoot})
	if !errors.Is(err, ErrNotOrchestratable) {
		t.Fatalf("ResolveProjectConfig() error = %v, want ErrNotOrchestratable", err)
	}
	if cfg != nil {
		t.Errorf("ResolveProjectConfig() config = %+v, want nil", cfg)
	}
}

func TestLoadProjectConfigFile_ParsesExampleFixture(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "dev.config.json")
	if err := os.WriteFile(path, []byte(exampleProjectConfigJSON), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	cfg, err := LoadProjectConfigFile(path)
	if err != nil {
		t.Fatalf("LoadProjectConfigFile() error = %v", err)
	}
	assertExampleProjectConfig(t, cfg)

	// Sanity: round-trip preserves JSON tags.
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var roundTripped ProjectConfig
	if err := json.Unmarshal(data, &roundTripped); err != nil {
		t.Fatalf("Unmarshal() round trip error = %v", err)
	}
	assertExampleProjectConfig(t, &roundTripped)
}

func TestLoadProjectConfigFile_MissingFile(t *testing.T) {
	tmp := t.TempDir()
	_, err := LoadProjectConfigFile(filepath.Join(tmp, "missing.json"))
	if err == nil {
		t.Fatalf("expected error for missing file, got nil")
	}
}
