package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateFromLegacy_MovesConfigSessionsAndLogs(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	legacyDir := filepath.Join(tmp, ".config", "local-dev")
	newDir := filepath.Join(tmp, ".config", "devdash")

	// Set up fake legacy config dir with config.json, sessions/foo.json, logs/bar.log.
	if err := os.MkdirAll(filepath.Join(legacyDir, "sessions"), 0o755); err != nil {
		t.Fatalf("setup sessions dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(legacyDir, "logs"), 0o755); err != nil {
		t.Fatalf("setup logs dir: %v", err)
	}

	configContent := `{"scan_dirs":["/tmp/foo"]}`
	if err := os.WriteFile(filepath.Join(legacyDir, "config.json"), []byte(configContent), 0o644); err != nil {
		t.Fatalf("write legacy config.json: %v", err)
	}

	sessionContent := `{"name":"foo","pid":123}`
	if err := os.WriteFile(filepath.Join(legacyDir, "sessions", "foo.json"), []byte(sessionContent), 0o644); err != nil {
		t.Fatalf("write legacy session file: %v", err)
	}

	logContent := "log line 1\nlog line 2\n"
	if err := os.WriteFile(filepath.Join(legacyDir, "logs", "bar.log"), []byte(logContent), 0o644); err != nil {
		t.Fatalf("write legacy log file: %v", err)
	}

	if err := MigrateFromLegacy(); err != nil {
		t.Fatalf("MigrateFromLegacy() returned error: %v", err)
	}

	// Assert new config.json exists with same content.
	gotConfig, err := os.ReadFile(filepath.Join(newDir, "config.json"))
	if err != nil {
		t.Fatalf("expected migrated config.json: %v", err)
	}
	if string(gotConfig) != configContent {
		t.Errorf("migrated config.json content = %q, want %q", gotConfig, configContent)
	}

	// Assert new sessions/foo.json exists with same content.
	gotSession, err := os.ReadFile(filepath.Join(newDir, "sessions", "foo.json"))
	if err != nil {
		t.Fatalf("expected migrated sessions/foo.json: %v", err)
	}
	if string(gotSession) != sessionContent {
		t.Errorf("migrated sessions/foo.json content = %q, want %q", gotSession, sessionContent)
	}

	// Assert new logs/bar.log exists with same content.
	gotLog, err := os.ReadFile(filepath.Join(newDir, "logs", "bar.log"))
	if err != nil {
		t.Fatalf("expected migrated logs/bar.log: %v", err)
	}
	if string(gotLog) != logContent {
		t.Errorf("migrated logs/bar.log content = %q, want %q", gotLog, logContent)
	}

	// Legacy dir's migrated entries should be gone (moved, not copied).
	if _, err := os.Stat(filepath.Join(legacyDir, "config.json")); !os.IsNotExist(err) {
		t.Errorf("expected legacy config.json to be moved away, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(legacyDir, "sessions", "foo.json")); !os.IsNotExist(err) {
		t.Errorf("expected legacy sessions/foo.json to be moved away, stat err = %v", err)
	}

	// Idempotent: second call is a no-op, no error, files still present and unchanged.
	if err := MigrateFromLegacy(); err != nil {
		t.Fatalf("second MigrateFromLegacy() call returned error: %v", err)
	}

	gotSessionAgain, err := os.ReadFile(filepath.Join(newDir, "sessions", "foo.json"))
	if err != nil {
		t.Fatalf("expected sessions/foo.json to still exist after idempotent call: %v", err)
	}
	if string(gotSessionAgain) != sessionContent {
		t.Errorf("sessions/foo.json content changed after idempotent call: got %q, want %q", gotSessionAgain, sessionContent)
	}
}

func TestMigrateFromLegacy_NoLegacyDir_NoOp(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	if err := MigrateFromLegacy(); err != nil {
		t.Fatalf("MigrateFromLegacy() returned error when legacy dir absent: %v", err)
	}

	newDir := filepath.Join(tmp, ".config", "devdash")
	if _, err := os.Stat(newDir); !os.IsNotExist(err) {
		t.Errorf("expected no new dir to be created when legacy dir absent, stat err = %v", err)
	}
}

func TestMigrateFromLegacy_NewDirAlreadyExists_NoOp(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	legacyDir := filepath.Join(tmp, ".config", "local-dev")
	newDir := filepath.Join(tmp, ".config", "devdash")

	if err := os.MkdirAll(filepath.Join(legacyDir, "sessions"), 0o755); err != nil {
		t.Fatalf("setup legacy sessions dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "sessions", "foo.json"), []byte("legacy"), 0o644); err != nil {
		t.Fatalf("write legacy session file: %v", err)
	}

	if err := os.MkdirAll(newDir, 0o755); err != nil {
		t.Fatalf("setup new dir: %v", err)
	}

	if err := MigrateFromLegacy(); err != nil {
		t.Fatalf("MigrateFromLegacy() returned error: %v", err)
	}

	// Legacy file should remain untouched since new dir already existed.
	if _, err := os.Stat(filepath.Join(legacyDir, "sessions", "foo.json")); err != nil {
		t.Errorf("expected legacy session file to remain when new dir pre-existed: %v", err)
	}
	// New dir should not have received the migrated session file.
	if _, err := os.Stat(filepath.Join(newDir, "sessions", "foo.json")); !os.IsNotExist(err) {
		t.Errorf("expected new dir to not receive migration when it already existed, stat err = %v", err)
	}
}
