package process

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// VTermScreen wraps charmbracelet/x/vt to provide a thread-safe virtual terminal screen.
// PTY reader goroutine writes output, TUI goroutine reads screen content.
// SafeEmulator provides built-in concurrency safety for all operations.
//
// VTermScreen is a pure display component — it does NOT manage scrollback.
// Scrollback is handled separately by feeding sanitized PTY output directly
// into a SegmentedLog via the readPTY pipeline.
type VTermScreen struct {
	emu  *vt.SafeEmulator
	rows int
	cols int
}

// NewVTermScreen creates a new virtual terminal with given dimensions.
func NewVTermScreen(rows, cols int) *VTermScreen {
	emu := vt.NewSafeEmulator(cols, rows)
	return &VTermScreen{
		emu:  emu,
		rows: rows,
		cols: cols,
	}
}

// Write processes raw terminal output through the terminal emulator.
// Implements io.Writer. Called from the PTY reader goroutine.
func (s *VTermScreen) Write(p []byte) (int, error) {
	return s.emu.Write(p)
}

// Content returns the current screen content as plain text (no ANSI codes).
// Trims trailing whitespace from each line and trailing empty lines.
func (s *VTermScreen) Content() string {
	rendered := s.emu.Render()
	plain := ansi.Strip(rendered)
	return trimScreen(plain)
}

// Render returns the current screen content with ANSI escape codes preserved.
// Trims trailing whitespace from each line and trailing empty lines.
func (s *VTermScreen) Render() string {
	return s.emu.Render()
}

// RenderedLines returns each VTerm row as a separate string with ANSI codes preserved.
// Trailing whitespace and \r are trimmed from each line. Trailing empty lines are removed.
func (s *VTermScreen) RenderedLines() []string {
	rendered := s.emu.Render()
	lines := strings.Split(rendered, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \r")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// PlainLines returns each VTerm row as plain text (no ANSI codes).
// Trailing whitespace and \r are trimmed from each line. Trailing empty lines are removed.
func (s *VTermScreen) PlainLines() []string {
	rendered := s.emu.Render()
	plain := ansi.Strip(rendered)
	lines := strings.Split(plain, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \r")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// Resize changes the terminal dimensions.
func (s *VTermScreen) Resize(rows, cols int) {
	s.rows = rows
	s.cols = cols
	s.emu.Resize(cols, rows)
}

// trimScreen trims trailing whitespace from each line and removes trailing empty lines.
func trimScreen(content string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " ")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}
