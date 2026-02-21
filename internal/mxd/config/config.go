package config

import (
	"fmt"
	"os"
	"path/filepath"

	toml "github.com/pelletier/go-toml/v2"
)

// ProjectConfig represents .mxd/project.toml
type ProjectConfig struct {
	Project ProjectSection `toml:"project"`
	Branch  BranchSection  `toml:"branch"`
}

type ProjectSection struct {
	Name  string     `toml:"name"`
	Repos []RepoConf `toml:"repos"`
}

type RepoConf struct {
	Name string `toml:"name"`
	Path string `toml:"path"`
	Role string `toml:"role"`
}

type BranchSection struct {
	Template    string `toml:"template"`
	Base        string `toml:"base"`
	WorktreeDir string `toml:"worktree_dir"`
}

// GlobalConfig represents ~/.config/mxd/config.toml
type GlobalConfig struct {
	DefaultAgent string               `toml:"default_agent"`
	Mode         string               `toml:"mode"`
	Agents       map[string]AgentConf `toml:"agents"`
}

type AgentConf struct {
	Name    string   `toml:"name"`
	Command string   `toml:"command"`
	Args    []string `toml:"args"`
	Detect  string   `toml:"detect"`
}

// LoadProjectConfig reads .mxd/project.toml from the given root directory.
func LoadProjectConfig(root string) (*ProjectConfig, error) {
	path := filepath.Join(root, ".mxd", "project.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read project config: %w", err)
	}
	var cfg ProjectConfig
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse project config: %w", err)
	}
	if cfg.Branch.Base == "" {
		cfg.Branch.Base = "main"
	}
	if cfg.Branch.WorktreeDir == "" {
		cfg.Branch.WorktreeDir = ".worktrees"
	}
	return &cfg, nil
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
	return &cfg, nil
}

// GlobalConfigDir returns the default global config directory.
func GlobalConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "mxd")
}
