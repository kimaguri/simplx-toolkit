package task

import (
	"path/filepath"
	"testing"
	"time"
)

func TestStartEndSession(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Start session
	sid, err := StartSession("test-task", []string{"repo1", "repo2"})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if sid == "" {
		t.Fatal("expected non-empty session ID")
	}

	// Verify active session exists
	tl, err := LoadTimeLog("test-task")
	if err != nil {
		t.Fatalf("LoadTimeLog: %v", err)
	}
	if len(tl.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(tl.Sessions))
	}
	if !tl.Sessions[0].EndedAt.IsZero() {
		t.Fatal("expected active session (zero EndedAt)")
	}
	if len(tl.Sessions[0].Repos) != 2 {
		t.Fatalf("expected 2 repos, got %d", len(tl.Sessions[0].Repos))
	}

	// End session
	if err := EndSession("test-task"); err != nil {
		t.Fatalf("EndSession: %v", err)
	}

	tl, _ = LoadTimeLog("test-task")
	if tl.Sessions[0].EndedAt.IsZero() {
		t.Fatal("expected ended session")
	}
	if tl.Sessions[0].ActiveSec < 0 {
		t.Fatalf("ActiveSec should be >= 0, got %d", tl.Sessions[0].ActiveSec)
	}
}

func TestMultipleSessions(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Start and end two sessions
	StartSession("multi-task", []string{"repo1"})
	EndSession("multi-task")
	StartSession("multi-task", []string{"repo1", "repo2"})
	EndSession("multi-task")

	tl, _ := LoadTimeLog("multi-task")
	if len(tl.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(tl.Sessions))
	}

	stats, err := GetStats("multi-task")
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if stats.SessionCount != 2 {
		t.Fatalf("expected SessionCount=2, got %d", stats.SessionCount)
	}
}

func TestStartAutoEndsActive(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Start first session (don't end it)
	StartSession("autoend-task", []string{"repo1"})

	// Start second session (should auto-end first)
	StartSession("autoend-task", []string{"repo2"})

	tl, _ := LoadTimeLog("autoend-task")
	if len(tl.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(tl.Sessions))
	}
	if tl.Sessions[0].EndedAt.IsZero() {
		t.Fatal("first session should be auto-ended")
	}
	if !tl.Sessions[1].EndedAt.IsZero() {
		t.Fatal("second session should still be active")
	}
}

func TestAddIdleTime(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	StartSession("idle-task", []string{"repo1"})
	AddIdleTime("idle-task", 600) // 10 minutes idle

	tl, _ := LoadTimeLog("idle-task")
	if tl.Sessions[0].IdleSec != 600 {
		t.Fatalf("expected IdleSec=600, got %d", tl.Sessions[0].IdleSec)
	}
}

func TestFormatDuration(t *testing.T) {
	tests := []struct {
		sec  int
		want string
	}{
		{0, "0s"},
		{30, "30s"},
		{60, "1m"},
		{90, "1m"},
		{3600, "1h 0m"},
		{3661, "1h 1m"},
		{7200, "2h 0m"},
		{10020, "2h 47m"},
	}
	for _, tt := range tests {
		got := FormatDuration(tt.sec)
		if got != tt.want {
			t.Errorf("FormatDuration(%d) = %q, want %q", tt.sec, got, tt.want)
		}
	}
}

func TestEmptyTimeLog(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// No task dir exists — should return empty log without error
	tl, err := LoadTimeLog("nonexistent")
	if err != nil {
		t.Fatalf("LoadTimeLog for nonexistent: %v", err)
	}
	if len(tl.Sessions) != 0 {
		t.Fatal("expected empty sessions")
	}
}

func TestGetTodayStats(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Manually create a timelog with an old session and a recent one
	yesterday := time.Now().Add(-24 * time.Hour)
	tl := &TimeLog{
		Sessions: []TimeSession{
			{
				ID:        "sold",
				StartedAt: yesterday,
				EndedAt:   yesterday.Add(time.Hour),
				ActiveSec: 3600,
			},
			{
				ID:        "stoday",
				StartedAt: time.Now().Add(-10 * time.Minute),
				EndedAt:   time.Now().Add(-5 * time.Minute),
				ActiveSec: 300,
			},
		},
	}
	SaveTimeLog("today-task", tl)

	todaySec, err := GetTodayStats("today-task")
	if err != nil {
		t.Fatalf("GetTodayStats: %v", err)
	}
	if todaySec != 300 {
		t.Fatalf("expected today=300, got %d", todaySec)
	}
}

func TestTimelogPersistence(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	StartSession("persist-task", []string{"repo1"})
	EndSession("persist-task")

	// Verify file was created on disk
	path := filepath.Join(dir, "persist-task", "timelog.toml")
	tl, err := LoadTimeLog("persist-task")
	if err != nil {
		t.Fatalf("LoadTimeLog: %v", err)
	}
	if len(tl.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(tl.Sessions))
	}
	_ = path // file existence is implicitly verified by successful LoadTimeLog
}

func TestPauseResume(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Start, pause, resume, end
	StartSession("pause-task", []string{"repo1"})
	PauseSession("pause-task")
	ResumeSession("pause-task", []string{"repo1", "repo2"})
	EndSession("pause-task")

	tl, _ := LoadTimeLog("pause-task")
	if len(tl.Sessions) != 2 {
		t.Fatalf("expected 2 sessions (original + resumed), got %d", len(tl.Sessions))
	}
	// Both sessions should be ended
	for i, s := range tl.Sessions {
		if s.EndedAt.IsZero() {
			t.Fatalf("session %d should be ended", i)
		}
	}
}
