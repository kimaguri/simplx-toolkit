package process

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Reconnect scans existing session files and re-attaches to alive processes.
// Reads previous log output from the log file and starts tailing for new lines.
func (pm *ProcessManager) Reconnect() []*RunningProcess {
	sessions, err := LoadAllSessions(pm.sessionsDir)
	if err != nil {
		return nil
	}

	var reconnected []*RunningProcess
	for _, info := range sessions {
		scrollbackDir := filepath.Join(pm.logsDir, "scrollback", SafeName(info.Name))
		logBuf := NewSegmentedLog(scrollbackDir, DefaultMaxLines)

		// Try tmux reconnection first
		if IsTmuxAvailable() {
			logPath := pm.logFilePath(info.Name)
			var startOffset int64
			if fi, err := os.Stat(logPath); err == nil {
				startOffset = fi.Size()
			}

			ts, err := ReconnectTmuxSession(info.Name, logPath, startOffset, logBuf)
			if err == nil {
				done := make(chan struct{})
				rp := &RunningProcess{
					Info:      info,
					LogBuf:    logBuf,
					Status:    StatusRunning,
					StartedAt: time.Unix(info.StartedAt, 0),
					tmux:      ts,
					done:      done,
				}

				go pm.waitForTmuxExit(info.Name, ts, done)

				pm.mu.Lock()
				pm.processes[info.Name] = rp
				pm.mu.Unlock()
				reconnected = append(reconnected, rp)
				continue
			}
		}

		// Fallback: PTY reconnection via log tailing
		if !IsProcessAlive(info.PID) {
			_ = RemoveSession(pm.sessionsDir, info.Name)
			continue
		}

		_, err := os.FindProcess(info.PID)
		if err != nil {
			_ = RemoveSession(pm.sessionsDir, info.Name)
			continue
		}

		tailStop := make(chan struct{})

		// Segments already on disk from previous session.
		// Tail the raw log file for new output from current file end.
		logPath := pm.logFilePath(info.Name)
		var startOffset int64
		if fi, err := os.Stat(logPath); err == nil {
			startOffset = fi.Size()
		}

		go tailFile(logPath, logBuf, startOffset, tailStop)

		rp := &RunningProcess{
			Info:      info,
			Cmd:       nil,
			LogBuf:    logBuf,
			Status:    StatusRunning,
			StartedAt: time.Unix(info.StartedAt, 0),
			tailStop:  tailStop,
		}

		pm.mu.Lock()
		pm.processes[info.Name] = rp
		pm.mu.Unlock()

		reconnected = append(reconnected, rp)
	}

	return reconnected
}

// StopReconnected kills a process that was reconnected (no exec.Cmd available)
func (pm *ProcessManager) StopReconnected(name string) error {
	pm.mu.Lock()
	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.Unlock()
		return fmt.Errorf("process %q not found", name)
	}

	if rp.Cmd != nil {
		pm.mu.Unlock()
		return pm.Stop(name)
	}

	pid := rp.Info.PID
	pm.mu.Unlock()

	// Stop tailing
	if rp.tailStop != nil {
		close(rp.tailStop)
	}

	pgid, err := syscall.Getpgid(pid)
	if err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
	} else {
		proc, err := os.FindProcess(pid)
		if err == nil {
			_ = proc.Signal(syscall.SIGTERM)
		}
	}

	time.Sleep(1 * time.Second)
	if IsProcessAlive(pid) {
		if pgid, err := syscall.Getpgid(pid); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}

	pm.mu.Lock()
	delete(pm.processes, name)
	pm.mu.Unlock()

	_ = RemoveSession(pm.sessionsDir, name)
	return nil
}
