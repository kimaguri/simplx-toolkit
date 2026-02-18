package process

import (
	"bufio"
	"os"
	"os/exec"
	"regexp"
	"syscall"
	"time"
)

// TunnelStatus represents the current state of a Cloudflare tunnel
type TunnelStatus int

const (
	TunnelOff TunnelStatus = iota
	TunnelStarting
	TunnelActive
	TunnelError
)

// String returns a human-readable label for the tunnel status
func (s TunnelStatus) String() string {
	switch s {
	case TunnelOff:
		return "off"
	case TunnelStarting:
		return "starting"
	case TunnelActive:
		return "active"
	case TunnelError:
		return "error"
	default:
		return "unknown"
	}
}

// TunnelInfo holds runtime information about a Cloudflare Quick Tunnel
type TunnelInfo struct {
	Status TunnelStatus
	URL    string
	Cmd    *exec.Cmd
	Err    error
	URLCh  chan string   // URL sent here when parsed from stderr
	Done   chan struct{} // closed when cloudflared exits
}

var tunnelURLPattern = regexp.MustCompile(`(https://[a-z0-9-]+\.trycloudflare\.com)`)

// CloudflaredAvailable checks if cloudflared binary is in PATH
func CloudflaredAvailable() bool {
	_, err := exec.LookPath("cloudflared")
	return err == nil
}

// StartTunnel launches a cloudflared quick tunnel for the given port.
// Returns a TunnelInfo with channels for URL and completion.
func StartTunnel(port int) (*TunnelInfo, error) {
	localhost := "http://localhost:" + itoa(port)
	cmd := exec.Command("cloudflared", "tunnel",
		"--url", localhost,
		"--http-host-header", "localhost:"+itoa(port))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	info := &TunnelInfo{
		Status: TunnelStarting,
		Cmd:    cmd,
		URLCh:  make(chan string, 1),
		Done:   make(chan struct{}),
	}

	// Parse stderr for the tunnel URL
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if m := tunnelURLPattern.FindString(line); m != "" {
				info.URLCh <- m
				break
			}
		}
		// Drain remaining stderr
		for scanner.Scan() {
		}
	}()

	// Wait for process exit
	go func() {
		_ = cmd.Wait()
		close(info.Done)
	}()

	return info, nil
}

// StopTunnel gracefully stops a running cloudflared tunnel.
// Sends SIGTERM, waits 3s, then SIGKILL if still alive.
func StopTunnel(t *TunnelInfo) {
	if t == nil || t.Cmd == nil || t.Cmd.Process == nil {
		return
	}

	pgid, err := syscall.Getpgid(t.Cmd.Process.Pid)
	if err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
	} else {
		_ = t.Cmd.Process.Signal(os.Kill)
	}

	select {
	case <-t.Done:
		return
	case <-time.After(3 * time.Second):
	}

	if pgid, err := syscall.Getpgid(t.Cmd.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		_ = t.Cmd.Process.Kill()
	}
	<-t.Done
}

// itoa converts int to string without importing strconv
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}
