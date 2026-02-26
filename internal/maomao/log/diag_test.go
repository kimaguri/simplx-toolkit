package log

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiagInit(t *testing.T) {
	dir := t.TempDir()
	if err := InitDiag(dir); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "logs", "diag.log")
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("diag.log not created: %v", err)
	}
}

func TestDiagLogComponents(t *testing.T) {
	dir := t.TempDir()
	if err := InitDiag(dir); err != nil {
		t.Fatal(err)
	}
	// Should not panic
	ptyLog := Diag.Component("pty")
	ptyLog.Info().Str("action", "write").Msg("test")
	tuiLog := Diag.Component("tui")
	tuiLog.Warn().Str("pane", "test").Msg("test warning")
}
