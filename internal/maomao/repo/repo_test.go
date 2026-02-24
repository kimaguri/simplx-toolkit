package repo

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func initTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
	}
	for _, c := range cmds {
		cmd := exec.Command(c[0], c[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %s", c, out)
		}
	}
	f := filepath.Join(dir, "README.md")
	os.WriteFile(f, []byte("# test"), 0o644)
	cmd := exec.Command("git", "add", ".")
	cmd.Dir = dir
	cmd.Run()
	cmd = exec.Command("git", "commit", "-m", "init")
	cmd.Dir = dir
	cmd.Run()
	return dir
}

func TestBranchName(t *testing.T) {
	tests := []struct {
		template string
		vars     map[string]string
		want     string
	}{
		{
			template: "{type}/{taskId}/{slug}",
			vars:     map[string]string{"type": "fix", "taskId": "helpd-58", "slug": "add-validation"},
			want:     "fix/helpd-58/add-validation",
		},
		{
			template: "{type}/{taskId}/{repo}-{slug}",
			vars:     map[string]string{"type": "feat", "taskId": "helpd-99", "repo": "platform", "slug": "new-feature"},
			want:     "feat/helpd-99/platform-new-feature",
		},
		{
			template: "",
			vars:     map[string]string{"type": "fix", "taskId": "helpd-58", "slug": "test"},
			want:     "fix/helpd-58/test",
		},
		{
			template: "{type}/{taskId}/{slug}",
			vars:     map[string]string{"type": "fix", "taskId": "", "slug": "fix-task-1-asa"},
			want:     "fix/fix-task-1-asa",
		},
	}
	for _, tt := range tests {
		got := BranchName(tt.template, tt.vars)
		if got != tt.want {
			t.Errorf("BranchName(%q, %v) = %q, want %q", tt.template, tt.vars, got, tt.want)
		}
	}
}

func TestCreateAndRemoveWorktree(t *testing.T) {
	repoDir := initTestRepo(t)

	wtDir := filepath.Join(repoDir, ".worktrees", "test-wt")
	branch := "fix/helpd-58/test"

	err := CreateWorktree(repoDir, wtDir, branch, "main")
	if err != nil {
		t.Fatalf("CreateWorktree: %v", err)
	}

	if _, err := os.Stat(wtDir); os.IsNotExist(err) {
		t.Fatal("worktree directory not created")
	}

	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = wtDir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git branch: %v", err)
	}
	got := string(out)
	if got != branch+"\n" {
		t.Errorf("branch = %q, want %q", got, branch)
	}

	err = RemoveWorktree(repoDir, wtDir)
	if err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}
	if _, err := os.Stat(wtDir); !os.IsNotExist(err) {
		t.Error("worktree directory still exists after removal")
	}
}

func TestParseTaskDescription(t *testing.T) {
	tests := []struct {
		desc     string
		wantType string
		wantID   string
		wantText string
	}{
		{"fix helpd-58: фильтрация не работает", "fix", "helpd-58", "фильтрация не работает"},
		{"feat helpd-99: new feature", "feat", "helpd-99", "new feature"},
		{"refactor: clean up code", "refactor", "", "clean up code"},
		{"just some task", "", "", "just some task"},
	}
	for _, tt := range tests {
		typ, id, text := ParseTaskDescription(tt.desc)
		if typ != tt.wantType {
			t.Errorf("ParseTaskDescription(%q) type = %q, want %q", tt.desc, typ, tt.wantType)
		}
		if id != tt.wantID {
			t.Errorf("ParseTaskDescription(%q) id = %q, want %q", tt.desc, id, tt.wantID)
		}
		if text != tt.wantText {
			t.Errorf("ParseTaskDescription(%q) text = %q, want %q", tt.desc, text, tt.wantText)
		}
	}
}
