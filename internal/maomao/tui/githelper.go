package tui

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type gitStatus struct {
	Modified  int
	Added     int
	Deleted   int
	Untracked int
}

// Label returns a compact status string like "M:3 A:1" or "clean"
func (s gitStatus) Label() string {
	if s.Modified+s.Added+s.Deleted+s.Untracked == 0 {
		return "clean"
	}
	var parts []string
	if s.Modified > 0 {
		parts = append(parts, fmt.Sprintf("M:%d", s.Modified))
	}
	if s.Added > 0 {
		parts = append(parts, fmt.Sprintf("A:%d", s.Added))
	}
	if s.Deleted > 0 {
		parts = append(parts, fmt.Sprintf("D:%d", s.Deleted))
	}
	if s.Untracked > 0 {
		parts = append(parts, fmt.Sprintf("?:%d", s.Untracked))
	}
	return strings.Join(parts, " ")
}

func parseGitStatusOutput(output string) gitStatus {
	var s gitStatus
	for _, line := range strings.Split(output, "\n") {
		if len(line) < 2 {
			continue
		}
		xy := line[:2]
		switch {
		case xy[0] == '?' || xy[1] == '?':
			s.Untracked++
		case xy[0] == 'A' || xy[1] == 'A':
			s.Added++
		case xy[0] == 'D' || xy[1] == 'D':
			s.Deleted++
		case xy[0] == 'M' || xy[1] == 'M':
			s.Modified++
		}
	}
	return s
}

// fetchGitStatus runs `git status --porcelain` in the given directory.
func fetchGitStatus(dir string) gitStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return gitStatus{}
	}
	return parseGitStatusOutput(string(out))
}
