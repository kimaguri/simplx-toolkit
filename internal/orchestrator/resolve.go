package orchestrator

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
)

// ResolvedService is a service resolved from a ProjectConfig with its final
// mode after applying --local/--remote overrides.
type ResolvedService struct {
	Service string
	Mode    string
	Cfg     config.ServiceConfig
}

// ResolveModes computes the final Mode for every service in cfg, starting
// from each service's configured default Mode, then applying localOverrides
// (forcing Mode="local") followed by remoteOverrides (forcing Mode="remote").
//
// Overrides are applied in the order: localOverrides first, then
// remoteOverrides — so a service named in both ends up "remote". Names in
// either override list that do not match a known service are collected into
// the returned warnings slice and otherwise ignored (non-fatal).
//
// Resolved services are returned in stable order, sorted by service key.
func ResolveModes(cfg *config.ProjectConfig, localOverrides, remoteOverrides []string) ([]ResolvedService, []string) {
	modes := make(map[string]string, len(cfg.Services))
	for name, svc := range cfg.Services {
		modes[name] = svc.Mode
	}

	var warnings []string

	applyOverride := func(names []string, mode string) {
		for _, name := range names {
			if _, ok := cfg.Services[name]; !ok {
				warnings = append(warnings, fmt.Sprintf("unknown service override: %s", name))
				continue
			}
			modes[name] = mode
		}
	}

	applyOverride(localOverrides, "local")
	applyOverride(remoteOverrides, "remote")

	names := make([]string, 0, len(cfg.Services))
	for name := range cfg.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	resolved := make([]ResolvedService, 0, len(names))
	for _, name := range names {
		resolved = append(resolved, ResolvedService{
			Service: name,
			Mode:    modes[name],
			Cfg:     cfg.Services[name],
		})
	}

	return resolved, warnings
}

// worktreePorcelainEntry represents a single worktree entry parsed from
// `git worktree list --porcelain` output.
type worktreePorcelainEntry struct {
	Path   string
	Branch string
}

// parseWorktreePorcelain parses the output of `git worktree list --porcelain`
// into a slice of worktreePorcelainEntry. Detached worktrees (no "branch"
// line) get an empty Branch.
func parseWorktreePorcelain(output string) []worktreePorcelainEntry {
	var entries []worktreePorcelainEntry
	var current worktreePorcelainEntry
	hasCurrent := false

	flush := func() {
		if hasCurrent {
			entries = append(entries, current)
			current = worktreePorcelainEntry{}
			hasCurrent = false
		}
	}

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			flush()
			continue
		}
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			current.Path = strings.TrimPrefix(line, "worktree ")
			hasCurrent = true
		case strings.HasPrefix(line, "branch "):
			ref := strings.TrimPrefix(line, "branch ")
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
		}
	}
	flush()

	return entries
}

// FindWorktree runs `git worktree list --porcelain` in repoPath and returns
// the filesystem path of the worktree whose branch matches branch. ok is
// false if no worktree with that branch is found (or on error).
func FindWorktree(repoPath, branch string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "worktree", "list", "--porcelain")
	cmd.Dir = repoPath
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}

	entries := parseWorktreePorcelain(string(out))
	for _, e := range entries {
		if e.Branch == branch {
			return e.Path, true
		}
	}

	return "", false
}
