package tui

import "testing"

func TestParseGitStatus(t *testing.T) {
	input := " M file1.go\n?? file2.go\nA  file3.go\nD  file4.go\n"
	s := parseGitStatusOutput(input)
	if s.Modified != 1 {
		t.Errorf("expected 1 modified, got %d", s.Modified)
	}
	if s.Untracked != 1 {
		t.Errorf("expected 1 untracked, got %d", s.Untracked)
	}
	if s.Added != 1 {
		t.Errorf("expected 1 added, got %d", s.Added)
	}
	if s.Deleted != 1 {
		t.Errorf("expected 1 deleted, got %d", s.Deleted)
	}
}

func TestGitStatusLabel(t *testing.T) {
	s := gitStatus{Modified: 3, Added: 1}
	label := s.Label()
	if label == "" {
		t.Error("expected non-empty label")
	}
	// Clean status
	clean := gitStatus{}
	if clean.Label() != "clean" {
		t.Errorf("expected 'clean', got %q", clean.Label())
	}
}
