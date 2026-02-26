package devdash

import (
	"fmt"
	"os"
	"syscall"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
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
		rp := pm.reconnectSession(info)
		if rp != nil {
			reconnected = append(reconnected, rp)
		}
	}

	return reconnected
}

// reconnectSession attempts to reconnect a single session.
// Returns nil if the process is no longer alive.
func (pm *ProcessManager) reconnectSession(info SessionInfo) *RunningProcess {
	if !IsProcessAlive(info.PID) {
		_ = RemoveSession(pm.sessionsDir, info.Name)
		return nil
	}

	_, err := os.FindProcess(info.PID)
	if err != nil {
		_ = RemoveSession(pm.sessionsDir, info.Name)
		return nil
	}

	logBuf := process.NewLogBuffer(process.DefaultMaxLines)
	tailStop := make(chan struct{})

	// Read previous log content from file (sanitize raw PTY output)
	logPath := pm.logFilePath(info.Name)
	var startOffset int64
	if data, readErr := os.ReadFile(logPath); readErr == nil && len(data) > 0 {
		logBuf.Write(process.SanitizeForLog(data))
		logBuf.Flush()
		startOffset = int64(len(data))
	}

	// Continue tailing the log file for new output
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

	return rp
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

	signalReconnectedProcess(pid)

	pm.mu.Lock()
	delete(pm.processes, name)
	pm.mu.Unlock()

	_ = RemoveSession(pm.sessionsDir, name)
	return nil
}

// signalReconnectedProcess sends SIGTERM, waits, then SIGKILL if still alive.
func signalReconnectedProcess(pid int) {
	pgid, err := syscall.Getpgid(pid)
	if err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
	} else {
		proc, findErr := os.FindProcess(pid)
		if findErr == nil {
			_ = proc.Signal(syscall.SIGTERM)
		}
	}

	time.Sleep(1 * time.Second)
	if IsProcessAlive(pid) {
		if pgid, err := syscall.Getpgid(pid); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
}
