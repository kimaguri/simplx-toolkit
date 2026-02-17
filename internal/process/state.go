package process

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
)

// SessionInfo represents a persisted session state, saved as JSON
type SessionInfo struct {
	Name      string   `json:"name"`
	PID       int      `json:"pid"`
	Port      int      `json:"port"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	ExtraEnv  []string `json:"extra_env,omitempty"`
	WorkDir   string   `json:"work_dir"`
	Project   string   `json:"project"`
	WtName    string   `json:"wt_name"`
	WtPath    string   `json:"wt_path"`
	StartedAt int64    `json:"started_at"`
}

// sessionFilePath returns the full path for a session JSON file
func sessionFilePath(sessionsDir, name string) string {
	return filepath.Join(sessionsDir, name+".json")
}

// SaveSession writes a SessionInfo as JSON to the sessions directory
func SaveSession(sessionsDir string, info SessionInfo) error {
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sessionFilePath(sessionsDir, info.Name), data, 0o644)
}

// LoadAllSessions reads all session files from the sessions directory
func LoadAllSessions(sessionsDir string) ([]SessionInfo, error) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var sessions []SessionInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := filepath.Ext(entry.Name())
		if ext != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(sessionsDir, entry.Name()))
		if err != nil {
			continue
		}
		var info SessionInfo
		if err := json.Unmarshal(data, &info); err != nil {
			continue
		}
		sessions = append(sessions, info)
	}
	return sessions, nil
}

// RemoveSession deletes the session file for the given name
func RemoveSession(sessionsDir, name string) error {
	err := os.Remove(sessionFilePath(sessionsDir, name))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// IsProcessAlive checks if a process with the given PID is still running.
// Uses signal 0 which checks for process existence without actually sending a signal.
func IsProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
