package repo

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// BranchName renders a branch name from a template and variable map.
func BranchName(template string, vars map[string]string) string {
	if template == "" {
		template = "{type}/{taskId}/{slug}"
	}
	result := template
	for k, v := range vars {
		result = strings.ReplaceAll(result, "{"+k+"}", v)
	}
	return result
}

// CreateWorktree creates a git worktree at wtDir with the given branch based on baseBranch.
func CreateWorktree(repoDir, wtDir, branch, baseBranch string) error {
	cmd := exec.Command("git", "worktree", "add", "-b", branch, wtDir, baseBranch)
	cmd.Dir = repoDir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git worktree add: %s: %w", out, err)
	}
	return nil
}

// RemoveWorktree removes a git worktree.
func RemoveWorktree(repoDir, wtDir string) error {
	cmd := exec.Command("git", "worktree", "remove", "--force", wtDir)
	cmd.Dir = repoDir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git worktree remove: %s: %w", out, err)
	}
	return nil
}

var taskDescRe = regexp.MustCompile(`^(fix|feat|refactor|chore|docs)\s+([a-zA-Z]+-\d+):\s*(.+)$`)
var taskDescNoIDRe = regexp.MustCompile(`^(fix|feat|refactor|chore|docs):\s*(.+)$`)

// ParseTaskDescription extracts type, taskId, and description text from a task description.
func ParseTaskDescription(desc string) (taskType, taskID, text string) {
	desc = strings.TrimSpace(desc)
	if m := taskDescRe.FindStringSubmatch(desc); m != nil {
		return m[1], m[2], strings.TrimSpace(m[3])
	}
	if m := taskDescNoIDRe.FindStringSubmatch(desc); m != nil {
		return m[1], "", strings.TrimSpace(m[2])
	}
	return "", "", desc
}

// Slugify converts text to a URL-safe slug.
func Slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	re := regexp.MustCompile(`[^a-z0-9-]+`)
	s = re.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 40 {
		s = s[:40]
		s = strings.TrimRight(s, "-")
	}
	return s
}
