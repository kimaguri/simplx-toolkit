package devdash

import (
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// interactiveSanitizer processes raw terminal output and writes clean content to LogBuffer.
// It intercepts cursor-up (ESC[nA) and carriage return (\r) at the stream level,
// calling LogBuffer methods directly to remove/replace lines across chunk boundaries.
// All other content is passed through process.SanitizeForLog.
type interactiveSanitizer struct {
	buf *process.LogBuffer
}

// Write processes a chunk of raw terminal data.
func (s *interactiveSanitizer) Write(p []byte) (int, error) {
	i := 0
	segStart := 0

	for i < len(p) {
		// CSI sequence: ESC [
		if p[i] == 0x1b && i+1 < len(p) && p[i+1] == '[' {
			j := i + 2
			for j < len(p) && p[j] >= 0x20 && p[j] <= 0x3f {
				j++
			}
			for j < len(p) && p[j] >= 0x20 && p[j] <= 0x2f {
				j++
			}
			if j < len(p) && p[j] >= 0x40 && p[j] <= 0x7e {
				finalByte := p[j]

				if finalByte == 'A' {
					// CUU (Cursor Up) — flush pending segment, then remove lines from buffer
					if i > segStart {
						s.buf.Write(process.SanitizeForLog(p[segStart:i]))
					}
					n := process.ParseCSIParam(p[i+2 : j])
					if n <= 0 {
						n = 1
					}
					s.buf.RemoveLastLines(n)
					i = j + 1
					segStart = i
					continue
				}

				if finalByte == 'J' {
					// ED (Erase in Display) — flush pending, clear partial
					if i > segStart {
						s.buf.Write(process.SanitizeForLog(p[segStart:i]))
					}
					s.buf.ClearPartial()
					i = j + 1
					segStart = i
					continue
				}
			}
			// Other CSI: leave in segment for sanitizeForLog to handle
			if j < len(p) {
				i = j + 1
			} else {
				i = j
			}
			continue
		}

		// Standalone \r (not \r\n) — flush pending, clear partial
		if p[i] == '\r' && (i+1 >= len(p) || p[i+1] != '\n') {
			if i > segStart {
				s.buf.Write(process.SanitizeForLog(p[segStart:i]))
			}
			s.buf.ClearPartial()
			i++
			segStart = i
			continue
		}

		i++
	}

	// Flush remaining segment
	if segStart < len(p) {
		s.buf.Write(process.SanitizeForLog(p[segStart:]))
	}

	return len(p), nil
}

// tailFile reads from a log file starting at offset and writes new content to buf.
// Polls the file for new data until stop is closed.
// Uses interactiveSanitizer for cross-chunk cursor-up and carriage return handling.
func tailFile(path string, buf *process.LogBuffer, startOffset int64, stop <-chan struct{}) {
	sw := &interactiveSanitizer{buf: buf}

	f, err := waitForFile(path, stop)
	if f == nil || err != nil {
		return
	}
	defer f.Close()

	if startOffset > 0 {
		f.Seek(startOffset, io.SeekStart)
	}

	readBuf := make([]byte, 4096)
	for {
		select {
		case <-stop:
			drainFile(f, readBuf, sw)
			return
		default:
		}

		n, readErr := f.Read(readBuf)
		if n > 0 {
			sw.Write(readBuf[:n])
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
func drainFile(f *os.File, buf []byte, sw *interactiveSanitizer) {
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
