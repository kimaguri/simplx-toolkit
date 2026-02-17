package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// interactiveTickMsg triggers a VTerm viewport refresh while in interactive mode
type interactiveTickMsg struct{}

// scheduleInteractiveTick returns a Cmd that fires interactiveTickMsg after a short delay
func scheduleInteractiveTick() tea.Cmd {
	return tea.Tick(50*time.Millisecond, func(time.Time) tea.Msg {
		return interactiveTickMsg{}
	})
}

// keyMsgToBytes converts a bubbletea KeyMsg to raw terminal bytes
// for forwarding to PTY stdin.
func keyMsgToBytes(msg tea.KeyMsg) []byte {
	switch msg.Type {
	case tea.KeyUp:
		return []byte("\x1b[A")
	case tea.KeyDown:
		return []byte("\x1b[B")
	case tea.KeyRight:
		return []byte("\x1b[C")
	case tea.KeyLeft:
		return []byte("\x1b[D")
	case tea.KeyEnter:
		return []byte("\r")
	case tea.KeySpace:
		return []byte(" ")
	case tea.KeyTab:
		return []byte("\t")
	case tea.KeyBackspace:
		return []byte("\x7f")
	case tea.KeyEscape:
		return []byte("\x1b")
	case tea.KeyCtrlC:
		return []byte("\x03")
	case tea.KeyCtrlD:
		return []byte("\x04")
	case tea.KeyRunes:
		return []byte(string(msg.Runes))
	default:
		return nil
	}
}

// isExitInteractiveKey checks if the key combination exits interactive mode.
// Ctrl+] (0x1d) = Group Separator.
func isExitInteractiveKey(msg tea.KeyMsg) bool {
	return msg.Type == tea.KeyCtrlCloseBracket
}
