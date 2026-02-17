package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// LocalConfig holds persistent user configuration
type LocalConfig struct {
	ScanDirs      []string       `json:"scan_dirs"`
	PortOverrides map[string]int `json:"port_overrides,omitempty"`
}

// configDir returns the config directory path: ~/.config/local-dev/
func configDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".local-dev"
	}
	return filepath.Join(home, ".config", "local-dev")
}

// ConfigDir returns the config directory path (exported)
func ConfigDir() string {
	return configDir()
}

// SessionsDir returns the sessions directory path: ~/.config/local-dev/sessions/
func SessionsDir() string {
	return filepath.Join(configDir(), "sessions")
}

// LogsDir returns the logs directory path: ~/.config/local-dev/logs/
func LogsDir() string {
	return filepath.Join(configDir(), "logs")
}

// configPath returns the config file path
func configPath() string {
	return filepath.Join(configDir(), "config.json")
}

// LoadConfig loads configuration from disk. Returns empty config if file doesn't exist.
func LoadConfig() *LocalConfig {
	cfg := &LocalConfig{
		PortOverrides: make(map[string]int),
	}

	data, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return cfg
	}

	if cfg.PortOverrides == nil {
		cfg.PortOverrides = make(map[string]int)
	}

	return cfg
}

// SaveConfig persists the config to disk
func SaveConfig(cfg *LocalConfig) error {
	dir := configDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath(), data, 0o644)
}

// AddScanDir adds a directory to the scan list if not already present. Returns true if added.
func (c *LocalConfig) AddScanDir(dir string) bool {
	abs, err := filepath.Abs(dir)
	if err == nil {
		dir = abs
	}

	for _, d := range c.ScanDirs {
		if d == dir {
			return false
		}
	}
	c.ScanDirs = append(c.ScanDirs, dir)
	return true
}

// RemoveScanDir removes a directory from the scan list. Returns true if removed.
func (c *LocalConfig) RemoveScanDir(dir string) bool {
	for i, d := range c.ScanDirs {
		if d == dir {
			c.ScanDirs = append(c.ScanDirs[:i], c.ScanDirs[i+1:]...)
			return true
		}
	}
	return false
}

// PortKey generates a port override key from worktree and project name
func PortKey(wtName, projectName string) string {
	return wtName + ":" + projectName
}

// GetPort returns the saved port for a project, or 0 if not set
func (c *LocalConfig) GetPort(key string) int {
	return c.PortOverrides[key]
}

// SetPort saves the port for a project
func (c *LocalConfig) SetPort(key string, port int) {
	c.PortOverrides[key] = port
}
