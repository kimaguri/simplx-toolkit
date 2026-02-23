package discovery

import (
	"testing"
)

func TestParseWorktreeListOutput(t *testing.T) {
	input := `worktree /Users/me/project
HEAD abc123
branch refs/heads/main

worktree /Users/me/.claude/worktrees/feat-1
HEAD def456
branch refs/heads/feature/one

`
	wts := parseWorktreeListOutput(input)
	if len(wts) != 2 {
		t.Fatalf("expected 2 worktrees, got %d", len(wts))
	}
	if wts[0].Path != "/Users/me/project" {
		t.Errorf("expected project path, got %s", wts[0].Path)
	}
	if wts[0].Branch != "main" {
		t.Errorf("expected main branch, got %s", wts[0].Branch)
	}
	if wts[1].Path != "/Users/me/.claude/worktrees/feat-1" {
		t.Errorf("expected worktree path, got %s", wts[1].Path)
	}
	if wts[1].Branch != "feature/one" {
		t.Errorf("expected feature/one, got %s", wts[1].Branch)
	}
}

func TestParseWorktreeListOutput_EmptyInput(t *testing.T) {
	wts := parseWorktreeListOutput("")
	if len(wts) != 0 {
		t.Fatalf("expected 0 worktrees for empty input, got %d", len(wts))
	}
}

func TestParseWorktreeListOutput_DetachedHead(t *testing.T) {
	input := `worktree /Users/me/project
HEAD abc123
detached

`
	wts := parseWorktreeListOutput(input)
	if len(wts) != 1 {
		t.Fatalf("expected 1 worktree, got %d", len(wts))
	}
	if wts[0].Path != "/Users/me/project" {
		t.Errorf("expected project path, got %s", wts[0].Path)
	}
	if wts[0].Branch != "" {
		t.Errorf("expected empty branch for detached HEAD, got %s", wts[0].Branch)
	}
}
