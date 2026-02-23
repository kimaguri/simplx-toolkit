package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestWorkspace_InitialState(t *testing.T) {
	tasks := []TaskEntry{{ID: "T1", Title: "test", Status: "active", Active: true, Repos: 1}}
	w := NewWorkspace(tasks, nil, nil, "")

	if w.mode != modeNavigate {
		t.Fatalf("initial mode should be navigate, got %d", w.mode)
	}
	if w.focus != focusSidebar {
		t.Fatalf("initial focus should be sidebar, got %d", w.focus)
	}
}

func TestWorkspace_TabSwitchesFocus(t *testing.T) {
	tasks := []TaskEntry{{ID: "T1", Title: "test", Status: "active", Active: true, Repos: 1}}
	opener := func(taskID string) ([]PaneInit, error) {
		return []PaneInit{{RepoName: "repo1"}}, nil
	}
	w := NewWorkspace(tasks, opener, nil, "")
	w.SetSize(80, 40)

	// Open the task to create panes
	w.openTask(tasks[0])

	// Tab should switch to panes (panes exist after openTask)
	if w.focus != focusPanes {
		t.Fatalf("after openTask, focus should be panes, got %d", w.focus)
	}

	// Tab back to sidebar
	w, _ = w.updateNavigate(tea.KeyMsg{Type: tea.KeyTab})
	if w.focus != focusSidebar {
		t.Fatalf("tab should switch to sidebar, got %d", w.focus)
	}

	// Tab again to panes
	w, _ = w.updateNavigate(tea.KeyMsg{Type: tea.KeyTab})
	if w.focus != focusPanes {
		t.Fatalf("tab should switch back to panes, got %d", w.focus)
	}
}

func TestWorkspace_View_NoTask(t *testing.T) {
	w := NewWorkspace(nil, nil, nil, "")
	w.SetSize(80, 40)
	view := w.View()
	if !strings.Contains(view, "Tasks") || !strings.Contains(view, "select a task") {
		t.Fatalf("should show sidebar and placeholder, got: %q", view)
	}
}

func TestWorkspace_InteractiveModeToggle(t *testing.T) {
	tasks := []TaskEntry{{ID: "T1", Title: "test", Status: "active", Active: true, Repos: 1}}
	opener := func(taskID string) ([]PaneInit, error) {
		return []PaneInit{{RepoName: "repo1"}}, nil
	}
	w := NewWorkspace(tasks, opener, nil, "")
	w.SetSize(80, 40)

	// Open task to create panes
	w.openTask(tasks[0])

	// Set pane to running (so interactive mode is allowed)
	w.panes[0].status = paneRunning

	// Press i to enter interactive
	w, _ = w.updatePaneKeys(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("i")})
	if w.mode != modeInteractive {
		t.Fatalf("pressing i should enter interactive, got %d", w.mode)
	}
}

func TestWorkspace_QuitFromNavigate(t *testing.T) {
	w := NewWorkspace(nil, nil, nil, "")
	w.SetSize(80, 40)

	// First press q — should set quitConfirm
	w, _ = w.updateNavigate(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if !w.quitConfirm {
		t.Fatal("q should set quitConfirm")
	}

	// Press n to cancel
	w.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("n")})
	if w.quitConfirm {
		t.Fatal("n should cancel quitConfirm")
	}

	// Press q again, then y to confirm quit
	w, _ = w.updateNavigate(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	_, cmd := w.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	if cmd == nil {
		t.Fatal("y should return quit command")
	}
}

func TestWorkspace_AutoOpenInitialTask(t *testing.T) {
	tasks := []TaskEntry{{ID: "T1", Title: "test", Status: "active", Active: true, Repos: 1}}
	openerCalled := ""
	opener := func(taskID string) ([]PaneInit, error) {
		openerCalled = taskID
		return []PaneInit{{RepoName: "repo1"}}, nil
	}
	w := NewWorkspace(tasks, opener, nil, "T1")

	// Init should return a cmd that produces taskOpenMsg
	cmd := w.Init()
	if cmd == nil {
		t.Fatal("Init should return a command for initial task")
	}

	// Execute the cmd to get the message
	msg := cmd()
	openMsg, ok := msg.(taskOpenMsg)
	if !ok {
		t.Fatalf("expected taskOpenMsg, got %T", msg)
	}
	if openMsg.task.ID != "T1" {
		t.Fatalf("expected task T1, got %s", openMsg.task.ID)
	}

	// Process the message — should call opener
	w.SetSize(80, 40)
	w.Update(openMsg)
	if openerCalled != "T1" {
		t.Fatalf("opener should be called with T1, got %q", openerCalled)
	}
}

func TestWorkspace_TaskSwitchPreservesPanes(t *testing.T) {
	tasks := []TaskEntry{
		{ID: "T1", Title: "task1", Status: "active", Active: true, Repos: 1},
		{ID: "T2", Title: "task2", Status: "parked", Repos: 1},
	}
	callCount := 0
	opener := func(taskID string) ([]PaneInit, error) {
		callCount++
		return []PaneInit{{RepoName: "repo-" + taskID}}, nil
	}
	w := NewWorkspace(tasks, opener, nil, "")
	w.SetSize(80, 40)

	// Open T1
	w.openTask(tasks[0])
	if len(w.panes) != 1 || w.panes[0].name != "repo-T1" {
		t.Fatalf("expected repo-T1 pane, got %v", w.panes)
	}
	if callCount != 1 {
		t.Fatalf("opener should be called once, got %d", callCount)
	}

	// Switch to T2
	w.openTask(tasks[1])
	if len(w.panes) != 1 || w.panes[0].name != "repo-T2" {
		t.Fatalf("expected repo-T2 pane, got %v", w.panes)
	}
	if callCount != 2 {
		t.Fatalf("opener should be called twice, got %d", callCount)
	}

	// Switch back to T1 — should restore cached panes, NOT call opener again
	w.openTask(tasks[0])
	if len(w.panes) != 1 || w.panes[0].name != "repo-T1" {
		t.Fatalf("expected cached repo-T1 pane, got %v", w.panes)
	}
	if callCount != 2 {
		t.Fatalf("opener should NOT be called again, got %d", callCount)
	}
}

func TestWorkspace_BackToDashboard(t *testing.T) {
	w := NewWorkspace(nil, nil, nil, "")
	w.SetSize(80, 40)
	_, cmd := w.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if !w.BackToDashboard() {
		t.Error("expected backToDashboard to be true")
	}
	if cmd == nil {
		t.Error("expected tea.Quit command")
	}
}

func TestWorkspace_SidebarRefresh(t *testing.T) {
	called := false
	loader := func() []TaskEntry {
		called = true
		return []TaskEntry{{ID: "NEW", Title: "refreshed"}}
	}
	w := NewWorkspace(nil, nil, loader, "")
	w.SetSize(80, 40)

	w, _ = w.updateSidebarKeys(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	if !called {
		t.Fatal("r should call loadTasks")
	}
}
