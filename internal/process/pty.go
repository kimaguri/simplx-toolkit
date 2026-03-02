package process

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

const (
	defaultPTYRows uint16 = 24
	defaultPTYCols uint16 = 80

	// DefaultPTYRows is the exported default for external packages (devdash)
	DefaultPTYRows = defaultPTYRows
	// DefaultPTYCols is the exported default for external packages (devdash)
	DefaultPTYCols = defaultPTYCols
)

// startWithPTY starts a process with a pseudo-terminal.
// Returns the PTY master fd for reading output and writing input.
//
// Uses Setpgid (not Setsid) so the PTY is NOT the controlling terminal.
// This means closing the master fd does NOT send SIGHUP to the child —
// processes survive TUI restarts and can be reconnected via log tailing.
// The child still sees a real TTY (isatty=true) so colors and interactive
// prompts work normally.
func startWithPTY(cmd *exec.Cmd, rows, cols uint16) (*os.File, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, err
	}

	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: cols}); err != nil {
		ptmx.Close()
		tty.Close()
		return nil, err
	}

	cmd.Stdin = tty
	cmd.Stdout = tty
	cmd.Stderr = tty

	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}

	if err := cmd.Start(); err != nil {
		ptmx.Close()
		tty.Close()
		return nil, err
	}

	// Close slave side in parent — child inherited it
	tty.Close()

	return ptmx, nil
}

// StartDaemon starts a process whose stdout/stderr go to logFile directly.
// The child fully survives parent exit:
//   - stdout/stderr → file (no EIO when parent exits)
//   - stdin → pipe (child gets EOF, not EIO, when parent exits)
//
// Returns the pipe write end for interactive input (WriteInput).
// The caller should set FORCE_COLOR=3 in cmd.Env for colored output.
func StartDaemon(cmd *exec.Cmd, logFile *os.File) (*os.File, error) {
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}

	cmd.Stdin = stdinR   // Pipe — child gets EOF when parent exits (harmless)
	cmd.Stdout = logFile // File — survives parent exit
	cmd.Stderr = logFile

	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}

	if err := cmd.Start(); err != nil {
		stdinR.Close()
		stdinW.Close()
		return nil, err
	}

	stdinR.Close() // Child inherited its own copy
	return stdinW, nil
}

// resizePTY changes the terminal window size.
func resizePTY(ptyFile *os.File, rows, cols uint16) error {
	return pty.Setsize(ptyFile, &pty.Winsize{Rows: rows, Cols: cols})
}
