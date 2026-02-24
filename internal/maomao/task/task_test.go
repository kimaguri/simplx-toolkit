package task

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	tk := &Task{
		ID:      "helpd-58",
		Type:    "fix",
		Title:   "фильтрация не работает",
		Status:  StatusActive,
		Created: time.Date(2026, 2, 21, 14, 0, 0, 0, time.UTC),
		Repos: []TaskRepo{{
			Name:   "platform",
			Branch: "fix/helpd-58/add-validation",
			Agent:  "claude",
			Status: RepoInProgress,
		}},
	}

	if err := Save(tk); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Verify file exists
	path := filepath.Join(dir, "helpd-58", "task.toml")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("task.toml not created")
	}

	loaded, err := Load("helpd-58")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.ID != "helpd-58" {
		t.Errorf("ID = %q, want %q", loaded.ID, "helpd-58")
	}
	if loaded.Title != "фильтрация не работает" {
		t.Errorf("Title = %q, want %q", loaded.Title, "фильтрация не работает")
	}
	if loaded.Status != StatusActive {
		t.Errorf("Status = %q, want %q", loaded.Status, StatusActive)
	}
	if len(loaded.Repos) != 1 {
		t.Fatalf("Repos count = %d, want 1", len(loaded.Repos))
	}
	if loaded.Repos[0].Name != "platform" {
		t.Errorf("Repo[0].Name = %q, want %q", loaded.Repos[0].Name, "platform")
	}
}

func TestList(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	// Save two tasks
	Save(&Task{ID: "helpd-58", Type: "fix", Title: "task 1", Status: StatusActive, Created: time.Now()})
	Save(&Task{ID: "helpd-99", Type: "feat", Title: "task 2", Status: StatusActive, Created: time.Now()})

	tasks, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("List count = %d, want 2", len(tasks))
	}
}

func TestAddRepo(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	tk := &Task{
		ID:      "helpd-58",
		Type:    "fix",
		Title:   "task",
		Status:  StatusActive,
		Created: time.Now(),
		Repos: []TaskRepo{{
			Name:   "platform",
			Branch: "fix/helpd-58/add-validation",
			Agent:  "claude",
			Status: RepoInProgress,
		}},
	}
	Save(tk)

	AddRepo(tk, "simplx-core", "/tmp/simplx-core", "fix/helpd-58/update-types", "/tmp/simplx-core/.worktrees/update-types", "claude")

	if len(tk.Repos) != 2 {
		t.Fatalf("Repos count = %d, want 2", len(tk.Repos))
	}
	if tk.Repos[1].Name != "simplx-core" {
		t.Errorf("Repo[1].Name = %q, want %q", tk.Repos[1].Name, "simplx-core")
	}
	if tk.Repos[1].Path != "/tmp/simplx-core" {
		t.Errorf("Repo[1].Path = %q, want %q", tk.Repos[1].Path, "/tmp/simplx-core")
	}
	if tk.Repos[1].WorktreeDir != "/tmp/simplx-core/.worktrees/update-types" {
		t.Errorf("Repo[1].WorktreeDir = %q, want %q", tk.Repos[1].WorktreeDir, "/tmp/simplx-core/.worktrees/update-types")
	}

	// Reload and verify persistence
	loaded, _ := Load("helpd-58")
	if len(loaded.Repos) != 2 {
		t.Fatalf("Reloaded repos count = %d, want 2", len(loaded.Repos))
	}
}

func TestLoadMissing(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	_, err := Load("nonexistent")
	if err == nil {
		t.Fatal("expected error for missing task")
	}
}

func TestSaveAgentLog(t *testing.T) {
	dir := t.TempDir()
	origDir := tasksDir
	tasksDir = dir
	defer func() { tasksDir = origDir }()

	err := SaveAgentLog("test-task", "my-repo", []byte("agent output line 1\nagent output line 2"))
	if err != nil {
		t.Fatalf("SaveAgentLog failed: %v", err)
	}

	logPath := filepath.Join(dir, "test-task", "repos", "my-repo", "agent.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("reading agent.log: %v", err)
	}
	if string(data) != "agent output line 1\nagent output line 2" {
		t.Fatalf("unexpected content: %q", string(data))
	}
}
