package process

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func skipIfNoTmux(t *testing.T) {
	t.Helper()
	if !IsTmuxAvailable() {
		t.Skip("tmux not available")
	}
}

func newTestSegLog(t *testing.T) *SegmentedLog {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "scrollback")
	os.MkdirAll(dir, 0o755)
	return NewSegmentedLog(dir, DefaultMaxLines)
}

func newTestLogPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "pipe-pane.log")
}

func TestTmuxSession_StartAndCapture(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Use sleep to keep the command alive long enough for poller to capture
	ts, err := StartTmuxSession("test-start", 24, 80, "sh", []string{"-c", "echo 'hello world'; sleep 2"},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	// Wait for the command to produce output and for poller to capture it
	time.Sleep(500 * time.Millisecond)

	screen := ts.Render()
	if !strings.Contains(screen, "hello world") {
		t.Errorf("expected screen to contain 'hello world', got:\n%s", screen)
	}

	// Wait for process exit
	select {
	case <-ts.Done():
		// expected
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process exit")
	}
}

func TestTmuxSession_Scrollback(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Generate 200 lines of output — should create scrollback in tmux
	cmd := "for i in $(seq 1 200); do echo \"line-$i\"; done; sleep 1"
	ts, err := StartTmuxSession("test-scroll", 24, 80, "sh", []string{"-c", cmd},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	// Wait for output to complete
	time.Sleep(2 * time.Second)

	total := ts.Len()
	t.Logf("total lines (Len): %d", total)
	if total < 100 {
		t.Errorf("expected Len() >= 100, got %d", total)
	}

	// Read a range from the beginning — should be tmux scrollback
	if total > 10 {
		lines := ts.ReadRange(0, 10)
		t.Logf("ReadRange(0, 10): %v", lines)
		if len(lines) == 0 {
			t.Error("ReadRange returned no lines")
		}
	}

	// Wait for process exit
	select {
	case <-ts.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for process exit")
	}

	// After exit, scrollback should be persisted in SegmentedLog
	time.Sleep(500 * time.Millisecond)
	segLen := seglog.Len()
	t.Logf("seglog lines after exit: %d", segLen)
	if segLen == 0 {
		t.Error("expected seglog to have lines after process exit")
	}
}

func TestTmuxSession_Input(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Start cat which echoes input
	ts, err := StartTmuxSession("test-input", 24, 80, "cat", nil,
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer func() {
		ts.Kill()
		ts.Close()
	}()

	time.Sleep(300 * time.Millisecond)

	// Send input
	_, err = ts.Write([]byte("hello from test\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Wait for output to appear
	time.Sleep(500 * time.Millisecond)

	screen := ts.Render()
	if !strings.Contains(screen, "hello from test") {
		t.Errorf("expected screen to contain 'hello from test', got:\n%s", screen)
	}
}

func TestTmuxSession_ProcessExit(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	ts, err := StartTmuxSession("test-exit", 24, 80, "sh", []string{"-c", "echo done; exit 0"},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	select {
	case <-ts.Done():
		// expected
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process exit")
	}

	// After exit, seglog should have the output (dumped from tmux scrollback)
	time.Sleep(500 * time.Millisecond)
	if seglog.Len() == 0 {
		t.Error("expected seglog to have lines after process exit")
	}

	// Verify exit code
	if ts.ExitCode() != 0 {
		t.Errorf("expected exit code 0, got %d", ts.ExitCode())
	}
}

func TestTmuxSession_Render(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Use printf with ANSI codes + sleep to keep alive for capture
	cmd := `printf '\033[31mred text\033[0m\n'; sleep 2`
	ts, err := StartTmuxSession("test-render", 24, 80, "sh", []string{"-c", cmd},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	time.Sleep(500 * time.Millisecond)

	screen := ts.Render()
	// The screen should contain the text (may or may not have ANSI depending on -e flag)
	if !strings.Contains(screen, "red text") {
		t.Errorf("expected screen to contain 'red text', got:\n%s", screen)
	}

	select {
	case <-ts.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("timed out")
	}
}

func TestTmuxSession_Resize(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	ts, err := StartTmuxSession("test-resize", 24, 80, "cat", nil,
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer func() {
		ts.Kill()
		ts.Close()
	}()

	time.Sleep(300 * time.Millisecond)

	// Resize
	ts.Resize(40, 120)
	time.Sleep(300 * time.Millisecond)

	// Verify the pane dimensions updated
	_, paneHeight, _, _, _, err := ts.paneInfo()
	if err != nil {
		t.Fatalf("paneInfo: %v", err)
	}
	if paneHeight != 40 {
		t.Errorf("expected pane height 40, got %d", paneHeight)
	}
}

func TestTmuxSession_Kill(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Start a long-running process
	ts, err := StartTmuxSession("test-kill", 24, 80, "sleep", []string{"3600"},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	time.Sleep(300 * time.Millisecond)

	// Kill should terminate the session
	ts.Kill()

	select {
	case <-ts.Done():
		// expected
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for kill to complete")
	}

	// Session should be gone
	if tmuxSessionExists(ts.name) {
		t.Error("expected tmux session to be gone after Kill")
	}
}

func TestTmuxSession_ReadRangeLive(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)
	// Output enough lines to create scrollback
	cmd := "for i in $(seq 1 50); do echo \"testline-$i\"; done; sleep 2"
	ts, err := StartTmuxSession("test-readrange", 24, 80, "sh", []string{"-c", cmd},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	// Wait for output to complete
	time.Sleep(1500 * time.Millisecond)

	total := ts.Len()
	t.Logf("total Len(): %d", total)
	if total == 0 {
		t.Skip("no scrollback available yet")
	}

	// Read a range from the beginning
	start := 0
	end := min(10, total)
	lines := ts.ReadRange(start, end)
	t.Logf("ReadRange(%d, %d): got %d lines", start, end, len(lines))
	if len(lines) == 0 {
		t.Errorf("ReadRange(%d, %d) returned no lines (total=%d)", start, end, total)
	}

	select {
	case <-ts.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestTmuxSession_AltScreenSkipsScrollback(t *testing.T) {
	skipIfNoTmux(t)

	seglog := newTestSegLog(t)
	logPath := newTestLogPath(t)

	// Script: output normal lines, enter alt screen, do redraws, exit alt screen, output more.
	// tmux natively handles alt screen — redraws should NOT appear in scrollback.
	cmd := `echo before-alt-1; echo before-alt-2; echo before-alt-3; sleep 0.3; printf '\033[?1049h'; printf '\033[H\033[2JXYZZY-ALT-1\n'; sleep 0.1; printf '\033[H\033[2JXYZZY-ALT-2\n'; sleep 0.1; printf '\033[H\033[2JXYZZY-ALT-3\n'; sleep 0.1; printf '\033[?1049l'; sleep 0.1; echo after-alt-1; echo after-alt-2; sleep 0.5`
	ts, err := StartTmuxSession("test-altscreen", 24, 80, "sh", []string{"-c", cmd},
		"", nil, logPath, seglog)
	if err != nil {
		t.Fatalf("StartTmuxSession: %v", err)
	}
	defer ts.Close()

	select {
	case <-ts.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for process exit")
	}

	// After exit, scrollback is in SegmentedLog
	time.Sleep(500 * time.Millisecond)

	total := ts.Len()
	t.Logf("total scrollback lines: %d", total)

	if total > 0 {
		lines := ts.ReadRange(0, total)
		for i, line := range lines {
			t.Logf("  scrollback[%d]: %q", i, line)
		}

		// Verify alt screen rendered content ("XYZZY-ALT-N") is NOT in scrollback.
		// Note: the command text itself may contain "XYZZY-ALT" as a literal string
		// echoed by the shell prompt, so we check specifically for lines that are
		// just the rendered output (without escape code prefixes).
		for _, line := range lines {
			stripped := strings.TrimSpace(line)
			if stripped == "XYZZY-ALT-1" || stripped == "XYZZY-ALT-2" || stripped == "XYZZY-ALT-3" {
				t.Errorf("alt screen rendered content leaked into scrollback: %q", line)
			}
		}
	}
}

func TestIsTmuxAvailable(t *testing.T) {
	// This test always runs — it just checks the function doesn't panic
	result := IsTmuxAvailable()
	t.Logf("IsTmuxAvailable: %v", result)
}
