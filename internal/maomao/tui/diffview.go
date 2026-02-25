package tui

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// diffOverlayModel shows git diff output as a scrollable overlay.
type diffOverlayModel struct {
	content     string   // raw git diff output
	lines       []string // split and colored lines
	scrollOff   int
	width       int
	height      int
	worktreeDir string
	paneName    string // which pane this diff belongs to
}

// diffResultMsg carries async git diff output.
type diffResultMsg struct {
	content  string
	paneName string
}

// fetchDiffCmd runs git diff asynchronously for a worktree directory.
func fetchDiffCmd(dir, paneName string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "diff", "--color=never")
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			// Also try staged diff
			cmd2 := exec.CommandContext(ctx, "git", "diff", "--staged", "--color=never")
			cmd2.Dir = dir
			out2, _ := cmd2.Output()
			if len(out2) > 0 {
				return diffResultMsg{content: "(staged)\n" + string(out2), paneName: paneName}
			}
			return diffResultMsg{content: "(no changes)", paneName: paneName}
		}
		result := string(out)
		if strings.TrimSpace(result) == "" {
			// Try staged
			cmd2 := exec.CommandContext(ctx, "git", "diff", "--staged", "--color=never")
			cmd2.Dir = dir
			out2, _ := cmd2.Output()
			if len(out2) > 0 {
				result = "(staged)\n" + string(out2)
			} else {
				result = "(no changes)"
			}
		}
		return diffResultMsg{content: result, paneName: paneName}
	}
}

// newDiffOverlay creates a diff overlay model.
func newDiffOverlay(content, worktreeDir, paneName string, width, height int) diffOverlayModel {
	lines := colorizeDiff(content)
	return diffOverlayModel{
		content:     content,
		lines:       lines,
		worktreeDir: worktreeDir,
		paneName:    paneName,
		width:       width,
		height:      height,
	}
}

// colorizeDiff applies syntax coloring to diff output lines.
func colorizeDiff(content string) []string {
	rawLines := strings.Split(content, "\n")
	addSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#9ece6a"))             // green
	delSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#f7768e"))             // red
	hdrSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#7dcfff")).Bold(true)  // cyan bold
	hunkSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#bb9af7"))            // purple
	dimSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89"))             // dim

	var result []string
	for _, line := range rawLines {
		switch {
		case strings.HasPrefix(line, "diff --git"):
			result = append(result, hdrSt.Render(line))
		case strings.HasPrefix(line, "index "):
			result = append(result, dimSt.Render(line))
		case strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ "):
			result = append(result, hdrSt.Render(line))
		case strings.HasPrefix(line, "@@"):
			result = append(result, hunkSt.Render(line))
		case strings.HasPrefix(line, "+"):
			result = append(result, addSt.Render(line))
		case strings.HasPrefix(line, "-"):
			result = append(result, delSt.Render(line))
		default:
			result = append(result, line)
		}
	}
	return result
}

// View renders the diff overlay as a centered box.
func (d diffOverlayModel) View(screenW, screenH int) string {
	boxW := screenW - 10
	if boxW < 40 {
		boxW = 40
	}
	if boxW > screenW-4 {
		boxW = screenW - 4
	}
	boxH := screenH - 6
	if boxH < 10 {
		boxH = 10
	}

	innerH := boxH - 4 // padding + border
	innerW := boxW - 6

	// Header
	headerSt := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7dcfff"))
	dimSt := lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89"))
	header := headerSt.Render("Diff: "+d.paneName) + "  " + dimSt.Render("j/k scroll  q close")

	// Visible lines with scroll
	visibleLines := d.lines
	if d.scrollOff < len(visibleLines) {
		visibleLines = visibleLines[d.scrollOff:]
	}
	if len(visibleLines) > innerH {
		visibleLines = visibleLines[:innerH]
	}

	// Truncate long lines
	var truncated []string
	for _, line := range visibleLines {
		if lipgloss.Width(line) > innerW {
			// Simple truncation — cut raw string (may break ANSI, but acceptable)
			if len(line) > innerW+20 { // +20 for ANSI escape overhead
				line = line[:innerW+20] + "..."
			}
		}
		truncated = append(truncated, line)
	}

	// Scroll indicator
	scrollInfo := ""
	if len(d.lines) > innerH {
		pct := 0
		if len(d.lines)-innerH > 0 {
			pct = d.scrollOff * 100 / (len(d.lines) - innerH)
		}
		if pct > 100 {
			pct = 100
		}
		scrollInfo = dimSt.Render(" (" + fmt.Sprintf("%d%%", pct) + ")")
	}

	body := strings.Join(truncated, "\n")
	content := header + scrollInfo + "\n\n" + body

	box := lipgloss.NewStyle().
		Width(boxW).
		MaxHeight(boxH).
		Padding(1, 2).
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#7dcfff")).
		Render(content)

	return lipgloss.Place(screenW, screenH, lipgloss.Center, lipgloss.Center, box)
}
