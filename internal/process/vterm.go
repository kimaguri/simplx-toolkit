package process

import (
	"strings"
	"sync"

	"github.com/hinshun/vt10x"
)

// VTermScreen wraps vt10x to provide a thread-safe virtual terminal screen.
// PTY reader goroutine writes output, TUI goroutine reads screen content.
type VTermScreen struct {
	mu   sync.RWMutex
	vt   vt10x.Terminal
	rows int
	cols int
}

// NewVTermScreen creates a new virtual terminal with given dimensions.
func NewVTermScreen(rows, cols int) *VTermScreen {
	vt := vt10x.New(vt10x.WithSize(cols, rows))
	return &VTermScreen{
		vt:   vt,
		rows: rows,
		cols: cols,
	}
}

// Write processes raw terminal output through the VT100 emulator.
// Implements io.Writer. Called from the PTY reader goroutine.
func (s *VTermScreen) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.vt.Write(p)
}

// Content returns the current screen content as a string.
// Trims trailing whitespace from each line and trailing empty lines.
func (s *VTermScreen) Content() string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var lines []string
	for y := 0; y < s.rows; y++ {
		var row strings.Builder
		for x := 0; x < s.cols; x++ {
			g := s.vt.Cell(x, y)
			if g.Char == 0 {
				row.WriteByte(' ')
			} else {
				row.WriteRune(g.Char)
			}
		}
		lines = append(lines, strings.TrimRight(row.String(), " "))
	}

	// Trim trailing empty lines
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	return strings.Join(lines, "\n")
}

// Resize changes the terminal dimensions.
func (s *VTermScreen) Resize(rows, cols int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = rows
	s.cols = cols
	s.vt.Resize(cols, rows)
}
