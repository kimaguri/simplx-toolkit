package tui

import (
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
)

// handoffDetectedMsg is sent when a handoff file is found.
type handoffDetectedMsg struct {
	handoff agent.Handoff
}

// handoffScanMsg triggers a periodic scan for handoff files.
type handoffScanMsg struct{}

// handoffResultMsg is sent when the user approves or denies a handoff.
type handoffResultMsg struct {
	approved bool
	handoff  agent.Handoff
}

// scheduleHandoffScan returns a Cmd that fires handoffScanMsg after 2s.
func scheduleHandoffScan() tea.Cmd {
	return tea.Tick(2*time.Second, func(time.Time) tea.Msg {
		return handoffScanMsg{}
	})
}

// handoffOverlayModel manages the handoff approval overlay.
type handoffOverlayModel struct {
	handoff agent.Handoff
	cursor  int // 0=Approve, 1=Deny
	done    bool
	width   int
	height  int
}

func newHandoffOverlay(h agent.Handoff, width, height int) handoffOverlayModel {
	return handoffOverlayModel{
		handoff: h,
		width:   width,
		height:  height,
	}
}

func (m handoffOverlayModel) Update(msg tea.KeyMsg) (handoffOverlayModel, tea.Cmd) {
	switch msg.String() {
	case "y":
		m.done = true
		h := m.handoff
		return m, func() tea.Msg {
			return handoffResultMsg{approved: true, handoff: h}
		}
	case "n", "esc":
		m.done = true
		h := m.handoff
		return m, func() tea.Msg {
			return handoffResultMsg{approved: false, handoff: h}
		}
	case "j", "down":
		if m.cursor == 0 {
			m.cursor = 1
		}
	case "k", "up":
		if m.cursor == 1 {
			m.cursor = 0
		}
	case "enter":
		m.done = true
		h := m.handoff
		approved := m.cursor == 0
		return m, func() tea.Msg {
			return handoffResultMsg{approved: approved, handoff: h}
		}
	}
	return m, nil
}

func (m handoffOverlayModel) View() string {
	modalW := 60
	if m.width > 0 && modalW > m.width-4 {
		modalW = m.width - 4
	}

	headerSt := lipgloss.NewStyle().Bold(true).Foreground(catYellow)
	dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
	graySt := lipgloss.NewStyle().Foreground(catGray)
	labelSt := lipgloss.NewStyle().Foreground(catWhite)
	activeSt := lipgloss.NewStyle().Foreground(catYellow).Bold(true)

	var lines []string
	lines = append(lines, headerSt.Render("  Handoff Detected"))
	lines = append(lines, graySt.Render("  "+strings.Repeat("\u2500", modalW-4)))
	lines = append(lines, "")
	lines = append(lines, dimSt.Render("  From: ")+labelSt.Render(m.handoff.SourceRepo))
	lines = append(lines, dimSt.Render("  To:   ")+labelSt.Render(m.handoff.TargetRepo))
	if m.handoff.Priority != "" {
		lines = append(lines, dimSt.Render("  Priority: ")+labelSt.Render(m.handoff.Priority))
	}
	lines = append(lines, "")
	lines = append(lines, graySt.Render("  "+strings.Repeat("\u2500", modalW-4)))

	// Preview content (truncated)
	preview := m.handoff.Content
	previewLines := strings.Split(preview, "\n")
	maxPreview := 10
	if len(previewLines) > maxPreview {
		previewLines = previewLines[:maxPreview]
		previewLines = append(previewLines, "  ...")
	}
	for _, l := range previewLines {
		if len(l) > modalW-6 {
			l = l[:modalW-9] + "..."
		}
		lines = append(lines, "  "+dimSt.Render(l))
	}

	lines = append(lines, "")
	lines = append(lines, graySt.Render("  "+strings.Repeat("\u2500", modalW-4)))
	lines = append(lines, "")

	// Buttons
	approveLabel := "  Approve"
	denyLabel := "  Deny"
	if m.cursor == 0 {
		approveLabel = activeSt.Render("  \u25B8 Approve")
		denyLabel = "    " + dimSt.Render("Deny")
	} else {
		approveLabel = "    " + dimSt.Render("Approve")
		denyLabel = activeSt.Render("  \u25B8 Deny")
	}
	lines = append(lines, approveLabel)
	lines = append(lines, denyLabel)
	lines = append(lines, "")
	lines = append(lines, graySt.Render("  y approve  n deny  esc cancel"))

	content := strings.Join(lines, "\n")

	modal := lipgloss.NewStyle().
		Width(modalW).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(catYellow).
		Background(lipgloss.Color("#0E1525")).
		Padding(1, 0).
		Render(content)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, modal)
}
