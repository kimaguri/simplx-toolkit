package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
)

func TestWriteContext(t *testing.T) {
	dir := t.TempDir()

	params := ContextParams{
		RepoName:   "platform",
		TaskID:     "HELPD-58",
		TaskType:   "fix",
		TaskTitle:  "api filter endpoint",
		TaskStatus: "active",
		Branch:     "fix/HELPD-58/api-filter-endpoint",
		AllRepos: []task.TaskRepo{
			{Name: "platform", Status: "in_progress"},
			{Name: "simplx-core", Status: "in_progress"},
		},
		WorktreeDir: dir,
	}

	if err := WriteContext(params); err != nil {
		t.Fatalf("WriteContext: %v", err)
	}

	// Check AGENT.md exists and contains expected content
	agentMD, err := os.ReadFile(filepath.Join(dir, ".maomao", "AGENT.md"))
	if err != nil {
		t.Fatalf("read AGENT.md: %v", err)
	}
	content := string(agentMD)
	for _, want := range []string{"platform", "HELPD-58", "fix", "api filter endpoint", "simplx-core", "← you are here"} {
		if !strings.Contains(content, want) {
			t.Errorf("AGENT.md missing %q", want)
		}
	}

	// Check CLAUDE.md augmented
	claudeMD, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("read CLAUDE.md: %v", err)
	}
	if !strings.Contains(string(claudeMD), claudeMDMarker) {
		t.Error("CLAUDE.md missing augmentation")
	}

	// Idempotent: call again, should not duplicate
	if err := WriteContext(params); err != nil {
		t.Fatalf("WriteContext (2nd): %v", err)
	}
	claudeMD2, _ := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	count := strings.Count(string(claudeMD2), claudeMDMarker)
	if count != 1 {
		t.Errorf("CLAUDE.md augmentation duplicated: found %d times", count)
	}
}

func TestWriteContextExistingClaudeMD(t *testing.T) {
	dir := t.TempDir()
	existing := "# My Project\nSome rules here.\n"
	os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(existing), 0o644)

	params := ContextParams{
		RepoName:    "platform",
		TaskID:      "T-1",
		TaskType:    "feat",
		TaskTitle:   "test",
		Branch:      "feat/T-1/test",
		AllRepos:    []task.TaskRepo{{Name: "platform", Status: "in_progress"}},
		WorktreeDir: dir,
	}

	if err := WriteContext(params); err != nil {
		t.Fatalf("WriteContext: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	content := string(data)
	if !strings.HasPrefix(content, existing) {
		t.Error("existing CLAUDE.md content was overwritten")
	}
	if !strings.Contains(content, claudeMDMarker) {
		t.Error("augmentation not appended")
	}
}
