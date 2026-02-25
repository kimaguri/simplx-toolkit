package tui

import (
	"fmt"
	"io"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// ScrollbackReader provides access to historical log lines for scrollback.
type ScrollbackReader interface {
	Len() int
	ReadRange(start, end int) []string
}

type paneStatus int

const (
	paneIdle paneStatus = iota
	paneRunning
	paneStopped
	paneError
)

// spinner frames (braille dots — smooth rotation)
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// termPaneModel represents a single repo's terminal pane.
type termPaneModel struct {
	name        string                      // repo name (display)
	processKey  string                      // unique key in ProcessManager
	worktreeDir string                      // worktree directory for handoff scanning
	width       int
	height      int
	focused     bool
	interactive bool                        // true = keystrokes forwarded to PTY
	status      paneStatus
	content     string                      // rendered terminal content (ANSI)
	ptyWriter   io.Writer                   // PTY master fd for input (nil if no process)
	vterm       interface{ Render() string } // VTermScreen for live refresh
	scrollback        ScrollbackReader  // segmented log for infinite scrollback
	scrollOff         int               // lines scrolled back from bottom (0 = live)
	colorIdx          int               // index into paneColorPalette
	tick        int                         // animation tick counter (incremented by workspace refresh)
	loading     bool                        // true until meaningful visible content arrives

	// Performance: dirty checking — skip string processing when content unchanged
	lastRawContent string

	// Performance: scrollback render cache — avoid subprocess on every View() call
	cachedScrollOff    int
	cachedScrollHeight int
	cachedScrollResult string
}

func newTermPane(name string, height, width int) termPaneModel {
	return termPaneModel{
		name:   name,
		height: height,
		width:  width,
		status: paneIdle,
	}
}

func (p termPaneModel) Update(msg tea.Msg) (termPaneModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if p.interactive && p.ptyWriter != nil {
			raw := keyMsgToBytes(msg)
			if raw != nil {
				if _, err := p.ptyWriter.Write(raw); err != nil {
					// Process exited — mark pane as stopped so workspace exits interactive mode
					p.status = paneStopped
					p.interactive = false
					p.ptyWriter = nil
				}
			}
		}
	}
	return p, nil
}

func (p termPaneModel) View() string {
	borderCols := 2 // left + right border columns
	innerW := p.width - borderCols
	innerH := p.height - 3 // -2 border rows (top+bottom), -1 title
	if innerW < 1 {
		innerW = 1
	}
	if innerH < 1 {
		innerH = 1
	}

	// Color scheme based on state: each pane gets its own color from palette
	dimBorder := lipgloss.Color("#3b4261")   // near-invisible for unfocused
	brightBorder := paneColorPalette[p.colorIdx%len(paneColorPalette)]
	interBorder := lipgloss.Color("#e0af68")  // warm yellow for interactive

	borderColor := dimBorder
	if p.focused {
		borderColor = brightBorder
	}
	if p.interactive {
		borderColor = interBorder
	}

	borderSt := lipgloss.NewStyle().Foreground(borderColor)

	// Status indicator — bright when focused, dim when not
	var statusStr string
	if p.focused || p.interactive {
		switch p.status {
		case paneRunning:
			if p.interactive {
				statusStr = lipgloss.NewStyle().Foreground(lipgloss.Color("#e0af68")).Render(" ● interactive ")
			} else {
				// Focused but not interactive = watching mode
				statusStr = lipgloss.NewStyle().Foreground(lipgloss.Color("#7aa2f7")).Render(" ◉ watching ")
			}
		case paneStopped:
			statusStr = lipgloss.NewStyle().Foreground(catDimWhite).Render(" ○ stopped ")
		case paneError:
			statusStr = lipgloss.NewStyle().Foreground(catRed).Render(" ✕ error ")
		default:
			statusStr = lipgloss.NewStyle().Foreground(catDimWhite).Render(" ○ idle ")
		}
	} else {
		switch p.status {
		case paneRunning:
			statusStr = lipgloss.NewStyle().Foreground(dimBorder).Render(" ● running ")
		case paneStopped:
			statusStr = lipgloss.NewStyle().Foreground(dimBorder).Render(" ○ stopped ")
		case paneError:
			statusStr = lipgloss.NewStyle().Foreground(dimBorder).Render(" ✕ error ")
		default:
			statusStr = lipgloss.NewStyle().Foreground(dimBorder).Render(" ○ idle ")
		}
	}

	// Title bar — focused gets bright name + accent, unfocused is dim
	var nameStr string
	if p.focused || p.interactive {
		nameStr = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#c0caf5")).
			Render(" " + p.name + " ")
	} else {
		nameStr = lipgloss.NewStyle().
			Foreground(dimBorder).
			Render(" " + p.name + " ")
	}

	leftPart := borderSt.Render("╭─") + nameStr
	rightPart := statusStr + borderSt.Render("─╮")
	leftLen := lipgloss.Width(leftPart)
	rightLen := lipgloss.Width(rightPart)
	fillLen := p.width - leftLen - rightLen
	if fillLen < 0 {
		fillLen = 0
	}
	fill := borderSt.Render(strings.Repeat("─", fillLen))
	titleBar := leftPart + fill + rightPart

	// Content
	var body string
	switch {
	case p.status == paneIdle:
		body = lipgloss.NewStyle().Foreground(catGray).Render("  not started")
	case p.status == paneRunning && p.loading:
		frame := spinnerFrames[(p.tick/3)%len(spinnerFrames)]
		spinSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#7aa2f7"))
		dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
		body = "\n" +
			"  " + spinSt.Render(frame) + dimSt.Render(" launching agent...") + "\n" +
			dimSt.Render("    waiting for output")
	case p.status == paneError:
		body = lipgloss.NewStyle().Foreground(catRed).Render("  error")
	default:
		if p.scrollOff > 0 && p.scrollback != nil {
			body = p.renderScrollback(innerH)
		} else {
			body = p.content
		}
	}

	// Content area with side borders
	contentStyle := lipgloss.NewStyle().
		Width(innerW).
		Height(innerH)
	rendered := contentStyle.Render(body)

	// Add side borders to each line
	contentLines := strings.Split(rendered, "\n")
	var bordered []string
	leftBorder := borderSt.Render("│")
	rightBorder := borderSt.Render("│")
	for _, line := range contentLines {
		lineW := lipgloss.Width(line)
		pad := innerW - lineW
		if pad < 0 {
			pad = 0
		}
		bordered = append(bordered, leftBorder+line+strings.Repeat(" ", pad)+rightBorder)
	}

	// Bottom border with optional scroll indicator
	var scrollIndicator string
	if p.scrollOff > 0 {
		scrollIndicator = lipgloss.NewStyle().Foreground(lipgloss.Color("#7aa2f7")).
			Render(fmt.Sprintf(" ↑%d ", p.scrollOff))
	}

	bottomLeft := borderSt.Render("╰─")
	bottomRight := borderSt.Render("─╯")
	indicatorW := lipgloss.Width(scrollIndicator)
	bottomFillLen := p.width - lipgloss.Width(bottomLeft) - lipgloss.Width(bottomRight) - indicatorW
	if bottomFillLen < 0 {
		bottomFillLen = 0
	}
	bottomBar := bottomLeft + scrollIndicator + borderSt.Render(strings.Repeat("─", bottomFillLen)) + bottomRight

	return titleBar + "\n" + strings.Join(bordered, "\n") + "\n" + bottomBar
}

