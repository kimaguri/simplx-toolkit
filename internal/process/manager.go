package process

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ProcessStatus represents the current state of a managed process
type ProcessStatus int

const (
	StatusRunning ProcessStatus = iota
	StatusStopped
	StatusError
)

// String returns a human-readable label for the status
func (s ProcessStatus) String() string {
	switch s {
	case StatusRunning:
		return "running"
	case StatusStopped:
		return "stopped"
	case StatusError:
		return "error"
	default:
		return "unknown"
	}
}

// SessionInfo holds the configuration needed to start a process
type SessionInfo struct {
	Name     string
	Command  string
	Args     []string
	WorkDir  string
	ExtraEnv []string
}

// RunningProcess holds runtime information about a managed process
type RunningProcess struct {
	Info      SessionInfo
	Cmd       *exec.Cmd
	LogBuf    *LogBuffer
	Status    ProcessStatus
	StartedAt time.Time
	PtyFile   *os.File
	VTerm     *VTermScreen
	done      chan struct{}
	tailStop  chan struct{}
	logFile   *os.File
}

// ProcessManager manages the lifecycle of dev processes
type ProcessManager struct {
	mu        sync.RWMutex
	processes map[string]*RunningProcess
	logsDir   string
}

// NewProcessManager creates a new manager.
func NewProcessManager(logsDir string) *ProcessManager {
	return &ProcessManager{
		processes: make(map[string]*RunningProcess),
		logsDir:   logsDir,
	}
}

// logFilePath returns the log file path for a session
func (pm *ProcessManager) logFilePath(name string) string {
	safe := strings.ReplaceAll(name, "/", "_")
	return pm.logsDir + "/" + safe + ".log"
}

// Start spawns a new process based on the given SessionInfo
func (pm *ProcessManager) Start(info SessionInfo) (*RunningProcess, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if _, exists := pm.processes[info.Name]; exists {
		return nil, fmt.Errorf("process %q already running", info.Name)
	}

	// Create log file — stdout/stderr go here (survives TUI restart)
	if err := os.MkdirAll(pm.logsDir, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create logs dir: %w", err)
	}
	logPath := pm.logFilePath(info.Name)
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create log file: %w", err)
	}

	cmd := exec.Command(info.Command, info.Args...)
	cmd.Dir = info.WorkDir
	cmd.Env = append(os.Environ(), info.ExtraEnv...)

	// Start with PTY so child process sees a real TTY (enables interactive prompts)
	ptyFile, err := StartWithPTY(cmd, DefaultPTYRows, DefaultPTYCols)
	if err != nil {
		logFile.Close()
		os.Remove(logPath)
		return nil, fmt.Errorf("failed to start %q: %w", info.Name, err)
	}
	vterm := NewVTermScreen(int(DefaultPTYRows), int(DefaultPTYCols))

	logBuf := NewLogBuffer(DefaultMaxLines)
	tailStop := make(chan struct{})
	done := make(chan struct{})

	rp := &RunningProcess{
		Info:      info,
		Cmd:       cmd,
		LogBuf:    logBuf,
		Status:    StatusRunning,
		StartedAt: time.Now(),
		PtyFile:   ptyFile,
		VTerm:     vterm,
		done:      done,
		tailStop:  tailStop,
		logFile:   logFile,
	}
	pm.processes[info.Name] = rp

	// Read PTY output into logFile + VTerm + LogBuffer
	go readPTY(ptyFile, logFile, vterm, logBuf, tailStop)

	// Wait for process exit
	go pm.waitForExit(info.Name, cmd, logFile, done, tailStop, ptyFile)

	return rp, nil
}

// waitForExit waits for the process to exit and updates its status.
func (pm *ProcessManager) waitForExit(name string, cmd *exec.Cmd, logFile *os.File, done, tailStop chan struct{}, ptyFile *os.File) {
	err := cmd.Wait()

	// Give PTY reader goroutine a moment to catch up on remaining output
	time.Sleep(200 * time.Millisecond)
	close(tailStop)
	if ptyFile != nil {
		ptyFile.Close()
	}
	logFile.Close()
	close(done)

	pm.mu.Lock()
	defer pm.mu.Unlock()

	rp, exists := pm.processes[name]
	if !exists {
		return
	}

	if err != nil {
		rp.Status = StatusError
		rp.LogBuf.Write([]byte(fmt.Sprintf("\n[process exited with error: %v]\n", err)))
	} else {
		rp.Status = StatusStopped
		rp.LogBuf.Write([]byte("\n[process exited normally]\n"))
	}
	rp.LogBuf.Flush()
}

// Stop sends SIGTERM then SIGKILL after timeout
func (pm *ProcessManager) Stop(name string) error {
	pm.mu.Lock()
	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.Unlock()
		return fmt.Errorf("process %q not found", name)
	}
	pm.mu.Unlock()

	if rp.Status == StatusRunning && rp.Cmd != nil && rp.Cmd.Process != nil {
		pgid, err := syscall.Getpgid(rp.Cmd.Process.Pid)
		if err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
		} else {
			_ = rp.Cmd.Process.Signal(syscall.SIGTERM)
		}

		select {
		case <-rp.done:
			// exited gracefully
		case <-time.After(5 * time.Second):
			if pgid, err := syscall.Getpgid(rp.Cmd.Process.Pid); err == nil {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			} else {
				_ = rp.Cmd.Process.Kill()
			}
			<-rp.done
		}
	}

	pm.mu.Lock()
	rp.Status = StatusStopped
	delete(pm.processes, name)
	pm.mu.Unlock()

	return nil
}

// Restart stops a process and starts it again with the same configuration
func (pm *ProcessManager) Restart(name string) (*RunningProcess, error) {
	pm.mu.RLock()
	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.RUnlock()
		return nil, fmt.Errorf("process %q not found", name)
	}
	info := rp.Info
	pm.mu.RUnlock()

	if err := pm.Stop(name); err != nil {
		return nil, fmt.Errorf("failed to stop %q for restart: %w", name, err)
	}

	time.Sleep(200 * time.Millisecond)

	return pm.Start(info)
}

// List returns a snapshot of all managed processes
func (pm *ProcessManager) List() []*RunningProcess {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	result := make([]*RunningProcess, 0, len(pm.processes))
	for _, rp := range pm.processes {
		result = append(result, rp)
	}
	return result
}

// readPTY reads from PTY master and writes to logFile + VTerm + LogBuffer.
// logFile and VTerm get raw output; LogBuffer gets sanitized output
// (cursor movement and screen control stripped, colors preserved).
func readPTY(ptyFile *os.File, logFile *os.File, vterm *VTermScreen, logBuf *LogBuffer, stop <-chan struct{}) {
	buf := make([]byte, 4096)
	for {
		n, err := ptyFile.Read(buf)
		if n > 0 {
			data := buf[:n]
			logFile.Write(data)
			vterm.Write(data)
			logBuf.Write(SanitizeForLog(data))
		}
		if err != nil {
			return
		}
		// Check if we should stop
		select {
		case <-stop:
			return
		default:
		}
	}
}
