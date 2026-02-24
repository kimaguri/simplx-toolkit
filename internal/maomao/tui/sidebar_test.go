package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func sampleTasks() []TaskEntry {
	return []TaskEntry{
		{ID: "task-001", Type: "feature", Title: "Add login", Status: "running", Active: true, Repos: 2},
		{ID: "task-002", Type: "bugfix", Title: "Fix crash", Status: "pending", Active: false, Repos: 1},
		{ID: "task-003", Type: "refactor", Title: "Clean up", Status: "done", Active: false, Repos: 3},
	}
}

func TestSidebar_View_Empty(t *testing.T) {
	s := newSidebar(nil, 80, 40)
	view := s.View()
	if !strings.Contains(view, "no tasks") {
		t.Errorf("expected 'no tasks' in empty sidebar view, got:\n%s", view)
	}
}

func TestSidebar_View_WithTasks(t *testing.T) {
	tasks := sampleTasks()
	s := newSidebar(tasks, 80, 40)
	view := s.View()

	for _, task := range tasks {
		if !strings.Contains(view, task.ID) {
			t.Errorf("expected task ID %q in view, got:\n%s", task.ID, view)
		}
	}

	if !strings.Contains(view, "Tasks") {
		t.Error("expected 'Tasks' header in view")
	}

	// Verify detail block is shown for the first task (cursor at 0)
	if !strings.Contains(view, "Detail") {
		t.Error("expected 'Detail' section in view")
	}
	if !strings.Contains(view, "Add login") {
		t.Error("expected selected task title in detail section")
	}
}

func TestSidebar_Navigation(t *testing.T) {
	tasks := sampleTasks()
	s := newSidebar(tasks, 80, 40)

	// Initial cursor at 0
	if s.cursor != 0 {
		t.Fatalf("expected initial cursor=0, got %d", s.cursor)
	}

	// Move down with j
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if s.cursor != 1 {
		t.Errorf("after j: expected cursor=1, got %d", s.cursor)
	}

	// Move down with down arrow
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyDown})
	if s.cursor != 2 {
		t.Errorf("after down: expected cursor=2, got %d", s.cursor)
	}

	// Clamp at bottom
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if s.cursor != 2 {
		t.Errorf("after j at bottom: expected cursor=2 (clamped), got %d", s.cursor)
	}

	// Move up with k
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if s.cursor != 1 {
		t.Errorf("after k: expected cursor=1, got %d", s.cursor)
	}

	// Move up with up arrow
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyUp})
	if s.cursor != 0 {
		t.Errorf("after up: expected cursor=0, got %d", s.cursor)
	}

	// Clamp at top
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if s.cursor != 0 {
		t.Errorf("after k at top: expected cursor=0 (clamped), got %d", s.cursor)
	}
}

func TestSidebar_SelectedTask(t *testing.T) {
	// Empty sidebar returns nil
	s := newSidebar(nil, 80, 40)
	if got := s.SelectedTask(); got != nil {
		t.Errorf("expected nil for empty sidebar, got %+v", got)
	}

	// Non-empty sidebar returns correct task
	tasks := sampleTasks()
	s = newSidebar(tasks, 80, 40)

	selected := s.SelectedTask()
	if selected == nil {
		t.Fatal("expected non-nil selected task at cursor 0")
	}
	if selected.ID != "task-001" {
		t.Errorf("expected task-001, got %s", selected.ID)
	}

	// Move cursor and verify
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	selected = s.SelectedTask()
	if selected == nil {
		t.Fatal("expected non-nil selected task at cursor 1")
	}
	if selected.ID != "task-002" {
		t.Errorf("expected task-002, got %s", selected.ID)
	}

	// Move to last task
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	selected = s.SelectedTask()
	if selected == nil {
		t.Fatal("expected non-nil selected task at cursor 2")
	}
	if selected.ID != "task-003" {
		t.Errorf("expected task-003, got %s", selected.ID)
	}
}

func TestSidebar_Detail_ShowsRepoNames(t *testing.T) {
	tasks := []TaskEntry{
		{ID: "T1", Title: "fix auth", Status: "active", Active: true, Repos: 2, RepoNames: []string{"platform", "simplx-core"}},
	}
	s := newSidebar(tasks, 40, 30)
	view := s.View()
	if !strings.Contains(view, "platform") {
		t.Fatalf("should show repo name 'platform', got: %q", view)
	}
	if !strings.Contains(view, "simplx-core") {
		t.Fatalf("should show repo name 'simplx-core', got: %q", view)
	}
}

func TestSidebar_SetTasks(t *testing.T) {
	tasks := sampleTasks()
	s := newSidebar(tasks, 80, 40)

	// Move cursor to the end
	s.cursor = 2

	// Replace with fewer tasks - cursor should clamp
	s.SetTasks([]TaskEntry{
		{ID: "task-010", Type: "feature", Title: "New one", Status: "pending", Active: false, Repos: 1},
	})
	if s.cursor != 0 {
		t.Errorf("expected cursor=0 after SetTasks with 1 task, got %d", s.cursor)
	}
	if s.SelectedTask().ID != "task-010" {
		t.Errorf("expected task-010, got %s", s.SelectedTask().ID)
	}

	// Replace with empty list - cursor should be 0
	s.SetTasks(nil)
	if s.cursor != 0 {
		t.Errorf("expected cursor=0 after SetTasks with empty list, got %d", s.cursor)
	}
	if s.SelectedTask() != nil {
		t.Error("expected nil SelectedTask after SetTasks with empty list")
	}
}
