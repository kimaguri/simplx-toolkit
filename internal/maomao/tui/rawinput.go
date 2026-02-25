package tui

import (
	"io"
	"sync"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// rawInputMsg carries raw stdin bytes captured before Bubbletea's parser.
// In interactive mode, these are forwarded directly to PTY instead of KeyMsg.
type rawInputMsg []byte

// exitInteractiveMsg signals that double-Esc was detected in raw input.
type exitInteractiveMsg struct{}

// tabSwitchMsg signals that Tab was detected in raw input (switch pane + exit interactive).
type tabSwitchMsg struct{}

// stdinProxy wraps the real stdin reader and tees raw bytes as rawInputMsg
// when interactive mode is active. This preserves escape sequences that
// Bubbletea's parser would otherwise strip (Shift+Enter, etc).
type stdinProxy struct {
	real        io.Reader
	sendMsg     func(tea.Msg)
	interactive atomic.Bool

	mu      sync.Mutex
	lastEsc time.Time
}

// NewStdinProxy creates a new stdin proxy that wraps the given reader.
func NewStdinProxy(real io.Reader) *stdinProxy {
	return &stdinProxy{real: real}
}

// SetSendFunc sets the function used to send messages to the Bubbletea program.
// Must be called after tea.NewProgram is created (chicken-and-egg resolution).
func (s *stdinProxy) SetSendFunc(fn func(tea.Msg)) {
	s.sendMsg = fn
}

// SetInteractive toggles raw passthrough mode.
func (s *stdinProxy) SetInteractive(on bool) {
	s.interactive.Store(on)
	if on {
		s.mu.Lock()
		s.lastEsc = time.Time{}
		s.mu.Unlock()
	}
}

// Read implements io.Reader. When interactive mode is active, raw bytes are
// tee'd as rawInputMsg to the Bubbletea program before being returned to
// Bubbletea's own parser.
func (s *stdinProxy) Read(p []byte) (int, error) {
	n, err := s.real.Read(p)
	if n > 0 && s.interactive.Load() && s.sendMsg != nil {
		raw := make([]byte, n)
		copy(raw, p[:n])

		// Check for control sequences BEFORE forwarding
		if s.checkDoubleEsc(raw) {
			s.sendMsg(exitInteractiveMsg{})
			return n, err
		}

		// Tab (0x09) as single byte -> switch pane
		if len(raw) == 1 && raw[0] == 0x09 {
			s.sendMsg(tabSwitchMsg{})
			return n, err
		}

		// Forward raw bytes as message
		s.sendMsg(rawInputMsg(raw))
	}
	return n, err
}

// checkDoubleEsc detects Esc+Esc within 300ms.
func (s *stdinProxy) checkDoubleEsc(raw []byte) bool {
	// Check if raw contains a single Esc byte (0x1b)
	if len(raw) == 1 && raw[0] == 0x1b {
		s.mu.Lock()
		defer s.mu.Unlock()
		now := time.Now()
		if !s.lastEsc.IsZero() && now.Sub(s.lastEsc) < 300*time.Millisecond {
			s.lastEsc = time.Time{}
			return true
		}
		s.lastEsc = now
		// Don't forward this Esc yet -- might be first of double-Esc.
		// Schedule a delayed forward: if no second Esc arrives within 300ms,
		// send the single Esc to PTY.
		go func() {
			time.Sleep(300 * time.Millisecond)
			s.mu.Lock()
			wasEsc := s.lastEsc
			s.mu.Unlock()
			// If lastEsc is still this one (no second Esc arrived), forward it
			if wasEsc.Equal(now) && s.interactive.Load() && s.sendMsg != nil {
				s.sendMsg(rawInputMsg([]byte{0x1b}))
				s.mu.Lock()
				s.lastEsc = time.Time{}
				s.mu.Unlock()
			}
		}()
		return false
	}
	return false
}
