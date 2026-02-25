package process

import (
	"fmt"
	"io"
	"os"
	"time"
)

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

// readPTY reads from PTY master and writes to logFile + VTerm via ScrollCapture.
// logFile gets raw output for disk persistence.
// ScrollCapture feeds data to VTerm in sub-chunks and captures scrolled-off
// lines as rendered text to the SegmentedLog history.
func readPTY(ptyFile *os.File, logFile *os.File, vterm *VTermScreen, sc *ScrollCapture, stop <-chan struct{}) {
	buf := make([]byte, 4096)
	for {
		n, err := ptyFile.Read(buf)
		if n > 0 {
			data := buf[:n]
			logFile.Write(data)
			sc.ProcessChunk(vterm, data)
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
