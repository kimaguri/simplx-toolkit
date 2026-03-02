package process

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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

// RunningProcess holds runtime information about a managed process
type RunningProcess struct {
	Info      SessionInfo
	Cmd       *exec.Cmd
	LogBuf    *SegmentedLog
	Status    ProcessStatus
	StartedAt time.Time
	PtyFile   *os.File         // PTY master fd (nil for reconnected processes)
	VTerm     *VTermScreen     // Virtual terminal screen (nil for reconnected)
	Tunnel    *TunnelInfo      // Cloudflare tunnel (nil if none)
	tmux      *TmuxSession     // non-nil when using tmux backend
	done      chan struct{}     // closed when process exits (by waitForExit)
	tailStop  chan struct{}     // closed to stop the tail goroutine
	logFile   *os.File         // log file handle (for started processes)
	scrollCap *ScrollCapture   // VTerm scroll capture (nil for reconnected)
}

// Terminal returns the display renderer (TmuxSession or VTermScreen).
// Satisfies interface{ Render() string } for PaneInit.VTerm slot.
func (rp *RunningProcess) Terminal() interface{ Render() string } {
	if rp.tmux != nil {
		return rp.tmux
	}
	return rp.VTerm
}

// InputWriter returns the io.Writer for sending input (TmuxSession or PTY fd).
func (rp *RunningProcess) InputWriter() io.Writer {
	if rp.tmux != nil {
		return rp.tmux
	}
	if rp.PtyFile != nil {
		return rp.PtyFile
	}
	return nil
}

// ScrollbackSource returns the ScrollbackReader (TmuxSession or SegmentedLog).
// Named ScrollbackSource to avoid collision with the ScrollbackReader interface.
func (rp *RunningProcess) ScrollbackSource() interface {
	Len() int
	ReadRange(start, end int) []string
} {
	if rp.tmux != nil {
		return rp.tmux
	}
	return rp.LogBuf
}

// ProcessManager manages the lifecycle of dev processes
type ProcessManager struct {
	mu          sync.RWMutex
	processes   map[string]*RunningProcess
	sessionsDir string
	logsDir     string
	pnpmPath    string
	OnExit      func(key string, exitCode int) // called from goroutine when a process exits
}

// NewProcessManager creates a new manager.
func NewProcessManager(sessionsDir, logsDir string) *ProcessManager {
	pnpmPath := findPnpm()
	return &ProcessManager{
		processes:   make(map[string]*RunningProcess),
		sessionsDir: sessionsDir,
		logsDir:     logsDir,
		pnpmPath:    pnpmPath,
	}
}

// PnpmPath returns the detected pnpm binary path
func (pm *ProcessManager) PnpmPath() string {
	return pm.pnpmPath
}

// logFilePath returns the log file path for a session
func (pm *ProcessManager) logFilePath(name string) string {
	safe := strings.ReplaceAll(name, "/", "_")
	return filepath.Join(pm.logsDir, safe+".log")
}

// Start spawns a new process based on the given SessionInfo
func (pm *ProcessManager) Start(info SessionInfo) (*RunningProcess, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if _, exists := pm.processes[info.Name]; exists {
		return nil, fmt.Errorf("process %q already running", info.Name)
	}

	scrollbackDir := filepath.Join(pm.logsDir, "scrollback", SafeName(info.Name))
	logBuf := NewSegmentedLog(scrollbackDir, DefaultMaxLines)
	logBuf.Reset() // Clear stale scrollback from previous sessions

	// Try tmux first, fall back to PTY+VTerm+ScrollCapture
	if IsTmuxAvailable() {
		// Create log file for pipe-pane output
		if err := os.MkdirAll(pm.logsDir, 0o755); err == nil {
			logPath := pm.logFilePath(info.Name)
			if logFile, err := os.Create(logPath); err == nil {
				logFile.Close() // pipe-pane will append to this file

				ts, err := StartTmuxSession(info.Name, int(defaultPTYRows), int(defaultPTYCols),
					info.Command, info.Args, info.WorkDir, info.ExtraEnv, logPath, logBuf)
				if err == nil {
					info.StartedAt = time.Now().Unix()
					if err := SaveSession(pm.sessionsDir, info); err != nil {
						_, _ = fmt.Fprintf(os.Stderr, "warning: failed to save session %q: %v\n", info.Name, err)
					}

					done := make(chan struct{})
					rp := &RunningProcess{
						Info:      info,
						LogBuf:    logBuf,
						Status:    StatusRunning,
						StartedAt: time.Unix(info.StartedAt, 0),
						tmux:      ts,
						done:      done,
					}
					pm.processes[info.Name] = rp

					go pm.waitForTmuxExit(info.Name, ts, done)
					return rp, nil
				}
			}
		}
		// tmux failed, fall through to PTY path
	}

	// Fallback: PTY+VTerm+ScrollCapture
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
	ptyFile, err := startWithPTY(cmd, defaultPTYRows, defaultPTYCols)
	if err != nil {
		logFile.Close()
		os.Remove(logPath)
		return nil, fmt.Errorf("failed to start %q: %w", info.Name, err)
	}
	vterm := NewVTermScreen(int(defaultPTYRows), int(defaultPTYCols))

	info.PID = cmd.Process.Pid
	info.StartedAt = time.Now().Unix()

	if err := SaveSession(pm.sessionsDir, info); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "warning: failed to save session %q: %v\n", info.Name, err)
	}

	scrollCap := NewScrollCapture(int(defaultPTYRows), logBuf)
	tailStop := make(chan struct{})
	done := make(chan struct{})

	rp := &RunningProcess{
		Info:      info,
		Cmd:       cmd,
		LogBuf:    logBuf,
		Status:    StatusRunning,
		StartedAt: time.Unix(info.StartedAt, 0),
		PtyFile:   ptyFile,
		VTerm:     vterm,
		done:      done,
		tailStop:  tailStop,
		logFile:   logFile,
		scrollCap: scrollCap,
	}
	pm.processes[info.Name] = rp

	// Read PTY output into logFile + VTerm (via scroll capture)
	go readPTY(ptyFile, logFile, vterm, scrollCap, tailStop)

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

	exitCode := 0
	if err != nil {
		exitCode = 1
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}

	pm.mu.Lock()

	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.Unlock()
		return
	}

	// Stop tunnel if process exits on its own
	if rp.Tunnel != nil {
		StopTunnel(rp.Tunnel)
		rp.Tunnel = nil
	}

	// Flush VTerm's final screen content to scrollback history
	if rp.scrollCap != nil && rp.VTerm != nil {
		rp.scrollCap.Flush(rp.VTerm)
	}

	if err != nil {
		rp.Status = StatusError
		rp.LogBuf.Write([]byte(fmt.Sprintf("\n[process exited with error: %v]\n", err)))
	} else {
		rp.Status = StatusStopped
		rp.LogBuf.Write([]byte("\n[process exited normally]\n"))
	}
	rp.LogBuf.Flush()
	pm.mu.Unlock()

	if pm.OnExit != nil {
		pm.OnExit(name, exitCode)
	}
}

