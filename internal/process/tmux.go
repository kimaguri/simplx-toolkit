package process

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	tmuxSocket       = "maomao"
	tmuxPollInterval = 100 * time.Millisecond
	tmuxHistoryLimit = 50000
)

// TmuxSession manages a process inside a tmux session.
// Live screen comes from tmux capture-pane (Render).
// Scrollback uses tmux's native scrollback buffer — tmux correctly filters
// alternate screen content (TUI redraws) from scrollback automatically.
// On process exit, scrollback is dumped to SegmentedLog for persistence.
// Input goes through tmux send-keys (Write).
type TmuxSession struct {
	name   string         // tmux session name (maomao-<safe-process-name>)
	rows   int
	cols   int
	seglog *SegmentedLog  // persistence after process exit

	// Live screen (updated by poller via capture-pane)
	screen string
	mu     sync.RWMutex

	// Pane metadata (updated by poller)
	histSize   int  // tmux history_size (scrollback lines above visible)
	paneHeight int
	paneDead   bool
	deadStatus int
	exited     bool

	// Lifecycle
	stopPoller chan struct{}
	done       chan struct{} // closed when process exits
}

// IsTmuxAvailable checks if tmux binary exists in PATH.
func IsTmuxAvailable() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

// StartTmuxSession creates a tmux session, starts the command, and uses
// tmux's native scrollback for history (which correctly filters alt screen content).
//
// To avoid a race condition where fast commands produce output before session
// is fully configured, we start with a plain shell, configure options, then
// send the actual command via send-keys with exec (so remain-on-exit still works).
func StartTmuxSession(name string, rows, cols int, command string, args []string,
	workDir string, env []string, logPath string, seglog *SegmentedLog) (*TmuxSession, error) {

	sessName := "maomao-" + SafeName(name)

	// Build the shell command to run inside tmux
	shellCmd := command
	for _, a := range args {
		shellCmd += " " + shellQuote(a)
	}

	// Set environment variables
	if len(env) > 0 {
		var envParts []string
		for _, e := range env {
			envParts = append(envParts, "export "+shellQuote(e))
		}
		shellCmd = strings.Join(envParts, "; ") + "; " + shellCmd
	}

	// Wrap with cd if workDir specified
	if workDir != "" {
		shellCmd = "cd " + shellQuote(workDir) + " && " + shellCmd
	}

	// Step 1: Create session with a placeholder shell.
	// We'll replace it immediately with respawn-pane after configuring options.
	createArgs := []string{
		"-L", tmuxSocket,
		"new-session", "-d",
		"-s", sessName,
		"-x", strconv.Itoa(cols),
		"-y", strconv.Itoa(rows),
		"sh", "-c", "sleep 999",
	}

	out, err := exec.Command("tmux", createArgs...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("tmux new-session failed: %w: %s", err, string(out))
	}

	// Step 2: Configure session options BEFORE starting the actual command.
	tmuxCmd("-L", tmuxSocket, "set-option", "-t", sessName, "remain-on-exit", "on")
	tmuxCmd("-L", tmuxSocket, "set-option", "-t", sessName, "history-limit",
		strconv.Itoa(tmuxHistoryLimit))

	// Optional: pipe-pane for raw logging (debugging only, not used for scrollback)
	if logPath != "" {
		tmuxCmd("-L", tmuxSocket, "pipe-pane", "-t", sessName, "cat >> "+shellQuote(logPath))
	}

	// Step 3: Replace placeholder with the actual command using respawn-pane.
	// This produces a clean start with no shell echo or prompt artifacts.
	out, err = exec.Command("tmux",
		"-L", tmuxSocket,
		"respawn-pane", "-t", sessName, "-k",
		"sh", "-c", shellCmd,
	).CombinedOutput()
	if err != nil {
		tmuxCmd("-L", tmuxSocket, "kill-session", "-t", sessName)
		return nil, fmt.Errorf("respawn-pane failed: %w: %s", err, string(out))
	}

	ts := &TmuxSession{
		name:       sessName,
		rows:       rows,
		cols:       cols,
		seglog:     seglog,
		paneHeight: rows,
		stopPoller: make(chan struct{}),
		done:       make(chan struct{}),
	}

	// Initial screen capture
	if screen, err := ts.capturePaneVisible(); err == nil {
		ts.screen = screen
	}

	// Start background poller for live screen + scrollback metadata + pane_dead detection
	go ts.pollLoop()

	return ts, nil
}

