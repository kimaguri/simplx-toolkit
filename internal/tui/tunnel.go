package tui

import (
	"fmt"
	"os/exec"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// --- Tunnel messages ---

type tunnelStartedMsg struct {
	name string
	url  string
}

type tunnelStoppedMsg struct {
	name string
}

type tunnelErrorMsg struct {
	name string
	err  error
}

type tunnelFeedbackMsg struct {
	message string
}

type clearTunnelFeedbackMsg struct{}

// cloudflaredMissingMsg signals that cloudflared is not installed
type cloudflaredMissingMsg struct {
	name string
}

// cloudflaredInstalledMsg signals that brew install cloudflared completed
type cloudflaredInstalledMsg struct {
	err string
}

// tunnelOverlayClosedMsg is sent when the tunnel overlay is dismissed
type tunnelOverlayClosedMsg struct{}

// --- Tunnel overlay model ---

type tunnelOverlayPhase int

const (
	tunnelPhaseStarting tunnelOverlayPhase = iota
	tunnelPhaseActive
	tunnelPhaseError
)

type tunnelOverlayModel struct {
	phase       tunnelOverlayPhase
	processName string
	url         string
	errMsg      string
	focusCopy   bool // true = Copy focused, false = OK focused
	copied      bool
	width       int
	height      int
}

func newTunnelOverlay(processName string) tunnelOverlayModel {
	return tunnelOverlayModel{
		phase:       tunnelPhaseStarting,
		processName: processName,
		focusCopy:   true,
	}
}

func (m tunnelOverlayModel) Update(msg tea.KeyMsg) (tunnelOverlayModel, tea.Cmd) {
	switch m.phase {
	case tunnelPhaseStarting:
		// No keys during starting — waiting for result
		return m, nil

	case tunnelPhaseActive:
		switch msg.String() {
		case "tab", "left", "right", "h", "l":
			m.focusCopy = !m.focusCopy
			return m, nil
		case "enter":
			if m.focusCopy {
				m.copied = true
				return m, copyTunnelURL(m.url)
			}
			return m, func() tea.Msg { return tunnelOverlayClosedMsg{} }
		case "c":
			m.copied = true
			return m, copyTunnelURL(m.url)
		case "esc", "q":
			return m, func() tea.Msg { return tunnelOverlayClosedMsg{} }
		}

	case tunnelPhaseError:
		switch msg.String() {
		case "enter", "esc", "q":
			return m, func() tea.Msg { return tunnelOverlayClosedMsg{} }
		}
	}
	return m, nil
}

func (m tunnelOverlayModel) View() string {
	maxWidth := m.width - 4
	if maxWidth < 30 {
		maxWidth = 30
	}
	if maxWidth > 60 {
		maxWidth = 60
	}

	var content string
	switch m.phase {
	case tunnelPhaseStarting:
		content = m.viewStarting(maxWidth)
	case tunnelPhaseActive:
		content = m.viewActive(maxWidth)
	case tunnelPhaseError:
		content = m.viewError(maxWidth)
	}

	popup := modalStyle.Width(maxWidth).Render(content)
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, popup)
}

func (m tunnelOverlayModel) viewStarting(maxWidth int) string {
	title := modalTitleStyle.Render("Tunnel")
	msg := dimStyle.Render("Starting tunnel for " + m.processName + "...")
	hint := dimStyle.Render("Waiting for cloudflared...")

	return lipgloss.JoinVertical(lipgloss.Center, title, "", msg, "", hint)
}

