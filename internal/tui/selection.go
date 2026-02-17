package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"
)

// selectionMode tracks the visual selection state
type selectionMode int

const (
	selectionOff    selectionMode = iota
	selectionActive
)

// selectionAction is returned by handleKey to tell the caller what to do
type selectionAction int

const (
	selActionNone   selectionAction = iota
	selActionMoved                          // cursor moved — re-apply viewport
	selActionCopy                           // y pressed — copy and exit
	selActionCancel                         // esc pressed — exit
)

// selectionModel manages vim-style visual line selection
type selectionModel struct {
	mode        selectionMode
	anchor      int      // line where selection started
	cursor      int      // current cursor position
	totalLines  int
	frozenLines []string // snapshot of wrapped content at activation
}

// activate freezes the current viewport content and starts selection at the current offset
func (s *selectionModel) activate(vp viewport.Model, wrappedContent string) {
	s.mode = selectionActive
	s.frozenLines = strings.Split(wrappedContent, "\n")
	s.totalLines = len(s.frozenLines)
	s.anchor = vp.YOffset
	s.cursor = vp.YOffset
}

// deactivate exits selection mode and clears frozen content
func (s *selectionModel) deactivate() {
	s.mode = selectionOff
	s.anchor = 0
	s.cursor = 0
	s.totalLines = 0
	s.frozenLines = nil
}

// isActive returns true when visual selection is in progress
func (s *selectionModel) isActive() bool {
	return s.mode == selectionActive
}

// handleKey processes a key press during selection and returns the action to take.
// vpHeight is the visible viewport height for page-scroll calculations.
func (s *selectionModel) handleKey(key string, vpHeight int) selectionAction {
	switch key {
	case "j", "down":
		if s.cursor < s.totalLines-1 {
			s.cursor++
		}
		return selActionMoved
	case "k", "up":
		if s.cursor > 0 {
			s.cursor--
		}
		return selActionMoved
	case "G":
		s.cursor = s.totalLines - 1
		return selActionMoved
	case "g":
		s.cursor = 0
		return selActionMoved
	case "ctrl+d":
		s.cursor += vpHeight / 2
		if s.cursor >= s.totalLines {
			s.cursor = s.totalLines - 1
		}
		return selActionMoved
	case "ctrl+u":
		s.cursor -= vpHeight / 2
		if s.cursor < 0 {
			s.cursor = 0
		}
		return selActionMoved
	case "y":
		return selActionCopy
	case "esc":
		return selActionCancel
	}
	return selActionNone
}

// applyToViewport highlights the selected range in frozenLines and sets viewport content.
// Adjusts YOffset to keep the cursor line visible.
func (s *selectionModel) applyToViewport(vp *viewport.Model) {
	if s.frozenLines == nil {
		return
	}

	minL, maxL := s.selRange()
	lines := make([]string, len(s.frozenLines))

	for i, line := range s.frozenLines {
		if i >= minL && i <= maxL {
			if i == s.cursor {
				lines[i] = selectionCursorStyle.Render(padToWidth(line, vp.Width))
			} else {
				lines[i] = selectionHighlightStyle.Render(padToWidth(line, vp.Width))
			}
		} else {
			lines[i] = line
		}
	}

	vp.SetContent(strings.Join(lines, "\n"))

	// Ensure cursor is visible
	if s.cursor < vp.YOffset {
		vp.YOffset = s.cursor
	} else if s.cursor >= vp.YOffset+vp.Height {
		vp.YOffset = s.cursor - vp.Height + 1
	}
}

// selectedText returns the raw (un-highlighted) text of the selected lines
func (s *selectionModel) selectedText() string {
	if s.frozenLines == nil {
		return ""
	}
	minL, maxL := s.selRange()
	return strings.Join(s.frozenLines[minL:maxL+1], "\n")
}

// selectedLineCount returns the number of selected lines
func (s *selectionModel) selectedLineCount() int {
	minL, maxL := s.selRange()
	return maxL - minL + 1
}

// renderStatusBar renders the selection status bar
func (s *selectionModel) renderStatusBar(width int) string {
	count := s.selectedLineCount()
	text := fmt.Sprintf(" VISUAL: %d lines | j/k:move G/g:top/bottom y:copy Esc:cancel", count)
	return selectionBarStyle.Width(width).Render(text)
}

// selRange returns the min and max line indices of the selection
func (s *selectionModel) selRange() (int, int) {
	minL := s.anchor
	maxL := s.cursor
	if minL > maxL {
		minL, maxL = maxL, minL
	}
	if minL < 0 {
		minL = 0
	}
	if maxL >= s.totalLines {
		maxL = s.totalLines - 1
	}
	return minL, maxL
}

// padToWidth pads a string with spaces to fill the given visual width.
// This ensures the highlight background covers the full viewport width.
func padToWidth(s string, width int) string {
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}
