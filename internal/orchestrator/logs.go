package orchestrator

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// sgrEscapeRe matches the SGR (color/style) escape sequences that
// process.SanitizeForLog intentionally preserves for its scrollback-viewer
// use case. `devdash logs` output must be plain text, so these are stripped
// as an additional pass after SanitizeForLog.
var sgrEscapeRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

// stripANSI ANSI-sanitizes data via process.SanitizeForLog (control
// sequences, cursor movement, etc.) and then removes any remaining SGR
// color/style escapes, guaranteeing the result contains no ESC (0x1b) bytes.
func stripANSI(data []byte) []byte {
	clean := process.SanitizeForLog(data)
	return sgrEscapeRe.ReplaceAll(clean, nil)
}

// defaultTailLines is the number of trailing lines returned when
// LogOptions.Tail is unset (0), per contracts/cli.md.
const defaultTailLines = 50

// defaultFollowTimeout caps a bounded follow when LogOptions.Timeout is
// unset (0), per contracts/cli.md.
const defaultFollowTimeout = 60 * time.Second

// followPollInterval is how often a followed log file is polled for new
// bytes.
const followPollInterval = 50 * time.Millisecond

// LogOptions carries the parsed arguments of `devdash logs`.
type LogOptions struct {
	Tail    int
	Follow  bool
	Timeout time.Duration
}

// Logs writes the requested service's (or, if service is "", all services')
// log output to w. See contracts/cli.md `devdash logs` for full behavior:
// default tail of 50 lines, ANSI-stripped, optional --tail override, and a
// bounded --follow that self-terminates.
func Logs(w io.Writer, slug, service string, opts LogOptions) error {
	inst, err := ReadInstance(slug)
	if err != nil {
		return fmt.Errorf("instance %s not running", slug)
	}

	tail := opts.Tail
	if tail <= 0 {
		tail = defaultTailLines
	}

	targets, err := selectLogTargets(inst, service)
	if err != nil {
		return err
	}

	prefixed := service == ""

	for _, t := range targets {
		if t.remote {
			if prefixed {
				fmt.Fprintf(w, "[%s] (remote — no local log)\n", t.service)
			} else {
				fmt.Fprintf(w, "%s is remote (no local log)\n", t.service)
			}
			continue
		}

		if err := tailFile(w, t.service, t.logPath, tail, prefixed); err != nil {
			return err
		}
	}

	if opts.Follow {
		timeout := opts.Timeout
		if timeout <= 0 {
			timeout = defaultFollowTimeout
		}
		followTargets(w, targets, prefixed, timeout)
	}

	return nil
}

// logTarget is a resolved service to read logs for.
type logTarget struct {
	service string
	logPath string
	remote  bool
}

// selectLogTargets resolves which service(s) of inst to read logs for. If
// service is "" all of inst's services are targeted; otherwise only the
// named one. An unknown named service is an error.
func selectLogTargets(inst *Instance, service string) ([]logTarget, error) {
	if service == "" {
		targets := make([]logTarget, 0, len(inst.Services))
		for _, svc := range inst.Services {
			targets = append(targets, logTarget{
				service: svc.Service,
				logPath: svc.LogPath,
				remote:  svc.LogPath == "",
			})
		}
		return targets, nil
	}

	for _, svc := range inst.Services {
		if svc.Service == service {
			return []logTarget{{
				service: svc.Service,
				logPath: svc.LogPath,
				remote:  svc.LogPath == "",
			}}, nil
		}
	}

	return nil, fmt.Errorf("service %s not found in instance %s", service, inst.Slug)
}

// tailFile reads logPath, ANSI-strips it, and writes its last n lines to w,
// prefixing each line with "[service] " when prefixed is true.
func tailFile(w io.Writer, service, logPath string, n int, prefixed bool) error {
	data, err := os.ReadFile(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	lines := lastLines(stripANSI(data), n)
	writeLines(w, service, lines, prefixed)
	return nil
}

// lastLines splits data into newline-separated lines (dropping a single
// trailing empty line from a final "\n") and returns at most the last n.
func lastLines(data []byte, n int) []string {
	text := string(data)
	text = trimTrailingNewline(text)
	if text == "" {
		return nil
	}

	lines := splitLines(text)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func trimTrailingNewline(s string) string {
	if len(s) > 0 && s[len(s)-1] == '\n' {
		return s[:len(s)-1]
	}
	return s
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	lines = append(lines, s[start:])
	return lines
}

func writeLines(w io.Writer, service string, lines []string, prefixed bool) {
	for _, line := range lines {
		if prefixed {
			fmt.Fprintf(w, "[%s] %s\n", service, line)
		} else {
			fmt.Fprintln(w, line)
		}
	}
}

// followTargets streams newly appended bytes from each local target's log
// file, ANSI-stripped, until deadline elapses. It never blocks past
// deadline: the poll loop checks time.Now() against the deadline on every
// iteration.
func followTargets(w io.Writer, targets []logTarget, prefixed bool, timeout time.Duration) {
	offsets := make(map[string]int64, len(targets))
	for _, t := range targets {
		if t.remote {
			continue
		}
		if fi, err := os.Stat(t.logPath); err == nil {
			offsets[t.logPath] = fi.Size()
		} else {
			offsets[t.logPath] = 0
		}
	}

	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(followPollInterval)
	defer ticker.Stop()

	for {
		now := time.Now()
		if !now.Before(deadline) {
			return
		}

		for _, t := range targets {
			if t.remote {
				continue
			}
			readNewBytes(w, t, offsets)
		}

		remaining := time.Until(deadline)
		if remaining <= 0 {
			return
		}
		wait := followPollInterval
		if remaining < wait {
			wait = remaining
		}
		time.Sleep(wait)
	}
}

// readNewBytes reads any bytes appended to t.logPath since offsets[t.logPath]
// and writes the ANSI-stripped, line-split result to w.
func readNewBytes(w io.Writer, t logTarget, offsets map[string]int64) {
	f, err := os.Open(t.logPath)
	if err != nil {
		return
	}
	defer f.Close()

	off := offsets[t.logPath]
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return
	}

	reader := bufio.NewReader(f)
	buf, err := io.ReadAll(reader)
	if err != nil {
		return
	}
	if len(buf) == 0 {
		return
	}
	offsets[t.logPath] = off + int64(len(buf))

	clean := stripANSI(buf)
	clean = bytes.TrimRight(clean, "\n")
	if len(clean) == 0 {
		return
	}
	for _, line := range splitLines(string(clean)) {
		if t.service != "" {
			fmt.Fprintf(w, "[%s] %s\n", t.service, line)
		} else {
			fmt.Fprintln(w, line)
		}
	}
}
