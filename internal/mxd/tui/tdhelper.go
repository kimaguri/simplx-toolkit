package tui

import (
	"context"
	"os/exec"
	"time"
)

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
