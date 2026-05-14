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

// shouldExitInteractive decides whether an inbound key should exit interactive mode.
// Behavior:
//   - Non-Esc key: forward to PTY, disarm latch (returns zero lastEsc).
//   - First Esc (or Esc after window expired): arm — return newLastEsc=now, forward to PTY.
//   - Second Esc within window: exit — return exit=true, no forward, newLastEsc=zero.
//
// The caller owns the timestamp; this function is pure.
func shouldExitInteractive(now time.Time, lastEsc time.Time, msg tea.KeyMsg, window time.Duration) (exit bool, newLastEsc time.Time, forward bool) {
	if msg.Type != tea.KeyEscape {
		return false, time.Time{}, true
	}
	if !lastEsc.IsZero() && now.Sub(lastEsc) <= window {
		return true, time.Time{}, false
	}
	return false, now, true
}
