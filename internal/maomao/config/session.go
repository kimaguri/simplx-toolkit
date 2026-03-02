package config

import (
	"os"
	"path/filepath"

	toml "github.com/pelletier/go-toml/v2"
)

// SessionState persists UI state across TUI restarts.
type SessionState struct {
	LastTask      string `toml:"last_task"`
	Focus         string `toml:"focus"`          // "sidebar" or "panes"
	PaneIdx       int    `toml:"pane_idx"`
	SidebarHidden bool   `toml:"sidebar_hidden"`
}

// LoadSession reads session.toml from the config directory.
// Returns zero-value SessionState if file doesn't exist or is invalid.
func LoadSession(configDir string) SessionState {
	path := filepath.Join(configDir, "session.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return SessionState{}
	}
	var s SessionState
	if err := toml.Unmarshal(data, &s); err != nil {
		return SessionState{}
	}
	return s
}

// SaveSession writes session.toml to the config directory.
func SaveSession(configDir string, s SessionState) error {
	path := filepath.Join(configDir, "session.toml")
	data, err := toml.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