func (m tunnelOverlayModel) viewActive(maxWidth int) string {
	title := modalTitleStyle.Render("Tunnel Active")
	url := tunnelURLStyle.Render(m.url)
	urlBox := lipgloss.NewStyle().
		Width(maxWidth - 4).
		Align(lipgloss.Center).
		Render(url)

	var copyBtn, okBtn string
	if m.focusCopy {
		copyBtn = activeButtonStyle.Render(" Copy URL ")
		okBtn = inactiveButtonStyle.Render(" OK ")
	} else {
		copyBtn = inactiveButtonStyle.Render(" Copy URL ")
		okBtn = activeButtonStyle.Render(" OK ")
	}
	buttons := lipgloss.JoinHorizontal(lipgloss.Center, copyBtn, "  ", okBtn)

	var feedback string
	if m.copied {
		feedback = helpKeyStyle.Render("[URL copied]")
	}

	hint := dimStyle.Render("c:copy  tab:switch  enter:select  esc:close")

	parts := []string{title, "", urlBox, ""}
	if feedback != "" {
		parts = append(parts, feedback, "")
	}
	parts = append(parts, buttons, "", hint)

	return lipgloss.JoinVertical(lipgloss.Center, parts...)
}

func (m tunnelOverlayModel) viewError(maxWidth int) string {
	title := statusError.Render("Tunnel Error")
	msg := lipgloss.NewStyle().
		Width(maxWidth - 4).
		Render(m.errMsg)
	okBtn := activeButtonStyle.Render(" OK ")
	hint := dimStyle.Render("enter/esc:close")

	return lipgloss.JoinVertical(lipgloss.Center, title, "", msg, "", okBtn, "", hint)
}

// SetSize updates the terminal dimensions for centering
func (m *tunnelOverlayModel) SetSize(w, h int) {
	m.width = w
	m.height = h
}

// --- Tunnel commands ---

// startTunnelCmd checks for cloudflared and starts a tunnel
func startTunnelCmd(pm *process.ProcessManager, name string) tea.Cmd {
	return func() tea.Msg {
		if !process.CloudflaredAvailable() {
			return cloudflaredMissingMsg{name: name}
		}

		ti, err := pm.StartTunnel(name)
		if err != nil {
			return tunnelErrorMsg{name: name, err: err}
		}

		select {
		case url := <-ti.URLCh:
			ti.Status = process.TunnelActive
			ti.URL = url
			return tunnelStartedMsg{name: name, url: url}
		case <-ti.Done:
			return tunnelErrorMsg{
				name: name,
				err:  fmt.Errorf("cloudflared exited before providing URL"),
			}
		case <-time.After(30 * time.Second):
			process.StopTunnel(ti)
			return tunnelErrorMsg{
				name: name,
				err:  fmt.Errorf("tunnel URL timeout (30s)"),
			}
		}
	}
}

// stopTunnelCmd stops an active tunnel
func stopTunnelCmd(pm *process.ProcessManager, name string) tea.Cmd {
	return func() tea.Msg {
		err := pm.StopProcessTunnel(name)
		if err != nil {
			return tunnelErrorMsg{name: name, err: err}
		}
		return tunnelStoppedMsg{name: name}
	}
}

// copyTunnelURL copies the tunnel URL to clipboard
func copyTunnelURL(url string) tea.Cmd {
	if err := copyToClipboard(url); err != nil {
		return func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copy error: %v]", err)}
		}
	}
	return tea.Batch(
		func() tea.Msg {
			return ClipboardFeedbackMsg{Message: "[Tunnel URL copied]"}
		},
		clipboardFeedbackTimeout(),
	)
}

// installCloudflaredCmd runs brew install cloudflared
func installCloudflaredCmd() tea.Cmd {
	return func() tea.Msg {
		cmd := exec.Command("brew", "install", "cloudflared")
		output, err := cmd.CombinedOutput()
		if err != nil {
			return cloudflaredInstalledMsg{
				err: fmt.Sprintf("brew install failed: %v\n%s", err, string(output)),
			}
		}
		return cloudflaredInstalledMsg{}
	}
}

// tunnelFeedbackTimeout clears tunnel feedback after 4 seconds
func tunnelFeedbackTimeout() tea.Cmd {
	return tea.Tick(4*time.Second, func(_ time.Time) tea.Msg {
		return clearTunnelFeedbackMsg{}
	})
}