// waitForTmuxExit waits for the tmux-backed process to exit and updates its status.
func (pm *ProcessManager) waitForTmuxExit(name string, ts *TmuxSession, done chan struct{}) {
	<-ts.Done()
	close(done)

	exitCode := ts.ExitCode()

	pm.mu.Lock()

	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.Unlock()
		return
	}

	// Stop tunnel if process exits on its own
	if rp.Tunnel != nil {
		StopTunnel(rp.Tunnel)
		rp.Tunnel = nil
	}

	if exitCode != 0 {
		rp.Status = StatusError
		rp.LogBuf.Write([]byte(fmt.Sprintf("\n[process exited with code %d]\n", exitCode)))
	} else {
		rp.Status = StatusStopped
		rp.LogBuf.Write([]byte("\n[process exited normally]\n"))
	}
	rp.LogBuf.Flush()
	pm.mu.Unlock()

	if pm.OnExit != nil {
		pm.OnExit(name, exitCode)
	}
}

// Stop sends SIGTERM then SIGKILL after timeout, removes session state
func (pm *ProcessManager) Stop(name string) error {
	pm.mu.Lock()
	rp, exists := pm.processes[name]
	if !exists {
		pm.mu.Unlock()
		return fmt.Errorf("process %q not found", name)
	}
	pm.mu.Unlock()

	// Stop tunnel before killing the process
	if rp.Tunnel != nil {
		StopTunnel(rp.Tunnel)
		rp.Tunnel = nil
	}

	if rp.tmux != nil {
		rp.tmux.Kill()
		<-rp.done
	} else if rp.Status == StatusRunning && rp.Cmd != nil && rp.Cmd.Process != nil {
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

	_ = RemoveSession(pm.sessionsDir, name)
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

// WriteInput sends raw bytes to the process via PTY stdin
func (pm *ProcessManager) WriteInput(name string, data []byte) error {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	rp := pm.processes[name]
	if rp == nil || rp.PtyFile == nil {
		return fmt.Errorf("process %q has no PTY", name)
	}
	_, err := rp.PtyFile.Write(data)
	return err
}

// ResizePTY changes the terminal window size for a process
func (pm *ProcessManager) ResizePTY(name string, rows, cols uint16) error {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	rp := pm.processes[name]
	if rp == nil {
		return fmt.Errorf("process %q not found", name)
	}
	if rp.tmux != nil {
		rp.tmux.Resize(int(rows), int(cols))
		return nil
	}
	if rp.PtyFile == nil {
		return fmt.Errorf("process %q has no PTY", name)
	}
	if err := resizePTY(rp.PtyFile, rows, cols); err != nil {
		return err
	}
	if rp.VTerm != nil {
		rp.VTerm.Resize(int(rows), int(cols))
	}
	return nil
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

// Get returns a single process by name, or nil if not found
func (pm *ProcessManager) Get(name string) *RunningProcess {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return pm.processes[name]
}

// findPnpm locates the pnpm binary
func findPnpm() string {
	path, err := exec.LookPath("pnpm")
	if err != nil {
		return "pnpm"
	}
	return path
}
