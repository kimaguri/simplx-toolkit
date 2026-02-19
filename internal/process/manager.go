package process

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	LogBuf    *LogBuffer
	Status    ProcessStatus
	StartedAt time.Time
	PtyFile   *os.File      // PTY master fd (nil for reconnected processes)
	VTerm     *VTermScreen  // Virtual terminal screen (nil for reconnected)
	Tunnel    *TunnelInfo   // Cloudflare tunnel (nil if none)
	done      chan struct{}  // closed when process exits (by waitForExit)
	tailStop  chan struct{}  // closed to stop the tail goroutine
	logFile   *os.File      // log file handle (for started processes)
}

// ProcessManager manages the lifecycle of dev processes
type ProcessManager struct {
	mu          sync.RWMutex
	processes   map[string]*RunningProcess
	sessionsDir string
	logsDir     string
	pnpmPath    string
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
	return filepath.Join(pm.logsDir, name+".log")
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

	logBuf := NewLogBuffer(DefaultMaxLines)
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

	// Stop tunnel if process exits on its own
	if rp.Tunnel != nil {
		StopTunnel(rp.Tunnel)
		rp.Tunnel = nil
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

// Reconnect scans existing session files and re-attaches to alive processes.
// Reads previous log output from the log file and starts tailing for new lines.
func (pm *ProcessManager) Reconnect() []*RunningProcess {
	sessions, err := LoadAllSessions(pm.sessionsDir)
	if err != nil {
		return nil
	}

	var reconnected []*RunningProcess
	for _, info := range sessions {
		if !IsProcessAlive(info.PID) {
			_ = RemoveSession(pm.sessionsDir, info.Name)
			continue
		}

		_, err := os.FindProcess(info.PID)
		if err != nil {
			_ = RemoveSession(pm.sessionsDir, info.Name)
			continue
		}

		logBuf := NewLogBuffer(DefaultMaxLines)
		tailStop := make(chan struct{})

		// Read previous log content from file (sanitize raw PTY output)
		logPath := pm.logFilePath(info.Name)
		var startOffset int64
		if data, err := os.ReadFile(logPath); err == nil && len(data) > 0 {
			logBuf.Write(sanitizeForLog(data))
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
	if rp == nil || rp.PtyFile == nil {
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

// StartTunnel opens a Cloudflare Quick Tunnel for a running process
func (pm *ProcessManager) StartTunnel(name string) (*TunnelInfo, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	rp, exists := pm.processes[name]
	if !exists {
		return nil, fmt.Errorf("process %q not found", name)
	}
	if rp.Status != StatusRunning {
		return nil, fmt.Errorf("process %q is not running", name)
	}
	if rp.Tunnel != nil && rp.Tunnel.Status != TunnelOff {
		return nil, fmt.Errorf("tunnel already active for %q", name)
	}

	ti, err := StartTunnel(rp.Info.Port)
	if err != nil {
		return nil, err
	}
	rp.Tunnel = ti
	return ti, nil
}

// StopProcessTunnel stops the Cloudflare tunnel for a process
func (pm *ProcessManager) StopProcessTunnel(name string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	rp, exists := pm.processes[name]
	if !exists {
		return fmt.Errorf("process %q not found", name)
	}
	if rp.Tunnel == nil {
		return fmt.Errorf("no tunnel for %q", name)
	}

	StopTunnel(rp.Tunnel)
	rp.Tunnel = nil
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
			logBuf.Write(sanitizeForLog(data))
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

// sanitizingWriter wraps an io.Writer and sanitizes raw PTY data before writing.
type sanitizingWriter struct {
	w io.Writer
}

func (sw sanitizingWriter) Write(p []byte) (int, error) {
	_, err := sw.w.Write(sanitizeForLog(p))
	return len(p), err
}

// tailFile reads from a log file starting at offset and writes new content to w.
// Polls the file for new data until stop is closed.
// Data is sanitized through sanitizeForLog before writing.
func tailFile(path string, w io.Writer, startOffset int64, stop <-chan struct{}) {
	sw := sanitizingWriter{w: w}

	f, err := os.Open(path)
	if err != nil {
		// File might not exist yet — wait for it
		for i := 0; i < 50; i++ {
			select {
			case <-stop:
				return
			case <-time.After(100 * time.Millisecond):
			}
			f, err = os.Open(path)
			if err == nil {
				break
			}
		}
		if f == nil {
			return
		}
	}
	defer f.Close()

	if startOffset > 0 {
		f.Seek(startOffset, io.SeekStart)
	}

	buf := make([]byte, 4096)
	for {
		select {
		case <-stop:
			// Final read to catch remaining data
			for {
				n, _ := f.Read(buf)
				if n > 0 {
					sw.Write(buf[:n])
				}
				if n == 0 {
					break
				}
			}
			return
		default:
		}

		n, err := f.Read(buf)
		if n > 0 {
			sw.Write(buf[:n])
		}
		if err == io.EOF || n == 0 {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if err != nil {
			return
		}
	}
}

// findPnpm locates the pnpm binary
func findPnpm() string {
	path, err := exec.LookPath("pnpm")
	if err != nil {
		return "pnpm"
	}
	return path
}
