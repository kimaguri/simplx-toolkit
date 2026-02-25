package tui

import (
	"context"
	"os/exec"
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
