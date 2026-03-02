package hooks

import (
	"testing"
)

func TestRunEmptyCommand(t *testing.T) {
	result := Run("test", "", HookEnv{TaskID: "t1"})
	if result != nil {
		t.Error("expected nil result for empty command")
	}
}

func TestRunSimpleCommand(t *testing.T) {
	result := Run("test", "echo hello", HookEnv{TaskID: "t1", RepoName: "repo1"})
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if result.Output != "hello" {
		t.Errorf("expected output 'hello', got %q", result.Output)
	}
	if result.Hook != "test" {
		t.Errorf("expected hook 'test', got %q", result.Hook)
	}
}

func TestRunWithEnvVars(t *testing.T) {
	result := Run("test", "echo $MAOMAO_TASK_ID:$MAOMAO_REPO_NAME", HookEnv{
		TaskID:   "myTask",
		RepoName: "myRepo",
	})
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Output != "myTask:myRepo" {
		t.Errorf("expected 'myTask:myRepo', got %q", result.Output)
	}
}

func TestRunFailingCommand(t *testing.T) {
	result := Run("test", "exit 1", HookEnv{})
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.ExitCode != 1 {
		t.Errorf("expected exit code 1, got %d", result.ExitCode)
	}
}

func TestRunAllEmpty(t *testing.T) {
	results := RunAll("test", "", []HookEnv{{TaskID: "t1"}})
	if results != nil {
		t.Error("expected nil results for empty command")
	}
}

func TestRunAllMultiple(t *testing.T) {
	envs := []HookEnv{
		{TaskID: "t1", RepoName: "r1"},
		{TaskID: "t1", RepoName: "r2"},
	}
	results := RunAll("test", "echo $MAOMAO_REPO_NAME", envs)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Output != "r1" {
		t.Errorf("expected 'r1', got %q", results[0].Output)
	}
	if results[1].Output != "r2" {
		t.Errorf("expected 'r2', got %q", results[1].Output)
	}
}
