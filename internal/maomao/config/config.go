package config

import (
	"fmt"
	"os"
	"path/filepath"

	toml "github.com/pelletier/go-toml/v2"
)

// BranchSection configures branch naming and worktree location.
type BranchSection struct {
	Template    string `toml:"template"`
	Base        string `toml:"base"`
	WorktreeDir string `toml:"worktree_dir"`
}

// GlobalConfig represents ~/.config/maomao/config.toml
type GlobalConfig struct {
	DefaultAgent string               `toml:"default_agent"`
	Mode         string               `toml:"mode"`
	ScanDirs     []string             `toml:"scan_dirs"`
	Branch       BranchSection        `toml:"branch"`
	Agents       map[string]AgentConf `toml:"agents"`
}

type AgentConf struct {
	Name        string   `toml:"name"`
	Command     string   `toml:"command"`
	Args        []string `toml:"args"`
	Detect      string   `toml:"detect"`
	Interactive bool     `toml:"interactive"`
	ResumeFlag  string   `toml:"resume_flag"`
}

// LoadGlobalConfig reads config.toml from the given config directory.
func LoadGlobalConfig(configDir string) (*GlobalConfig, error) {
	path := filepath.Join(configDir, "config.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read global config: %w", err)
	}
	var cfg GlobalConfig
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse global config: %w", err)
	}
	if cfg.DefaultAgent == "" {
		cfg.DefaultAgent = "claude"
	}
	if cfg.Mode == "" {
		cfg.Mode = "supervised"
	}
	if cfg.Branch.Base == "" {
		cfg.Branch.Base = "main"
	}
	if cfg.Branch.WorktreeDir == "" {
		cfg.Branch.WorktreeDir = ".worktrees"
	}
	if cfg.Branch.Template == "" {
		cfg.Branch.Template = "{type}/{taskId}/{slug}"
	}
	return &cfg, nil
}

// SaveGlobalConfig writes config.toml atomically.
func SaveGlobalConfig(configDir string, cfg *GlobalConfig) error {
	path := filepath.Join(configDir, "config.toml")
	os.MkdirAll(configDir, 0o755)
	data, err := toml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	return os.WriteFile(path, data, 0o644)
}

// GlobalConfigDir returns the default global config directory.
func GlobalConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "maomao")
}

// MigrateConfigDir copies config from ~/.config/mxd/ to ~/.config/maomao/ if needed.
func MigrateConfigDir() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	oldDir := filepath.Join(home, ".config", "mxd")
	newDir := filepath.Join(home, ".config", "maomao")

	// Only migrate if old exists and new doesn't
	if _, err := os.Stat(oldDir); err != nil {
		return // old doesn't exist
	}
	if _, err := os.Stat(newDir); err == nil {
		return // new already exists
	}

	// Copy old to new
	os.MkdirAll(filepath.Dir(newDir), 0o755)
	os.Rename(oldDir, newDir)
}