// SetSize updates pane dimensions.
func (p *termPaneModel) SetSize(height, width int) {
	p.height = height
	p.width = width
}

// renderScrollback renders historical lines from the scrollback buffer.
// Results are cached to avoid spawning tmux subprocess on every View() call.
func (p *termPaneModel) renderScrollback(visibleLines int) string {
	// Return cached result if scrollOff and visible height haven't changed
	if p.scrollOff == p.cachedScrollOff && visibleLines == p.cachedScrollHeight && p.cachedScrollResult != "" {
		return p.cachedScrollResult
	}

	total := p.scrollback.Len()
	end := total - p.scrollOff
	if end < 0 {
		end = 0
	}
	start := end - visibleLines
	if start < 0 {
		start = 0
	}
	lines := p.scrollback.ReadRange(start, end)

	// Truncate lines to pane width to prevent overflow
	innerW := p.width - 2 // subtract border columns
	if innerW < 1 {
		innerW = 1
	}
	for i, line := range lines {
		if lipgloss.Width(line) > innerW {
			lines[i] = ansi.Truncate(line, innerW, "")
		}
	}

	result := strings.Join(lines, "\n")
	p.cachedScrollOff = p.scrollOff
	p.cachedScrollHeight = visibleLines
	p.cachedScrollResult = result
	return result
}


func keyMsgToBytes(msg tea.KeyMsg) []byte {
	// Alt modifier: prefix with ESC for common combos
	if msg.Alt {
		switch msg.Type {
		case tea.KeyBackspace:
			return []byte("\x1b\x7f") // Alt+Backspace = word delete
		case tea.KeyRunes:
			return append([]byte{0x1b}, []byte(string(msg.Runes))...)
		}
	}

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
	case tea.KeyCtrlU:
		return []byte("\x15") // kill entire line
	case tea.KeyCtrlK:
		return []byte("\x0b") // kill cursor to end of line
	case tea.KeyCtrlW:
		return []byte("\x17") // kill word backward
	case tea.KeyCtrlJ:
		return []byte("\n") // newline (Ctrl+J = LF)
	case tea.KeyDelete:
		return []byte("\x1b[3~")
	case tea.KeyHome:
		return []byte("\x1b[H")
	case tea.KeyEnd:
		return []byte("\x1b[F")
	case tea.KeyPgUp:
		return []byte("\x1b[5~")
	case tea.KeyPgDown:
		return []byte("\x1b[6~")
	case tea.KeyRunes:
		return []byte(string(msg.Runes))
	default:
		return nil
	}
}
