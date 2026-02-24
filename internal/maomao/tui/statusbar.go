package tui

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

// workspaceMode represents the current interaction mode of the workspace.
type workspaceMode int

const (
	modeNavigate    workspaceMode = iota
	modeInteractive
	modeOverlay
)

// workspaceFocus represents which panel currently has focus.
type workspaceFocus int

const (
	focusSidebar workspaceFocus = iota
	focusPanes
)

// statusBarModel renders a Zellij-style status bar at the bottom of the workspace.
type statusBarModel struct {
	mode     workspaceMode
	focus    workspaceFocus
	paneName string // name of focused pane (shown in interactive mode)
	width    int
}

// newStatusBar creates a status bar with default navigate mode and sidebar focus.
func newStatusBar(width int) statusBarModel {
	return statusBarModel{
		mode:  modeNavigate,
		focus: focusSidebar,
		width: width,
	}
}

// View renders the status bar string.
func (s statusBarModel) View() string {
	pill := s.renderModePill()
	hints := s.renderHints()

	bar := fmt.Sprintf(" %s  %s", pill, hints)

	return lipgloss.NewStyle().
		Width(s.width).
		Background(lipgloss.Color("#0E1525")).
		Render(bar)
}

// renderModePill returns the colored mode indicator pill.
func (s statusBarModel) renderModePill() string {
	switch s.mode {
	case modeInteractive:
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#000000")).
			Background(catYellow).
			Padding(0, 1).
			Render("INTERACTIVE")
	default:
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#000000")).
			Background(catBlue).
			Padding(0, 1).
			Render("NAVIGATE")
	}
}

// renderHints returns contextual key hints based on mode and focus.
func (s statusBarModel) renderHints() string {
	barBg := lipgloss.Color("#0E1525")
	keyStyle := lipgloss.NewStyle().Foreground(catBlue).Bold(true).Background(barBg)
	descStyle := lipgloss.NewStyle().Foreground(catDimWhite).Background(barBg)

	hint := func(key, desc string) string {
		return keyStyle.Render(key) + descStyle.Render(" "+desc)
	}

	switch s.mode {
	case modeInteractive:
		typing := descStyle.Render(fmt.Sprintf("typing into: %s", s.paneName))
		return typing + "  " + hint("ctrl+v", "paste") + "  " + hint("Esc Esc", "exit")

	default: // modeNavigate
		if s.focus == focusPanes {
			return join(
				hint("i", "interact"),
				hint("y", "copy"),
				hint("s", "stop"),
				hint("r", "restart"),
				hint("f", "full"),
				hint("g", "git"),
				hint("t", "tasks"),
				hint("b", "sidebar"),
				hint("a", "add repo"),
				hint("m", "message"),
				hint("p", "park"),
				hint("tab", "next"),
				hint("q", "quit"),
			)
		}
		// focusSidebar
		return join(
			hint("j/k", "move"),
			hint("enter", "open"),
			hint("n", "new"),
			hint("d", "delete"),
			hint("b", "sidebar"),
			hint("tab", "panes"),
			hint("r", "refresh"),
			hint("q", "quit"),
		)
	}
}

// join concatenates strings with double-space separators.
func join(parts ...string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += "  "
		}
		result += p
	}
	return result
}
