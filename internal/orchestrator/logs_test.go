package orchestrator

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
)

// writeLinesLog writes n lines to path, formatted "line %d", with ANSI color
// codes wrapped around every 5th line so SanitizeForLog stripping can be
// asserted on the output.
func writeLinesLog(t *testing.T, path string, n int) {
	t.Helper()
	var b strings.Builder
	for i := 1; i <= n; i++ {
		if i%5 == 0 {
			b.WriteString(fmt.Sprintf("\x1b[31mline %d\x1b[0m\n", i))
		} else {
			b.WriteString(fmt.Sprintf("line %d\n", i))
		}
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write log fixture: %v", err)
	}
}

// setupLogsFixture creates a temp HOME, a local-service log file with n
// lines, and writes an instance registry entry with one local service
// ("web", log at logPath) and one remote service ("api", no local log).
func setupLogsFixture(t *testing.T, n int) (slug, logPath string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())

	logsDir := config.LogsDir()
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}

	slug = "myinst"
	logPath = filepath.Join(logsDir, "dev-myinst-web.log")
	writeLinesLog(t, logPath, n)

	inst := Instance{
		Project:      "proj",
		Branch:       "myinst",
		Slug:         slug,
		DomainSuffix: "simplx.localhost",
		Services: []ServiceState{
			{
				Service: "web",
				Mode:    "local",
				Status:  "running",
				LogPath: logPath,
			},
			{
				Service:  "api",
				Mode:     "remote",
				Status:   "remote",
				Upstream: "https://api-test.example.com",
				LogPath:  "",
			},
		},
	}
	if err := WriteInstance(inst); err != nil {
		t.Fatalf("WriteInstance: %v", err)
	}
	return slug, logPath
}

func TestLogs_DefaultTail50Lines(t *testing.T) {
	slug, _ := setupLogsFixture(t, 120)

	var buf bytes.Buffer
	if err := Logs(&buf, slug, "web", LogOptions{}); err != nil {
		t.Fatalf("Logs: %v", err)
	}

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 50 {
		t.Fatalf("expected 50 lines, got %d", len(lines))
	}
	if lines[0] != "line 71" {
		t.Errorf("expected first tail line to be 'line 71', got %q", lines[0])
	}
	if lines[len(lines)-1] != "line 120" {
		t.Errorf("expected last tail line to be 'line 120', got %q", lines[len(lines)-1])
	}
}

func TestLogs_TailCountOverride(t *testing.T) {
	slug, _ := setupLogsFixture(t, 120)

	var buf bytes.Buffer
	if err := Logs(&buf, slug, "web", LogOptions{Tail: 10}); err != nil {
		t.Fatalf("Logs: %v", err)
	}

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 10 {
		t.Fatalf("expected 10 lines, got %d", len(lines))
	}
	if lines[0] != "line 111" {
		t.Errorf("expected first tail line to be 'line 111', got %q", lines[0])
	}
}

func TestLogs_ANSIStripped(t *testing.T) {
	slug, _ := setupLogsFixture(t, 60)

	var buf bytes.Buffer
	if err := Logs(&buf, slug, "web", LogOptions{}); err != nil {
		t.Fatalf("Logs: %v", err)
	}

	if bytes.ContainsRune(buf.Bytes(), 0x1b) {
		t.Fatalf("output contains ANSI escape byte 0x1b: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "line 60") {
		t.Errorf("expected sanitized 'line 60' present, got %q", buf.String())
	}
}

func TestLogs_AllServicesMergeWithPrefix(t *testing.T) {
	slug, _ := setupLogsFixture(t, 60)

	var buf bytes.Buffer
	if err := Logs(&buf, slug, "", LogOptions{Tail: 5}); err != nil {
		t.Fatalf("Logs: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "[web] line 60") {
		t.Errorf("expected '[web] line 60' prefix in merged output, got %q", out)
	}
	if !strings.Contains(out, "[api] (remote — no local log)") {
		t.Errorf("expected remote note for api service in merged output, got %q", out)
	}
}

func TestLogs_RemoteServiceAlone(t *testing.T) {
	slug, _ := setupLogsFixture(t, 60)

	var buf bytes.Buffer
	err := Logs(&buf, slug, "api", LogOptions{})
	if err != nil {
		t.Fatalf("expected nil error for remote service, got %v", err)
	}
	if !strings.Contains(buf.String(), "remote (no local log)") {
		t.Errorf("expected remote-no-local-log message, got %q", buf.String())
	}
}

func TestLogs_UnknownInstance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	var buf bytes.Buffer
	err := Logs(&buf, "does-not-exist", "", LogOptions{})
	if err == nil {
		t.Fatal("expected error for unknown instance, got nil")
	}
}

func TestLogs_FollowSelfTerminates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	logsDir := config.LogsDir()
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir logs dir: %v", err)
	}
	logPath := filepath.Join(logsDir, "dev-followinst-web.log")
	writeLinesLog(t, logPath, 5)

	inst := Instance{
		Project:      "proj",
		Branch:       "followinst",
		Slug:         "followinst",
		DomainSuffix: "simplx.localhost",
		Services: []ServiceState{
			{Service: "web", Mode: "local", Status: "running", LogPath: logPath},
		},
	}
	if err := WriteInstance(inst); err != nil {
		t.Fatalf("WriteInstance: %v", err)
	}

	var buf bytes.Buffer
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		done <- Logs(&buf, "followinst", "web", LogOptions{Follow: true, Timeout: 300 * time.Millisecond})
	}()

	// Append a new line shortly after Logs starts following.
	time.Sleep(50 * time.Millisecond)
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open log for append: %v", err)
	}
	if _, err := f.WriteString("appended line\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	f.Close()

	select {
	case err := <-done:
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("Logs (follow) returned error: %v", err)
		}
		if elapsed > 2*time.Second {
			t.Fatalf("Logs (follow) took too long to self-terminate: %v", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Logs (follow) did not self-terminate within 2s")
	}

	if !strings.Contains(buf.String(), "appended line") {
		t.Errorf("expected appended line to be captured, got %q", buf.String())
	}
}