// ReconnectTmuxSession attaches to an existing tmux session (after TUI restart).
// SegmentedLog segments from the previous session are already on disk.
func ReconnectTmuxSession(name string, logPath string, startOffset int64, seglog *SegmentedLog) (*TmuxSession, error) {
	sessName := "maomao-" + SafeName(name)

	if !tmuxSessionExists(sessName) {
		return nil, fmt.Errorf("tmux session %q not found", sessName)
	}

	// Get pane dimensions and state
	histSize, paneHeight, dead, deadStatus, _, err := paneInfoByName(sessName)
	if err != nil {
		return nil, fmt.Errorf("failed to get pane info: %w", err)
	}

	ts := &TmuxSession{
		name:       sessName,
		rows:       paneHeight,
		seglog:     seglog,
		histSize:   histSize,
		paneHeight: paneHeight,
		paneDead:   dead,
		deadStatus: deadStatus,
		stopPoller: make(chan struct{}),
		done:       make(chan struct{}),
	}

	if dead {
		ts.onExit()
		return ts, nil
	}

	// Capture initial screen
	if screen, err := ts.capturePaneVisible(); err == nil {
		ts.screen = screen
	}

	go ts.pollLoop()

	return ts, nil
}

// Render returns cached visible screen (called by TUI at 50ms intervals).
func (ts *TmuxSession) Render() string {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.screen
}

// Write sends raw bytes to tmux pane via send-keys -l.
// Implements io.Writer for PTYWriter slot.
func (ts *TmuxSession) Write(p []byte) (int, error) {
	ts.mu.RLock()
	if ts.exited {
		ts.mu.RUnlock()
		return 0, fmt.Errorf("tmux session has exited")
	}
	ts.mu.RUnlock()

	out, err := exec.Command("tmux",
		"-L", tmuxSocket,
		"send-keys", "-t", ts.name,
		"-l", string(p),
	).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("send-keys failed: %w: %s", err, string(out))
	}
	return len(p), nil
}

// Len returns total scrollback line count.
// While alive: tmux history_size + pane_height.
// After exit: SegmentedLog line count.
func (ts *TmuxSession) Len() int {
	ts.mu.RLock()
	exited := ts.exited
	histSize := ts.histSize
	paneHeight := ts.paneHeight
	ts.mu.RUnlock()

	if exited {
		return ts.seglog.Len()
	}
	return histSize + paneHeight
}

