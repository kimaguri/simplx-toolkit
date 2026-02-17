package process

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

const (
	defaultPTYRows uint16 = 24
	defaultPTYCols uint16 = 80
)

// startWithPTY starts a process with a pseudo-terminal.
// Returns the PTY master fd that can be used for reading output and writing input.
// creack/pty sets Setsid=true internally, which creates a new session and process group.
// This means syscall.Getpgid(pid) still works for group signaling in Stop().
func startWithPTY(cmd *exec.Cmd, rows, cols uint16) (*os.File, error) {
	return pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
}

// resizePTY changes the terminal window size.
func resizePTY(ptyFile *os.File, rows, cols uint16) error {
	return pty.Setsize(ptyFile, &pty.Winsize{Rows: rows, Cols: cols})
}
