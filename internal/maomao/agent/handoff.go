package agent

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Handoff represents a cross-repo handoff request from an agent.
type Handoff struct {
	SourceRepo string
	TargetRepo string
	Priority   string
	Content    string
	FilePath   string
}

var (
	targetRe   = regexp.MustCompile(`(?m)^Target:\s*(.+)$`)
	priorityRe = regexp.MustCompile(`(?m)^Priority:\s*(.+)$`)
)

// ParseHandoff reads and parses a handoff.md file.
func ParseHandoff(filePath, sourceRepo string) (*Handoff, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	content := string(data)
	h := &Handoff{
		SourceRepo: sourceRepo,
		Content:    content,
		FilePath:   filePath,
	}

	if m := targetRe.FindStringSubmatch(content); len(m) > 1 {
		h.TargetRepo = strings.TrimSpace(m[1])
	}
	if m := priorityRe.FindStringSubmatch(content); len(m) > 1 {
		h.Priority = strings.TrimSpace(m[1])
	}

	return h, nil
}

// ScanWorktrees checks all worktree directories for undelivered handoff.md files.
func ScanWorktrees(worktrees map[string]string) []Handoff {
	var handoffs []Handoff
	for repoName, wtDir := range worktrees {
		handoffPath := filepath.Join(wtDir, ".maomao", "handoff.md")
		if _, err := os.Stat(handoffPath); err != nil {
			continue
		}
		h, err := ParseHandoff(handoffPath, repoName)
		if err != nil {
			continue
		}
		handoffs = append(handoffs, *h)
	}
	return handoffs
}

// MarkDelivered renames handoff.md to handoff.md.delivered.
func MarkDelivered(filePath string) error {
	return os.Rename(filePath, filePath+".delivered")
}