// ReadRange reads scrollback lines.
// While alive: uses tmux capture-pane with coordinate mapping.
// After exit: reads from SegmentedLog (persisted on disk).
//
// Line numbering: 0 = oldest scrollback line, histSize = first visible line.
// tmux uses: -(histSize) = oldest, -1 = newest scrollback, 0 = first visible.
func (ts *TmuxSession) ReadRange(start, end int) []string {
	ts.mu.RLock()
	exited := ts.exited
	histSize := ts.histSize
	ts.mu.RUnlock()

	if exited {
		return ts.seglog.ReadRange(start, end)
	}

	// Convert absolute → tmux-relative line numbers
	tmuxStart := start - histSize
	tmuxEnd := (end - 1) - histSize // end is exclusive, capture-pane -E is inclusive

	output, err := ts.capturePaneRange(tmuxStart, tmuxEnd)
	if err != nil {
		return nil
	}

	lines := strings.Split(output, "\n")
	// capture-pane adds a trailing newline → remove empty last element
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// Done returns a channel that's closed when the process exits.
func (ts *TmuxSession) Done() <-chan struct{} {
	return ts.done
}

// ExitCode returns the process exit code (valid only after Done is closed).
func (ts *TmuxSession) ExitCode() int {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.deadStatus
}

// Kill sends C-c then kills the tmux session.
func (ts *TmuxSession) Kill() {
	ts.mu.RLock()
	exited := ts.exited
	ts.mu.RUnlock()

	if exited {
		return
	}

	// Send Ctrl-C
	tmuxCmd("-L", tmuxSocket, "send-keys", "-t", ts.name, "C-c", "")

	select {
	case <-ts.done:
		return
	case <-time.After(2 * time.Second):
	}

	// Force kill the session
	tmuxCmd("-L", tmuxSocket, "kill-session", "-t", ts.name)

	select {
	case <-ts.done:
	case <-time.After(2 * time.Second):
		ts.mu.Lock()
		if !ts.exited {
			ts.exited = true
			close(ts.done)
		}
		ts.mu.Unlock()
	}
}

// Resize changes tmux window dimensions.
// No-op if dimensions haven't changed (avoids spawning tmux process).
func (ts *TmuxSession) Resize(rows, cols int) {
	ts.mu.Lock()
	if ts.rows == rows && ts.cols == cols {
		ts.mu.Unlock()
		return
	}
	ts.rows = rows
	ts.cols = cols
	ts.mu.Unlock()

	tmuxCmd("-L", tmuxSocket, "resize-window", "-t", ts.name,
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
}

// Close stops the poller.
func (ts *TmuxSession) Close() {
	select {
	case <-ts.stopPoller:
	default:
		close(ts.stopPoller)
	}
}

// pollLoop runs in background goroutine at 100ms intervals.
// Updates screen cache, scrollback metadata, and detects pane_dead.
func (ts *TmuxSession) pollLoop() {
	ticker := time.NewTicker(tmuxPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ts.stopPoller:
			return
		case <-ticker.C:
			ts.poll()
		}
	}
}

func (ts *TmuxSession) poll() {
	histSize, paneHeight, dead, deadStatus, _, err := ts.paneInfo()
	if err != nil {
		ts.mu.Lock()
		if !ts.exited {
			ts.exited = true
			close(ts.done)
		}
		ts.mu.Unlock()
		return
	}

	ts.mu.Lock()
	ts.histSize = histSize
	ts.paneHeight = paneHeight
	ts.mu.Unlock()

	if dead {
		ts.mu.Lock()
		ts.paneDead = true
		ts.deadStatus = deadStatus
		ts.mu.Unlock()
		ts.onExit()
		return
	}

	// Capture visible screen
	screen, err := ts.capturePaneVisible()
	if err == nil {
		ts.mu.Lock()
		ts.screen = screen
		ts.mu.Unlock()
	}
}

// onExit is called when pane_dead is detected.
// Dumps tmux scrollback to SegmentedLog for persistence, then kills session.
func (ts *TmuxSession) onExit() {
	// Capture full scrollback + visible screen from tmux before killing
	fullOutput, err := ts.capturePaneAll()
	if err == nil && fullOutput != "" {
		lines := strings.Split(fullOutput, "\n")
		for _, line := range lines {
			if line != "" {
				ts.seglog.Write([]byte(line + "\n"))
			}
		}
		ts.seglog.Flush()
	}

	// Kill the tmux session to clean up
	tmuxCmd("-L", tmuxSocket, "kill-session", "-t", ts.name)

	ts.mu.Lock()
	if !ts.exited {
		ts.exited = true
		close(ts.done)
	}
	ts.mu.Unlock()
}

// capturePaneVisible captures the current visible pane with ANSI escape codes.
func (ts *TmuxSession) capturePaneVisible() (string, error) {
	out, err := exec.Command("tmux",
		"-L", tmuxSocket,
		"capture-pane", "-t", ts.name,
		"-p", "-e",
	).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// capturePaneRange captures a range of lines from tmux scrollback.
// startLine and endLine use tmux-relative coordinates:
//   negative = scrollback, 0 = first visible line.
func (ts *TmuxSession) capturePaneRange(startLine, endLine int) (string, error) {
	out, err := exec.Command("tmux",
		"-L", tmuxSocket,
		"capture-pane", "-t", ts.name,
		"-p", "-e",
		"-S", strconv.Itoa(startLine),
		"-E", strconv.Itoa(endLine),
	).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// capturePaneAll captures the entire scrollback + visible screen.
func (ts *TmuxSession) capturePaneAll() (string, error) {
	out, err := exec.Command("tmux",
		"-L", tmuxSocket,
		"capture-pane", "-t", ts.name,
		"-p", "-e",
		"-S", "-",
	).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// paneInfo queries tmux for pane metadata.
func (ts *TmuxSession) paneInfo() (histSize, paneHeight int, dead bool, deadStatus int, altOn bool, err error) {
	return paneInfoByName(ts.name)
}

// paneInfoByName queries tmux for pane metadata by session name.
func paneInfoByName(sessName string) (histSize, paneHeight int, dead bool, deadStatus int, altOn bool, err error) {
	out, err := exec.Command("tmux",
		"-L", tmuxSocket,
		"display-message", "-t", sessName,
		"-p", "#{history_size}:#{pane_height}:#{pane_dead}:#{pane_dead_status}:#{alternate_on}",
	).Output()
	if err != nil {
		return 0, 0, false, 0, false, err
	}

	parts := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(parts) != 5 {
		return 0, 0, false, 0, false, fmt.Errorf("unexpected display-message output: %q", string(out))
	}

	histSize, _ = strconv.Atoi(parts[0])
	paneHeight, _ = strconv.Atoi(parts[1])
	dead = parts[2] == "1"
	deadStatus, _ = strconv.Atoi(parts[3])
	altOn = parts[4] == "1"
	return
}

// tmuxSessionExists checks if a tmux session exists on the maomao socket.
func tmuxSessionExists(sessName string) bool {
	err := exec.Command("tmux",
		"-L", tmuxSocket,
		"has-session", "-t", sessName,
	).Run()
	return err == nil
}

// tmuxCmd runs a tmux command, ignoring output and errors.
func tmuxCmd(args ...string) {
	exec.Command("tmux", args...).Run()
}

// shellQuote wraps a string in single quotes for safe shell use.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
