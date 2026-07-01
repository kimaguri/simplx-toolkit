package process

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSessionInfo_InstanceServiceRoundTrip verifies that the optional
// Instance/Service fields (added for instance-grouping, FR-032) round-trip
// through SaveSession/LoadAllSessions when present.
func TestSessionInfo_InstanceServiceRoundTrip(t *testing.T) {
	dir := t.TempDir()

	info := SessionInfo{
		Name:     "dev-orders-refactor-front",
		PID:      1234,
		Port:     53412,
		Command:  "pnpm",
		Args:     []string{"dev"},
		WorkDir:  "/tmp/wt",
		Project:  "simplx",
		WtName:   "orders-refactor",
		WtPath:   "/tmp/wt",
		Instance: "orders-refactor",
		Service:  "front",
	}

	if err := SaveSession(dir, info); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	sessions, err := LoadAllSessions(dir)
	if err != nil {
		t.Fatalf("LoadAllSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	got := sessions[0]
	if got.Instance != "orders-refactor" {
		t.Errorf("Instance = %q, want %q", got.Instance, "orders-refactor")
	}
	if got.Service != "front" {
		t.Errorf("Service = %q, want %q", got.Service, "front")
	}
}

// TestSessionInfo_BackwardCompatWithoutInstanceService verifies that a
// legacy session JSON file (written before Instance/Service existed) still
// unmarshals cleanly, with the new fields defaulting to their zero value.
func TestSessionInfo_BackwardCompatWithoutInstanceService(t *testing.T) {
	dir := t.TempDir()

	legacy := map[string]interface{}{
		"name":       "dev-legacy",
		"pid":        999,
		"port":       4000,
		"command":    "pnpm",
		"args":       []string{"dev"},
		"work_dir":   "/tmp/legacy",
		"project":    "legacyproj",
		"wt_name":    "main",
		"wt_path":    "/tmp/legacy",
		"started_at": int64(0),
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("marshal legacy fixture: %v", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dev-legacy.json"), data, 0o644); err != nil {
		t.Fatalf("write legacy fixture: %v", err)
	}

	sessions, err := LoadAllSessions(dir)
	if err != nil {
		t.Fatalf("LoadAllSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	got := sessions[0]
	if got.Instance != "" {
		t.Errorf("Instance = %q, want empty (legacy file has no instance field)", got.Instance)
	}
	if got.Service != "" {
		t.Errorf("Service = %q, want empty (legacy file has no service field)", got.Service)
	}
	if got.Name != "dev-legacy" || got.PID != 999 {
		t.Errorf("legacy fields not preserved: %+v", got)
	}
}
