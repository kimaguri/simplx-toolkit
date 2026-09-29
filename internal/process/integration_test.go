package process

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// TestIntegration_ReadPTY_Scrollback exercises the full pipeline:
// real PTY → readPTY → logFile + VTerm + ScrollCapture → SegmentedLog.
// Verifies that scrollback captures lines with spaces preserved,
// VTerm displays content correctly, and bulk output doesn't lose lines.
func TestIntegration_ReadPTY_Scrollback(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	vterm := NewVTermScreen(24, 80)
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sc := NewScrollCapture(24, sl)
	stop := make(chan struct{})

	// Start a real process with PTY that outputs many lines
	cmd := exec.Command("bash", "-c", `for i in $(seq 1 50); do echo "line $i: the quick brown fox jumps over the lazy dog"; done`)
	ptyFile, err := startWithPTY(cmd, 24, 80)
	if err != nil {
		t.Fatal(err)
	}

	// Run readPTY in goroutine (same as production code)
	done := make(chan struct{})
	go func() {
		readPTY(ptyFile, logFile, vterm, sc, stop)
		close(done)
	}()

	// Wait for process to finish
	cmd.Wait()
	time.Sleep(300 * time.Millisecond) // let PTY reader catch up
	close(stop)
	<-done
	ptyFile.Close()

	// Flush final VTerm screen to scrollback
	sc.Flush(vterm)

	// Check scrollback
	sbLen := sl.Len()
	t.Logf("scrollback length: %d", sbLen)

	if sbLen == 0 {
		t.Fatal("scrollback is empty — scroll capture didn't detect any output")
	}

	lines := sl.ReadRange(0, sbLen)
	spaceless := 0
	foxCount := 0
	for i, line := range lines {
		plain := ansi.Strip(line)
		if strings.Contains(plain, "quick brown fox") {
			foxCount++
		}
		if !strings.Contains(plain, " ") && len(strings.TrimSpace(plain)) > 10 {
			spaceless++
			if spaceless <= 3 {
				t.Logf("NO SPACES in scrollback[%d]: %q", i, plain)
			}
		}
	}

	t.Logf("lines with 'quick brown fox': %d out of %d total", foxCount, sbLen)

	if spaceless > 0 {
		t.Errorf("%d scrollback lines have no spaces", spaceless)
	}
	if foxCount < 30 {
		t.Errorf("expected at least 30 lines with fox, got %d (some lines lost)", foxCount)
	}

	// Check VTerm has content
	vtContent := vterm.Content()
	if vtContent == "" {
		t.Error("VTerm content is empty")
	}
	vtPlain := ansi.Strip(vtContent)
	if !strings.Contains(vtPlain, "quick brown fox") {
		t.Errorf("VTerm missing expected content: %q", vtPlain[:min(200, len(vtPlain))])
	}

	// Check log file has raw output
	logFile.Close()
	raw, _ := os.ReadFile(logPath)
	if len(raw) == 0 {
		t.Error("log file is empty")
	}
	t.Logf("log file size: %d bytes", len(raw))
}

// TestIntegration_ReadPTY_ANSIColors verifies that colored output preserves
// colors in scrollback while stripping cursor movement.
func TestIntegration_ReadPTY_ANSIColors(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	vterm := NewVTermScreen(24, 80)
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sc := NewScrollCapture(24, sl)
	stop := make(chan struct{})

	// Output colored text via a real PTY
	script := `printf '\033[1;32mGreen bold\033[0m normal \033[34mblue\033[0m text\n'
for i in $(seq 1 30); do
    printf '\033[33mline %d:\033[0m hello world with spaces\n' "$i"
done`

	cmd := exec.Command("bash", "-c", script)
	ptyFile, err := startWithPTY(cmd, 24, 80)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		readPTY(ptyFile, logFile, vterm, sc, stop)
		close(done)
	}()

	cmd.Wait()
	time.Sleep(300 * time.Millisecond)
	close(stop)
	<-done
	ptyFile.Close()

	// Flush final screen
	sc.Flush(vterm)

	sbLen := sl.Len()
	t.Logf("scrollback: %d lines", sbLen)

	if sbLen == 0 {
		t.Fatal("scrollback empty")
	}

	lines := sl.ReadRange(0, sbLen)
	hasColor := false
	for _, line := range lines {
		if strings.Contains(line, "\x1b[") {
			hasColor = true
			break
		}
	}
	if !hasColor {
		t.Error("scrollback has no ANSI color codes — VTerm rendered lines lost colors")
	}

	// Verify spaces preserved
	for i, line := range lines {
		plain := ansi.Strip(line)
		if strings.Contains(plain, "helloworld") {
			t.Errorf("scrollback[%d] concatenated words: %q", i, plain)
		}
	}
}

