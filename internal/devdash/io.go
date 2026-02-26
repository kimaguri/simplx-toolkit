package devdash

import (
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// sanitizingWriter wraps an io.Writer and sanitizes raw PTY data before writing.
type sanitizingWriter struct {
	w io.Writer
}

// Write sanitizes raw PTY output via process.SanitizeForLog, then writes.
func (sw sanitizingWriter) Write(p []byte) (int, error) {
	_, err := sw.w.Write(process.SanitizeForLog(p))
	return len(p), err
}

// tailFile reads from a log file starting at offset and writes new content to w.
// Polls the file for new data until stop is closed.
// Data is sanitized through process.SanitizeForLog before writing.
func tailFile(path string, w io.Writer, startOffset int64, stop <-chan struct{}) {
	sw := sanitizingWriter{w: w}

	f, err := waitForFile(path, stop)
	if f == nil || err != nil {
		return
	}
	defer f.Close()

	if startOffset > 0 {
		f.Seek(startOffset, io.SeekStart)
	}

	buf := make([]byte, 4096)
	for {
		select {
		case <-stop:
			drainFile(f, buf, sw)
			return
		default:
		}

		n, readErr := f.Read(buf)
		if n > 0 {
			sw.Write(buf[:n])
		}
		if readErr == io.EOF || n == 0 {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if readErr != nil {
			return
		}
	}
}

// waitForFile tries to open the file, retrying up to 50 times (5s total).
func waitForFile(path string, stop <-chan struct{}) (*os.File, error) {
	f, err := os.Open(path)
	if err == nil {
		return f, nil
	}

	for i := 0; i < 50; i++ {
		select {
		case <-stop:
			return nil, nil
		case <-time.After(100 * time.Millisecond):
		}
		f, err = os.Open(path)
		if err == nil {
			return f, nil
		}
	}
	return nil, err
}

// drainFile reads remaining data from f and writes it through sw.
func drainFile(f *os.File, buf []byte, sw sanitizingWriter) {
	for {
		n, _ := f.Read(buf)
		if n > 0 {
			sw.Write(buf[:n])
		}
		if n == 0 {
			break
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
