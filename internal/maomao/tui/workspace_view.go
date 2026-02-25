package tui

import (
	"github.com/charmbracelet/lipgloss"
)

func (w *Workspace) View() string {
	if w.width == 0 || w.height == 0 {
		return "Loading..."
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
	rightW := w.width - sidebarW
	contentH := w.height - 1 // -1 for status bar

	// Sidebar
	var left string
	if !w.sidebarHidden {
		w.sidebar.width = sidebarW
		w.sidebar.height = contentH
		left = w.sidebar.View()
	}

	// Panes (right side, horizontally arranged)
	var right string
	if len(w.panes) == 0 {
		placeholder := lipgloss.NewStyle().
			Width(rightW).
			Height(contentH).
			Foreground(catGray).
			Align(lipgloss.Center, lipgloss.Center).
			Render("select a task to start")
		right = placeholder
	} else if w.fullscreen && w.paneIdx < len(w.panes) {
		// Fullscreen: only show focused pane
		w.panes[w.paneIdx].SetSize(contentH, rightW)
		right = w.panes[w.paneIdx].View()
	} else {
		paneW := rightW / len(w.panes)
		var paneViews []string
		for i := range w.panes {
			w.panes[i].SetSize(contentH, paneW)
			paneViews = append(paneViews, w.panes[i].View())
		}
		right = lipgloss.JoinHorizontal(lipgloss.Top, paneViews...)
	}

	var body string
	if w.sidebarHidden {
		body = right
	} else {
		body = lipgloss.JoinHorizontal(lipgloss.Top, left, right)
	}

	// Status bar
	w.statusBar.width = w.width
	bar := w.statusBar.View()

	screen := lipgloss.JoinVertical(lipgloss.Left, body, bar)

	// Overlay on top if active
	if w.mode == modeOverlay {
		if w.overlay.kind == overlayHandoff && w.handoffOvl != nil {
			w.handoffOvl.width = w.width
			w.handoffOvl.height = w.height
			return w.handoffOvl.View()
		}
		if w.overlay.kind == overlayMessage && w.msgOverlay != nil {
			w.msgOverlay.width = w.width
			w.msgOverlay.height = w.height
			return w.msgOverlay.View()
		}
		if w.overlay.kind != overlayNone {
			w.overlay.width = w.width
			w.overlay.height = w.height
			return w.overlay.View()
		}
	}

	// td status overlay
	if w.tdOverlay {
		box := lipgloss.NewStyle().
			Width(w.width - 10).
			MaxHeight(w.height - 6).
			Padding(1, 2).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(catBlue).
			Render(w.tdContent)
		return lipgloss.Place(w.width, w.height, lipgloss.Center, lipgloss.Center, box)
	}

	// Diff overlay
	if w.diffOverlay != nil {
		return w.diffOverlay.View(w.width, w.height)
	}

	// Quit confirmation overlay
	if w.quitConfirm {
		prompt := lipgloss.NewStyle().
			Bold(true).
			Foreground(catWhite).
			Background(catModalBg).
			Padding(1, 3).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(catBlue).
			Render("Quit マオマオ maomao? (y/n)")
		return lipgloss.Place(w.width, w.height,
			lipgloss.Center, lipgloss.Center,
			prompt)
	}

	// Delete confirmation overlay
	if w.deleteConfirm {
		cursorSt := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
		dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
		graySt := lipgloss.NewStyle().Foreground(catGray)

		opt0prefix := "  "
		opt1prefix := "  "
		if w.deleteCursor == 0 {
			opt0prefix = cursorSt.Render("▸ ")
		} else {
			opt1prefix = cursorSt.Render("▸ ")
		}

		content := lipgloss.NewStyle().Bold(true).Foreground(catWhite).Render("Delete task "+w.deleteTaskID+"?") + "\n\n" +
			opt0prefix + dimSt.Render("Delete all (worktrees + branches)") + "\n" +
			opt1prefix + dimSt.Render("Keep branches") + "\n\n" +
			graySt.Render("j/k move  enter confirm  esc cancel")

		prompt := lipgloss.NewStyle().
			Background(catModalBg).
			Padding(1, 3).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(catBlue).
			Render(content)

		return lipgloss.Place(w.width, w.height, lipgloss.Center, lipgloss.Center, prompt)
	}

	return screen
}
