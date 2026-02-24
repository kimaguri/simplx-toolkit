package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestTermPane_View_NoProcess(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)
	view := p.View()
	if !strings.Contains(view, "test-repo") {
		t.Fatalf("should show repo name, got: %q", view)
	}
	if !strings.Contains(view, "not started") {
		t.Fatalf("should show not started, got: %q", view)
	}
}

func TestTermPane_View_WithProcess(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)
	p.status = paneRunning
	p.content = "$ claude --resume\nAnalyzing..."
	view := p.View()
	if !strings.Contains(view, "Analyzing") {
		t.Fatalf("should show terminal content, got: %q", view)
	}
}

func TestTermPane_BorderColor(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)

	// Unfocused
	p.focused = false
	p.interactive = false
	view := p.View()
	_ = view // just verify no panic

	// Focused
	p.focused = true
	view = p.View()
	_ = view

	// Interactive
	p.interactive = true
	view = p.View()
	_ = view
}

func TestTermPane_Resize(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)
	p.SetSize(30, 100)
	if p.width != 100 || p.height != 30 {
		t.Fatalf("expected 100x30, got %dx%d", p.width, p.height)
	}
}

func TestTermPane_InteractiveKeyForward(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)
	p.interactive = true
	p.ptyWriter = &mockWriter{}

	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")}
	p, _ = p.Update(msg)

	mw := p.ptyWriter.(*mockWriter)
	if string(mw.data) != "a" {
		t.Fatalf("expected 'a' forwarded to PTY, got: %q", mw.data)
	}
}

type mockWriter struct {
	data []byte
}

func (m *mockWriter) Write(p []byte) (int, error) {
	m.data = append(m.data, p...)
	return len(p), nil
}

func TestTermPane_View_Loading(t *testing.T) {
	p := newTermPane("test-repo", 20, 60)
	p.status = paneRunning
	p.loading = true
	view := p.View()
	if !strings.Contains(view, "launching agent") {
		t.Fatalf("should show loading indicator when running but empty, got: %q", view)
	}
}