// TestIntegration_ReadPTY_BulkOutput simulates a process that dumps lots of
// output in rapid succession (like npm install or build output).
func TestIntegration_ReadPTY_BulkOutput(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()

	vterm := NewVTermScreen(24, 80)
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sc := NewScrollCapture(24, sl)
	stop := make(chan struct{})

	// Generate lots of output fast
	cmd := exec.Command("bash", "-c", fmt.Sprintf(
		`for i in $(seq 1 200); do echo "build step $i: compiling module with dependencies"; done`,
	))
	ptyFile, err := startWithPTY(cmd, 24, 80)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		readPTY(ptyFile, logFile, vterm, sc, stop)
		close(done)
	}()

	cmd.Wait()
	time.Sleep(300 * time.Millisecond)
	close(stop)
	<-done
	ptyFile.Close()

	// Flush final screen
	sc.Flush(vterm)

	sbLen := sl.Len()
	t.Logf("scrollback: %d lines (expected ~200)", sbLen)

	if sbLen < 100 {
		t.Errorf("expected at least 100 lines, got %d — lines lost", sbLen)
	}

	lines := sl.ReadRange(0, sbLen)
	spaceless := 0
	for i, line := range lines {
		plain := ansi.Strip(line)
		if !strings.Contains(plain, " ") && len(strings.TrimSpace(plain)) > 10 {
			spaceless++
			if spaceless <= 3 {
				t.Logf("NO SPACES: scrollback[%d] = %q", i, plain)
			}
		}
	}
	if spaceless > 0 {
		t.Errorf("%d out of %d lines missing spaces", spaceless, sbLen)
	}
}

// TestIntegration_ReadPTY_CapturesInstantCrashOutput exercises the
// PTY-fallback path (readPTY + startWithPTY) directly against a command that
// writes one line then exits immediately — the scenario spec.md User Story 2
// describes (e.g. platform crashing on a missing secret before any real
// startup output). LAB-294 claimed logs can end up 0 bytes for this case;
// this test locks in that readPTY's synchronous per-chunk write to logFile
// (it writes before checking the read error, and only returns on a non-nil
// error) already captures output even when EOF follows almost immediately —
// see research.md's Phase 4 note. If a future change to readPTY/waitForExit
// introduces a race that drops this output, this test should catch it.
func TestIntegration_ReadPTY_CapturesInstantCrashOutput(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "crash.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}

	vterm := NewVTermScreen(24, 80)
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sc := NewScrollCapture(24, sl)
	stop := make(chan struct{})

	cmd := exec.Command("sh", "-c", "echo 'fatal: secret ADMIN_DATABASE_URL is not set' >&2; exit 1")
	ptyFile, err := startWithPTY(cmd, 24, 80)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		readPTY(ptyFile, logFile, vterm, sc, stop)
		close(done)
	}()

	cmd.Wait()
	// Mirror waitForExit's real grace period exactly, rather than a longer
	// ad-hoc sleep, so this test reflects production timing.
	time.Sleep(200 * time.Millisecond)
	close(stop)
	<-done
	ptyFile.Close()
	logFile.Close()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("reading log file: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("log file is 0 bytes — instant-crash output was lost")
	}
	if !strings.Contains(string(data), "ADMIN_DATABASE_URL") {
		t.Errorf("expected log to contain the crash message, got: %q", string(data))
	}
}
