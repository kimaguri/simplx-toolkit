package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// settingsClosedMsg is sent when the settings overlay closes
type settingsClosedMsg struct {
	scanDirs []string
	changed  bool
}

// rescanRequestMsg is sent when the user requests a rescan from settings
type rescanRequestMsg struct{}

// settingsModel is the settings overlay for managing scan directories
type settingsModel struct {
	scanDirs       []string
	selected       int
	adding         bool
	addInput       textinput.Model
	width          int
	height         int
	changed        bool
	worktreeCounts map[string]int // worktrees found per scan dir
	totalFound     int            // total worktrees found
}

// newSettingsModel creates a new settings overlay
func newSettingsModel(scanDirs []string) settingsModel {
	ti := textinput.New()
	ti.Placeholder = "/path/to/scan/directory"
	ti.Width = 50
	ti.CharLimit = 200

	dirs := make([]string, len(scanDirs))
	copy(dirs, scanDirs)

	return settingsModel{
		scanDirs:       dirs,
		addInput:       ti,
		worktreeCounts: make(map[string]int),
	}
}

// Update handles settings input
func (m settingsModel) Update(msg tea.Msg) (settingsModel, tea.Cmd) {
	if keyMsg, ok := msg.(tea.KeyMsg); ok {
		if m.adding {
			return m.updateAdding(keyMsg)
		}
		return m.updateBrowsing(keyMsg)
	}
	return m, nil
}

// updateBrowsing handles keys when browsing the directory list
func (m settingsModel) updateBrowsing(msg tea.KeyMsg) (settingsModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return m, func() tea.Msg {
			return settingsClosedMsg{scanDirs: m.scanDirs, changed: m.changed}
		}

	case "a":
		m.adding = true
		m.addInput.SetValue("")
		m.addInput.Focus()
		return m, textinput.Blink

	case "d", "x":
		if len(m.scanDirs) > 0 && m.selected < len(m.scanDirs) {
			m.scanDirs = append(m.scanDirs[:m.selected], m.scanDirs[m.selected+1:]...)
			if m.selected >= len(m.scanDirs) && m.selected > 0 {
				m.selected--
			}
			m.changed = true
		}
		return m, nil

	case "r":
		// Request a rescan from the app
		return m, func() tea.Msg { return rescanRequestMsg{} }

	case "up", "k":
		if m.selected > 0 {
			m.selected--
		}
		return m, nil

	case "down", "j":
		if m.selected < len(m.scanDirs)-1 {
			m.selected++
		}
		return m, nil
	}

	return m, nil
}

// updateAdding handles keys when adding a new directory
func (m settingsModel) updateAdding(msg tea.KeyMsg) (settingsModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.adding = false
		m.addInput.Blur()
		return m, nil

	case "enter":
		dir := strings.TrimSpace(m.addInput.Value())
		if dir != "" {
			dir = normalizeDir(dir)

			dup := false
			for _, d := range m.scanDirs {
				if d == dir || normalizeDir(d) == dir {
					dup = true
					break
				}
			}
			if !dup {
				m.scanDirs = append(m.scanDirs, dir)
				m.changed = true
			}
		}
		m.adding = false
		m.addInput.Blur()
		return m, nil
	}

	var cmd tea.Cmd
	m.addInput, cmd = m.addInput.Update(msg)
	return m, cmd
}

// View renders the settings overlay
func (m settingsModel) View() string {
	maxWidth := m.width - 6
	if maxWidth < 50 {
		maxWidth = 50
	}
	if maxWidth > 80 {
		maxWidth = 80
	}

	title := modalTitleStyle.Render("Settings — Scan Directories")

	var body string
	if len(m.scanDirs) == 0 {
		body = dimStyle.Render("No scan directories configured.") + "\n" +
			dimStyle.Render("Press 'a' to add a directory.")
	} else {
		var lines []string
		for i, dir := range m.scanDirs {
			prefix := "  "
			style := normalItemStyle
			if i == m.selected {
				prefix = "> "
				style = selectedItemStyle
			}
			line := prefix + style.Render(dir)

			// Show worktree count if available
			if count, ok := m.worktreeCounts[dir]; ok {
				countStyle := dimStyle
				if count > 0 {
					countStyle = statusRunning
				}
				line += "  " + countStyle.Render(fmt.Sprintf("(%d repos)", count))
			}

			lines = append(lines, line)
		}
		body = strings.Join(lines, "\n")
	}

	// Total worktrees summary
	var summary string
	if m.totalFound > 0 {
		summary = statusRunning.Render(fmt.Sprintf("Total: %d worktrees", m.totalFound))
	} else if len(m.scanDirs) > 0 {
		summary = dimStyle.Render("Press 'r' to scan for worktrees")
	}

	var addLine string
	if m.adding {
		addLine = "\n" + dimStyle.Render("Path: ") + m.addInput.View()
	}

	help := "a:add  d:remove  r:rescan  esc:close"

	content := lipgloss.JoinVertical(lipgloss.Left,
		title,
		"",
		body,
		addLine,
		"",
		summary,
		"",
		dimStyle.Render(help),
	)

	popup := modalStyle.
		Width(maxWidth).
		Render(content)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, popup)
}

// SetSize updates dimensions for centering
func (m *settingsModel) SetSize(w, h int) {
	m.width = w
	m.height = h
}

// normalizeDir expands ~ and resolves to absolute path
func normalizeDir(dir string) string {
	if strings.HasPrefix(dir, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, dir[2:])
		}
	}
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	// Remove trailing slash
	dir = strings.TrimRight(dir, "/")
	return dir
}
