package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type messageStep int

const (
	msgStepSelectTarget messageStep = iota
	msgStepTypeMessage
)

// messageResultMsg is sent when a manual message is ready to deliver.
type messageResultMsg struct {
	targetPane string
	message    string
}

// messageOverlayModel manages the two-step message overlay.
type messageOverlayModel struct {
	step    messageStep
	panes   []string // other pane names (excludes current)
	cursor  int
	input   string
	done    bool
	width   int
	height  int
}

func newMessageOverlay(paneNames []string, currentPane string, w, h int) messageOverlayModel {
	var others []string
	for _, n := range paneNames {
		if n != currentPane {
			others = append(others, n)
		}
	}
	return messageOverlayModel{
		step:  msgStepSelectTarget,
		panes: others,
		width: w,
		height: h,
	}
}

func (m messageOverlayModel) Update(msg tea.KeyMsg) (messageOverlayModel, tea.Cmd) {
	switch m.step {
	case msgStepSelectTarget:
		return m.updateSelectTarget(msg)
	case msgStepTypeMessage:
		return m.updateTypeMessage(msg)
	}
	return m, nil
}

func (m messageOverlayModel) updateSelectTarget(msg tea.KeyMsg) (messageOverlayModel, tea.Cmd) {
	switch msg.String() {
	case "j", "down":
		if m.cursor < len(m.panes)-1 {
			m.cursor++
		}
	case "k", "up":
		if m.cursor > 0 {
			m.cursor--
		}
	case "enter":
		if len(m.panes) > 0 {
			m.step = msgStepTypeMessage
			m.input = ""
		}
	case "esc":
		m.done = true
	}
	return m, nil
}

func (m messageOverlayModel) updateTypeMessage(msg tea.KeyMsg) (messageOverlayModel, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		text := strings.TrimSpace(m.input)
		if text == "" {
			return m, nil
		}
		m.done = true
		target := m.panes[m.cursor]
		return m, func() tea.Msg {
			return messageResultMsg{targetPane: target, message: text}
		}
	case tea.KeyEscape:
		m.done = true
		return m, nil
	case tea.KeyBackspace:
		if len(m.input) > 0 {
			m.input = m.input[:len(m.input)-1]
		}
	case tea.KeyRunes:
		m.input += string(msg.Runes)
	case tea.KeySpace:
		m.input += " "
	}
	return m, nil
}

func (m messageOverlayModel) View() string {
	modalW := 50
	if m.width > 0 && modalW > m.width-4 {
		modalW = m.width - 4
	}

	headerSt := lipgloss.NewStyle().Bold(true).Foreground(catBlue)
	dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
	graySt := lipgloss.NewStyle().Foreground(catGray)
	cursorSt := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
	inputSt := lipgloss.NewStyle().Foreground(catWhite)

	var lines []string
	lines = append(lines, headerSt.Render("  Send Message"))
	lines = append(lines, graySt.Render("  "+strings.Repeat("\u2500", modalW-4)))
	lines = append(lines, "")

	switch m.step {
	case msgStepSelectTarget:
		lines = append(lines, dimSt.Render("  Select target pane:"))
		lines = append(lines, "")
		for i, name := range m.panes {
			prefix := "    "
			if i == m.cursor {
				prefix = "  " + cursorSt.Render("\u25B8 ")
			}
			lines = append(lines, prefix+inputSt.Render(name))
		}
		if len(m.panes) == 0 {
			lines = append(lines, graySt.Render("    no other panes"))
		}

	case msgStepTypeMessage:
		target := m.panes[m.cursor]
		lines = append(lines, dimSt.Render("  To: "+target))
		lines = append(lines, "")
		lines = append(lines, dimSt.Render("  Type message:"))
		lines = append(lines, "")
		cursor := inputSt.Render(m.input) + cursorSt.Render("\u2588")
		lines = append(lines, "  "+cursor)
	}

	lines = append(lines, "")
	lines = append(lines, graySt.Render("  esc cancel  enter confirm"))

	content := strings.Join(lines, "\n")

	modal := lipgloss.NewStyle().
		Width(modalW).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(catBlue).
		Background(lipgloss.Color("#0E1525")).
		Padding(1, 0).
		Render(content)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, modal)
}
