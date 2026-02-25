package tui

import tea "github.com/charmbracelet/bubbletea"

// handleMouseClick processes a left-click at (x, y) to switch focus.
func (w *Workspace) handleMouseClick(x, y int) (*Workspace, tea.Cmd) {
	// Exit interactive mode on any mouse click (focus is changing)
	if w.mode == modeInteractive {
		w.mode = modeNavigate
		if w.paneIdx < len(w.panes) {
			w.panes[w.paneIdx].interactive = false
		}
		if w.stdinProxy != nil {
			w.stdinProxy.SetInteractive(false)
		}
	}

	sidebarW := w.width / 4
	if sidebarW < 20 {
		sidebarW = 20
	}
	if sidebarW > 40 {
		sidebarW = 40
	}
	if w.sidebarHidden {
		sidebarW = 0
	}
	contentH := w.height - 1

	// Ignore status bar clicks
	if y >= contentH {
		return w, nil
	}

	if !w.sidebarHidden && x < sidebarW {
		// Clicked in sidebar
		w.focus = focusSidebar
		if idx := w.sidebar.taskIndexFromY(y); idx >= 0 {
			w.sidebar.cursor = idx
		}
	} else if len(w.panes) > 0 {
		// Clicked in pane area
		w.focus = focusPanes
		if !w.fullscreen {
			rightW := w.width - sidebarW
			paneW := rightW / len(w.panes)
			if paneW > 0 {
				idx := (x - sidebarW) / paneW
				if idx >= len(w.panes) {
					idx = len(w.panes) - 1
				}
				w.paneIdx = idx
			}
		}
	}

	w.updateFocusState()
	w.syncStatusBar()
	return w, nil
}
