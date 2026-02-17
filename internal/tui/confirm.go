package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ConfirmResultMsg is emitted when the confirmation popup resolves
type ConfirmResultMsg struct {
	Confirmed bool
	Action    string // e.g. "kill", "restart"
	Target    string // session name
}

// confirmModel is a yes/no confirmation popup
type confirmModel struct {
	message     string
	action      string
	target      string
	focusYes    bool
	width       int
	height      int
}

// newConfirmModel creates a new confirmation popup
func newConfirmModel(message, action, target string) confirmModel {
	return confirmModel{
		message:  message,
		action:   action,
		target:   target,
		focusYes: false, // default to "No" for safety
	}
}

// Init implements tea.Model
func (m confirmModel) Init() tea.Cmd {
	return nil
}

// Update implements tea.Model
func (m confirmModel) Update(msg tea.Msg) (confirmModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "tab", "shift+tab", "left", "right", "h", "l":
			m.focusYes = !m.focusYes
			return m, nil

		case "enter":
			return m, func() tea.Msg {
				return ConfirmResultMsg{
					Confirmed: m.focusYes,
					Action:    m.action,
					Target:    m.target,
				}
			}

		case "esc":
			return m, func() tea.Msg {
				return ConfirmResultMsg{
					Confirmed: false,
					Action:    m.action,
					Target:    m.target,
				}
			}

		case "y", "Y":
			return m, func() tea.Msg {
				return ConfirmResultMsg{
					Confirmed: true,
					Action:    m.action,
					Target:    m.target,
				}
			}

		case "n", "N":
			return m, func() tea.Msg {
				return ConfirmResultMsg{
					Confirmed: false,
					Action:    m.action,
					Target:    m.target,
				}
			}
		}
	}
	return m, nil
}

// View implements tea.Model
func (m confirmModel) View() string {
	maxWidth := m.width - 4
	if maxWidth < 30 {
		maxWidth = 30
	}
	if maxWidth > 60 {
		maxWidth = 60
	}

	title := modalTitleStyle.Render("Confirm")
	msg := lipgloss.NewStyle().
		Width(maxWidth - 4).
		Render(m.message)

	var yesBtn, noBtn string
	if m.focusYes {
		yesBtn = activeButtonStyle.Render(" Yes ")
		noBtn = inactiveButtonStyle.Render(" No ")
	} else {
		yesBtn = inactiveButtonStyle.Render(" Yes ")
		noBtn = activeButtonStyle.Render(" No ")
	}

	buttons := lipgloss.JoinHorizontal(lipgloss.Center, yesBtn, "  ", noBtn)

	content := lipgloss.JoinVertical(lipgloss.Center,
		title,
		"",
		msg,
		"",
		buttons,
		"",
		dimStyle.Render("tab:switch  enter:confirm  esc:cancel  y/n:quick"),
	)

	popup := modalStyle.
		Width(maxWidth).
		Render(content)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, popup)
}

// SetSize updates the terminal dimensions for centering
func (m *confirmModel) SetSize(w, h int) {
	m.width = w
	m.height = h
}
