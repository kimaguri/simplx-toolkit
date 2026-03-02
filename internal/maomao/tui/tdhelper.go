package tui

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// tdStatusResultMsg carries async td status results back to the Update loop.
type tdStatusResultMsg struct {
	content string
}

// fetchTdStatusCmd returns a tea.Cmd that fetches td status asynchronously.
func fetchTdStatusCmd(dir string) tea.Cmd {
	return func() tea.Msg {
		return tdStatusResultMsg{content: fetchTdStatus(dir)}
	}
}

// fetchTdStatus runs `td status` in the given directory and returns the output.
func fetchTdStatus(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "td", "status")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "(td not available)"
	}
	return string(out)
}

// tdTaskSummary holds parsed TD task status counts.
type tdTaskSummary struct {
	Open       int
	InProgress int
	InReview   int
	Closed     int
	Total      int
}

// tdSummaryResultMsg carries parsed TD summary back to Update loop.
type tdSummaryResultMsg struct {
	summary *tdTaskSummary
	taskID  string // which task this summary belongs to
}

// fetchTdSummaryCmd runs td status and parses it asynchronously.
func fetchTdSummaryCmd(dir, taskID string) tea.Cmd {
	return func() tea.Msg {
		output := fetchTdStatus(dir)
		return tdSummaryResultMsg{
			summary: parseTdSummary(output),
			taskID:  taskID,
		}
	}
}

// parseTdSummary extracts task counts from td status output.
// Parses lines like "  open: 3" or "  in_progress: 2".
// Returns nil if parsing fails or td is not available.
func parseTdSummary(output string) *tdTaskSummary {
	if output == "" || strings.Contains(output, "not available") {
		return nil
	}

	summary := &tdTaskSummary{}
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)

		if !strings.Contains(line, ":") {
			continue
		}

		// Try key: value format (e.g., "open: 3", "in_progress: 2")
		if strings.Contains(lower, "open") &&
			!strings.Contains(lower, "in_progress") &&
			!strings.Contains(lower, "in progress") {
			fmt.Sscanf(extractNumber(line), "%d", &summary.Open)
		}
		if strings.Contains(lower, "in_progress") ||
			strings.Contains(lower, "in progress") {
			fmt.Sscanf(extractNumber(line), "%d", &summary.InProgress)
		}
		if (strings.Contains(lower, "in_review") ||
			strings.Contains(lower, "in review") ||
			strings.Contains(lower, "review")) &&
			!strings.Contains(lower, "in_progress") {
			fmt.Sscanf(extractNumber(line), "%d", &summary.InReview)
		}
		if strings.Contains(lower, "closed") ||
			strings.Contains(lower, "done") ||
			strings.Contains(lower, "completed") {
			fmt.Sscanf(extractNumber(line), "%d", &summary.Closed)
		}
	}

	summary.Total = summary.Open + summary.InProgress +
		summary.InReview + summary.Closed
	return summary
}

// extractNumber pulls the first number from a string.
func extractNumber(s string) string {
	var num string
	inNum := false
	for _, c := range s {
		if c >= '0' && c <= '9' {
			num += string(c)
			inNum = true
		} else if inNum {
			break
		}
	}
	return num
}

// Label formats the summary for sidebar display.
func (ts *tdTaskSummary) Label() string {
	if ts == nil || ts.Total == 0 {
		return ""
	}
	parts := []string{}
	done := ts.Closed
	if done > 0 {
		parts = append(parts, fmt.Sprintf("%d done", done))
	}
	if ts.InProgress > 0 {
		parts = append(parts, fmt.Sprintf("%d active", ts.InProgress))
	}
	if ts.InReview > 0 {
		parts = append(parts, fmt.Sprintf("%d review", ts.InReview))
	}
	if ts.Open > 0 {
		parts = append(parts, fmt.Sprintf("%d open", ts.Open))
	}
	return fmt.Sprintf("%d/%d done | %s",
		done, ts.Total, strings.Join(parts, " · "))
}
