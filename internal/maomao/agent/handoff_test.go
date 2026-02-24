package agent

import (
	"os"
	"path/filepath"
	"testing"
)

const testHandoffContent = `Target: simplx-core
Priority: high

## What Changed
Added new API endpoint /api/v1/filters

## What Needs to Change
Update the frontend filter component to use the new endpoint

## API Contract
GET /api/v1/filters -> { filters: Filter[] }
`

func TestParseHandoff(t *testing.T) {
	dir := t.TempDir()
	mxdDir := filepath.Join(dir, ".maomao")
	os.MkdirAll(mxdDir, 0o755)

	handoffPath := filepath.Join(mxdDir, "handoff.md")
	os.WriteFile(handoffPath, []byte(testHandoffContent), 0o644)

	h, err := ParseHandoff(handoffPath, "platform")
	if err != nil {
		t.Fatalf("ParseHandoff: %v", err)
	}
	if h.TargetRepo != "simplx-core" {
		t.Errorf("TargetRepo = %q, want %q", h.TargetRepo, "simplx-core")
	}
	if h.Priority != "high" {
		t.Errorf("Priority = %q, want %q", h.Priority, "high")
	}
	if h.SourceRepo != "platform" {
		t.Errorf("SourceRepo = %q, want %q", h.SourceRepo, "platform")
	}
}

func TestScanWorktrees(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()

	// dir1 has a handoff
	mxdDir := filepath.Join(dir1, ".maomao")
	os.MkdirAll(mxdDir, 0o755)
	os.WriteFile(filepath.Join(mxdDir, "handoff.md"), []byte(testHandoffContent), 0o644)

	// dir2 has no handoff
	worktrees := map[string]string{
		"platform":    dir1,
		"simplx-core": dir2,
	}

	handoffs := ScanWorktrees(worktrees)
	if len(handoffs) != 1 {
		t.Fatalf("got %d handoffs, want 1", len(handoffs))
	}
	if handoffs[0].SourceRepo != "platform" {
		t.Errorf("SourceRepo = %q, want %q", handoffs[0].SourceRepo, "platform")
	}
}

func TestMarkDelivered(t *testing.T) {
	dir := t.TempDir()
	handoffPath := filepath.Join(dir, "handoff.md")
	os.WriteFile(handoffPath, []byte("test"), 0o644)

	if err := MarkDelivered(handoffPath); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}

	// Original should not exist
	if _, err := os.Stat(handoffPath); !os.IsNotExist(err) {
		t.Error("original file still exists")
	}

	// Delivered should exist
	if _, err := os.Stat(handoffPath + ".delivered"); err != nil {
		t.Error("delivered file does not exist")
	}
}
