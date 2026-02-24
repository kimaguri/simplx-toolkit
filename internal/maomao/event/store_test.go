package event

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	Init(dir)
	return dir
}

func TestEmit_CreatesFile(t *testing.T) {
	dir := setupTestDir(t)

	evt := New(AgentStarted, "T1", "platform", "")
	if err := Emit(evt); err != nil {
		t.Fatalf("Emit failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatalf("read events file: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "agent.started") {
		t.Errorf("expected agent.started in file, got: %s", content)
	}
	if !strings.Contains(content, "platform") {
		t.Errorf("expected 'platform' in file, got: %s", content)
	}
}

func TestRecent_ReturnsLastN(t *testing.T) {
	setupTestDir(t)

	for i := 0; i < 10; i++ {
		evt := Event{
			Timestamp: time.Now(),
			Type:      AgentStarted,
			TaskID:    "T1",
			Repo:      "repo",
			Detail:    strings.Repeat("x", i),
		}
		if err := Emit(evt); err != nil {
			t.Fatalf("Emit %d: %v", i, err)
		}
	}

	events, err := Recent(3)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	// Last event should have detail "xxxxxxxxx" (9 x's)
	if len(events[2].Detail) != 9 {
		t.Errorf("expected last event detail len=9, got %d", len(events[2].Detail))
	}
}

func TestRecent_AllEvents(t *testing.T) {
	setupTestDir(t)

	Emit(New(AgentStarted, "T1", "a", ""))
	Emit(New(AgentStopped, "T1", "b", ""))

	events, err := Recent(0)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
}

func TestByTask_FiltersCorrectly(t *testing.T) {
	setupTestDir(t)

	Emit(New(AgentStarted, "T1", "repo1", ""))
	Emit(New(AgentStarted, "T2", "repo2", ""))
	Emit(New(AgentStopped, "T1", "repo1", ""))
	Emit(New(AgentStarted, "T2", "repo3", ""))

	events, err := ByTask("T1", 0)
	if err != nil {
		t.Fatalf("ByTask: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 T1 events, got %d", len(events))
	}
	for _, e := range events {
		if e.TaskID != "T1" {
			t.Errorf("expected TaskID=T1, got %s", e.TaskID)
		}
	}
}

func TestByTask_LimitsResults(t *testing.T) {
	setupTestDir(t)

	for i := 0; i < 10; i++ {
		Emit(New(AgentStarted, "T1", "repo", ""))
	}

	events, err := ByTask("T1", 3)
	if err != nil {
		t.Fatalf("ByTask: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
}

func TestRotation(t *testing.T) {
	dir := setupTestDir(t)

	// Write enough data to trigger rotation (each line ~100 bytes)
	// Use a small maxFileSize for testing by writing a large file first
	fp := filepath.Join(dir, fileName)

	// Create a file just over the rotation threshold
	bigData := strings.Repeat(`{"ts":"2025-01-01T00:00:00Z","event":"agent.started","task":"T1","repo":"r"}`+"\n", 150000)
	os.WriteFile(fp, []byte(bigData), 0o644)

	// Verify file is over 10MB
	info, _ := os.Stat(fp)
	if info.Size() < int64(maxFileSize) {
		t.Skip("test data not large enough to trigger rotation")
	}

	// Emit should trigger rotation
	Emit(New(AgentStarted, "T1", "test", "after-rotation"))

	// Old file should be renamed
	if _, err := os.Stat(fp + ".1"); err != nil {
		t.Errorf("expected rotated file .1 to exist: %v", err)
	}

	// New file should exist with the new event
	data, _ := os.ReadFile(fp)
	if !strings.Contains(string(data), "after-rotation") {
		t.Error("new file should contain the post-rotation event")
	}
}

func TestEmit_NoInitIsNoop(t *testing.T) {
	// Reset store dir
	mu.Lock()
	old := storeDir
	storeDir = ""
	mu.Unlock()
	defer func() {
		mu.Lock()
		storeDir = old
		mu.Unlock()
	}()

	// Should not error when not initialized
	err := Emit(New(AgentStarted, "T1", "r", ""))
	if err != nil {
		t.Errorf("Emit without Init should be no-op, got: %v", err)
	}
}

func TestEventIcon(t *testing.T) {
	tests := []struct {
		typ  Type
		icon string
	}{
		{AgentStarted, "●"},
		{AgentStopped, "○"},
		{AgentCrashed, "✕"},
		{HandoffDelivered, "✦"},
		{MessageSent, "▸"},
		{TaskCreated, "◆"},
		{TaskParked, "◇"},
		{TaskCompleted, "✓"},
	}
	for _, tt := range tests {
		e := Event{Type: tt.typ}
		if got := e.Icon(); got != tt.icon {
			t.Errorf("Icon(%s) = %q, want %q", tt.typ, got, tt.icon)
		}
	}
}

func TestEventShortLabel(t *testing.T) {
	e := Event{Type: AgentStarted, Repo: "platform"}
	if got := e.ShortLabel(); got != "platform started" {
		t.Errorf("ShortLabel = %q, want %q", got, "platform started")
	}

	e = Event{Type: HandoffDelivered, Repo: "core"}
	if got := e.ShortLabel(); got != "handoff → core" {
		t.Errorf("ShortLabel = %q, want %q", got, "handoff → core")
	}

	e = Event{Type: TaskParked, TaskID: "T1"}
	if got := e.ShortLabel(); got != "task parked" {
		t.Errorf("ShortLabel = %q, want %q", got, "task parked")
	}
}
