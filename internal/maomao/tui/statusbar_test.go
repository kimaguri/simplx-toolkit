package tui

import (
	"strings"
	"testing"
)

func TestStatusBar_NavigateMode(t *testing.T) {
	sb := newStatusBar(120)
	sb.mode = modeNavigate
	sb.focus = focusSidebar

	view := sb.View()

	if !strings.Contains(view, "NAVIGATE") {
		t.Error("expected NAVIGATE in view")
	}
	if !strings.Contains(view, "j/k") {
		t.Error("expected j/k hint in view")
	}
	if !strings.Contains(view, "enter") {
		t.Error("expected enter hint in sidebar-focused navigate mode")
	}
	if !strings.Contains(view, "tab") {
		t.Error("expected tab hint in view")
	}
	if !strings.Contains(view, "quit") {
		t.Error("expected quit hint in view")
	}

	// Switch to panes focus — hints should change
	sb.focus = focusPanes
	view = sb.View()

	if !strings.Contains(view, "NAVIGATE") {
		t.Error("expected NAVIGATE in panes-focused view")
	}
	if !strings.Contains(view, "interact") {
		t.Error("expected interact hint in panes-focused view")
	}
	if !strings.Contains(view, "next") {
		t.Error("expected tab next hint in panes-focused view")
	}
}

func TestStatusBar_InteractiveMode(t *testing.T) {
	sb := newStatusBar(120)
	sb.mode = modeInteractive
	sb.paneName = "platform"

	view := sb.View()

	if !strings.Contains(view, "INTERACTIVE") {
		t.Error("expected INTERACTIVE in view")
	}
	if !strings.Contains(view, "platform") {
		t.Error("expected pane name 'platform' in view")
	}
	if !strings.Contains(view, "Esc") {
		t.Error("expected Esc hint in interactive mode")
	}
	if !strings.Contains(view, "exit") {
		t.Error("expected exit hint in interactive mode")
	}
}

func TestStatusBar_DefaultValues(t *testing.T) {
	sb := newStatusBar(80)

	if sb.mode != modeNavigate {
		t.Error("expected default mode to be modeNavigate")
	}
	if sb.focus != focusSidebar {
		t.Error("expected default focus to be focusSidebar")
	}
	if sb.width != 80 {
		t.Error("expected width to be 80")
	}
}

func TestStatusBar_ModePillContent(t *testing.T) {
	sb := newStatusBar(100)

	// Navigate pill
	sb.mode = modeNavigate
	view := sb.View()
	if !strings.Contains(view, "NAVIGATE") {
		t.Error("navigate pill missing")
	}
	if strings.Contains(view, "INTERACTIVE") {
		t.Error("should not contain INTERACTIVE in navigate mode")
	}

	// Interactive pill
	sb.mode = modeInteractive
	sb.paneName = "core"
	view = sb.View()
	if !strings.Contains(view, "INTERACTIVE") {
		t.Error("interactive pill missing")
	}
	if strings.Contains(view, "NAVIGATE") {
		t.Error("should not contain NAVIGATE in interactive mode")
	}
}
