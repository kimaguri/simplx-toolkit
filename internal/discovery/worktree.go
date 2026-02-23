package discovery

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Worktree represents a git repository found within a scan directory
type Worktree struct {
	Name         string    // display name, e.g. "simplx-apps-feature/main" or "platform"
	Path         string    // absolute path to the worktree
	Branch       string    // current git branch
	LastModified time.Time // last commit timestamp (for sorting)
	IsWorktree   bool      // true if this is a git worktree (not a main repo)
	MainProject  string    // name of the parent project (only for worktrees)
}

// ScanWorktrees discovers git repositories within the given scan directories.
// Scans up to 2 levels deep. For each scan dir:
//   - Scans children recursively for directories containing .git
//   - If the scan dir itself is a git repo but contains no child git repos,
//     it is treated as a standalone worktree
//   - If the scan dir is a git repo AND contains child git repos (monorepo root),
//     only the children are added (the root is skipped)
func ScanWorktrees(scanDirs []string) []Worktree {
	var worktrees []Worktree
	seen := make(map[string]bool)

	for _, scanDir := range scanDirs {
		scanDir = expandHome(scanDir)

		absPath, _ := filepath.Abs(scanDir)
		if absPath == "" {
			absPath = scanDir
		}

		info, err := os.Stat(absPath)
		if err != nil || !info.IsDir() {
			continue
		}

		// Scan children recursively for git repos (up to depth 2)
		beforeCount := len(worktrees)
		collectGitRepos(absPath, "", &worktrees, seen, 0, 2)

		// If nothing found inside AND the dir itself is a git repo, add it as a standalone worktree
		if len(worktrees) == beforeCount && isGitRepo(absPath) && !seen[absPath] {
			seen[absPath] = true
			wt := Worktree{
				Name:         filepath.Base(absPath),
				Path:         absPath,
				Branch:       detectBranch(absPath),
				LastModified: detectLastCommit(absPath),
			}
			wt.IsWorktree, wt.MainProject = detectWorktreeInfo(absPath)
			worktrees = append(worktrees, wt)
		}
	}

	// Second pass: discover linked worktrees via git for each main repo
	for _, wt := range worktrees {
		if !wt.IsWorktree {
			linked := discoverLinkedWorktrees(wt.Path, seen)
			worktrees = append(worktrees, linked...)
		}
	}

	// Sort by last modification: most recently modified first
	sort.Slice(worktrees, func(i, j int) bool {
		return worktrees[i].LastModified.After(worktrees[j].LastModified)
	})

	return worktrees
}

// collectGitRepos recursively scans for directories containing .git
func collectGitRepos(dir, prefix string, worktrees *[]Worktree, seen map[string]bool, depth, maxDepth int) {
	if depth > maxDepth {
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" {
			continue
		}

		childPath := filepath.Join(dir, name)
		absPath, _ := filepath.Abs(childPath)
		if absPath == "" {
			absPath = childPath
		}

		displayName := name
		if prefix != "" {
			displayName = prefix + "/" + name
		}

		if isGitRepo(absPath) {
			if !seen[absPath] {
				seen[absPath] = true
				wt := Worktree{
					Name:         displayName,
					Path:         absPath,
					Branch:       detectBranch(absPath),
					LastModified: detectLastCommit(absPath),
				}
				wt.IsWorktree, wt.MainProject = detectWorktreeInfo(absPath)
				*worktrees = append(*worktrees, wt)
			}
			continue // don't recurse into git repos
		}

		// Not a git repo — recurse deeper
		collectGitRepos(absPath, displayName, worktrees, seen, depth+1, maxDepth)
	}
}

// isGitRepo checks if a directory contains .git (file or directory)
func isGitRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// detectBranch runs "git branch --show-current" to get the current branch
func detectBranch(dir string) string {
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	branch := strings.TrimSpace(string(out))
	if branch == "" {
		return "detached"
	}
	return branch
}

// detectWorktreeInfo checks if the directory is a git worktree (not a main repo).
// Git worktrees have a .git FILE (not directory) containing "gitdir: /path/to/main/.git/worktrees/name".
// Returns (isWorktree, mainProjectName).
func detectWorktreeInfo(dir string) (bool, string) {
	gitPath := filepath.Join(dir, ".git")
	info, err := os.Stat(gitPath)
	if err != nil {
		return false, ""
	}
	// Main repos have .git as a directory
	if info.IsDir() {
		return false, ""
	}
	// Git worktrees have .git as a file
	data, err := os.ReadFile(gitPath)
	if err != nil {
		return true, ""
	}
	line := strings.TrimSpace(string(data))
	if !strings.HasPrefix(line, "gitdir:") {
		return true, ""
	}
	// Parse: "gitdir: /path/to/main-repo/.git/worktrees/branch-name"
	gitdir := strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
	// Walk up to find .git directory → parent is the main project
	parts := strings.Split(filepath.ToSlash(gitdir), "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == ".git" && i > 0 {
			return true, parts[i-1]
		}
	}
	return true, ""
}

// detectLastCommit gets the timestamp of the most recent commit in the repo
func detectLastCommit(dir string) time.Time {
	cmd := exec.Command("git", "log", "-1", "--format=%ct")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return time.Time{}
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(ts, 0)
}

// worktreeListEntry represents a single entry from `git worktree list --porcelain` output
type worktreeListEntry struct {
	Path   string
	Branch string
}

// parseWorktreeListOutput parses the output of `git worktree list --porcelain`
// into a slice of worktreeListEntry structs.
func parseWorktreeListOutput(output string) []worktreeListEntry {
	var entries []worktreeListEntry
	var current worktreeListEntry

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			if current.Path != "" {
				entries = append(entries, current)
				current = worktreeListEntry{}
			}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			current.Path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "branch ") {
			ref := strings.TrimPrefix(line, "branch ")
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
		}
	}
	if current.Path != "" {
		entries = append(entries, current)
	}
	return entries
}

// discoverLinkedWorktrees runs `git worktree list --porcelain` on a main repo
// and returns Worktree entries for any worktrees NOT already in the seen set.
func discoverLinkedWorktrees(mainRepoPath string, seen map[string]bool) []Worktree {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "worktree", "list", "--porcelain")
	cmd.Dir = mainRepoPath
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	entries := parseWorktreeListOutput(string(out))
	var result []Worktree
	for _, e := range entries {
		if seen[e.Path] || e.Path == mainRepoPath {
			continue
		}
		seen[e.Path] = true
		wt := Worktree{
			Name:         filepath.Base(e.Path),
			Path:         e.Path,
			Branch:       e.Branch,
			LastModified: detectLastCommit(e.Path),
			IsWorktree:   true,
			MainProject:  filepath.Base(mainRepoPath),
		}
		result = append(result, wt)
	}
	return result
}

// expandHome expands ~ to user home directory
func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}
