package hooks

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// HookEnv holds environment variables passed to hook scripts.
type HookEnv struct {
	TaskID      string
	RepoName    string
	WorktreeDir string
	Branch      string
}

// HookResult holds the outcome of a hook execution.
type HookResult struct {
	Hook     string
	Command  string
	Output   string
	ExitCode int
	Err      error
	Duration time.Duration
}

// Run executes a hook command with the given environment variables.
// Returns nil result if the command string is empty (no hook configured).
// Timeout: 30 seconds per hook.
func Run(hookName, command string, env HookEnv) *HookResult {
	if strings.TrimSpace(command) == "" {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", command)

	// Set working directory to worktree if available
	if env.WorktreeDir != "" {
		cmd.Dir = env.WorktreeDir
	}

	// Inject environment variables
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("MAOMAO_TASK_ID=%s", env.TaskID),
		fmt.Sprintf("MAOMAO_REPO_NAME=%s", env.RepoName),
		fmt.Sprintf("MAOMAO_WORKTREE_DIR=%s", env.WorktreeDir),
		fmt.Sprintf("MAOMAO_BRANCH=%s", env.Branch),
		fmt.Sprintf("MAOMAO_HOOK=%s", hookName),
	)

	start := time.Now()
	output, err := cmd.CombinedOutput()
	duration := time.Since(start)

	result := &HookResult{
		Hook:     hookName,
		Command:  command,
		Output:   strings.TrimSpace(string(output)),
		Duration: duration,
	}

	if err != nil {
		result.Err = err
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
	}

	return result
}

// RunAll executes the same hook for multiple repos (e.g., on_task_park for all repos in a task).
// Returns results for each execution. Skips empty commands.
func RunAll(hookName, command string, envs []HookEnv) []*HookResult {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	var results []*HookResult
	for _, env := range envs {
		result := Run(hookName, command, env)
		if result != nil {
			results = append(results, result)
		}
	}
	return results
}
