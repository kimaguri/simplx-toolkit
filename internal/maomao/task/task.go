package task

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/renameio/v2"
	toml "github.com/pelletier/go-toml/v2"

	maomaoconfig "github.com/kimaguri/simplx-toolkit/internal/maomao/config"
)

const (
	StatusActive = "active"
	StatusParked = "parked"
	StatusReview = "review"
	StatusDone   = "done"

	RepoInProgress = "in_progress"
	RepoParked     = "parked"
	RepoDone       = "done"
)

// Task represents a persisted maomao task.
type Task struct {
	ID      string     `toml:"id"`
	Type    string     `toml:"type"`
	Title   string     `toml:"title"`
	Status  string     `toml:"status"`
	Created time.Time  `toml:"created"`
	Repos   []TaskRepo `toml:"repos"`
}

// TaskRepo tracks per-repo state within a task.
type TaskRepo struct {
	Name        string `toml:"name"`
	Path        string `toml:"path"`         // absolute path to main repo
	Branch      string `toml:"branch"`
	WorktreeDir string `toml:"worktree_dir"` // absolute path to worktree
	Agent       string `toml:"agent"`
	SessionID   string `toml:"session_id"`   // agent session ID for resume
	Status      string `toml:"status"`
	PRTest      int    `toml:"pr_test"`
	PRMain      int    `toml:"pr_main"`
}

// taskFile wraps Task for TOML serialization with [task] section.
type taskFile struct {
	Task Task `toml:"task"`
}

// tasksDir is the base directory for task storage.
// Overridable in tests.
var tasksDir = ""

func getTasksDir() string {
	if tasksDir != "" {
		return tasksDir
	}
	return filepath.Join(maomaoconfig.GlobalConfigDir(), "tasks")
}

// TaskDir returns the directory for a specific task.
func TaskDir(id string) string {
	return filepath.Join(getTasksDir(), id)
}

// Save writes task.toml atomically.
func Save(t *Task) error {
	dir := TaskDir(t.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create task dir: %w", err)
	}

	data, err := toml.Marshal(taskFile{Task: *t})
	if err != nil {
		return fmt.Errorf("marshal task: %w", err)
	}

	path := filepath.Join(dir, "task.toml")
	if err := renameio.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write task.toml: %w", err)
	}
	return nil
}

// Load reads a task from disk.
func Load(id string) (*Task, error) {
	path := filepath.Join(TaskDir(id), "task.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read task %q: %w", id, err)
	}
	var f taskFile
	if err := toml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse task %q: %w", id, err)
	}
	return &f.Task, nil
}

// List returns all tasks.
func List() ([]*Task, error) {
	dir := getTasksDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read tasks dir: %w", err)
	}

	var tasks []*Task
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		t, err := Load(e.Name())
		if err != nil {
			continue // skip corrupt tasks
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

// SaveAgentLog writes the agent's log buffer content to the task dir.
func SaveAgentLog(taskID, repoName string, content []byte) error {
	dir := filepath.Join(TaskDir(taskID), "repos", repoName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create agent log dir: %w", err)
	}
	return os.WriteFile(filepath.Join(dir, "agent.log"), content, 0o644)
}

// AddRepo adds a repo to the task and saves.
func AddRepo(t *Task, name, path, branch, wtDir, agentName string) error {
	t.Repos = append(t.Repos, TaskRepo{
		Name:        name,
		Path:        path,
		Branch:      branch,
		WorktreeDir: wtDir,
		Agent:       agentName,
		Status:      RepoInProgress,
	})
	return Save(t)
}

// Delete removes a task and its directory from disk.
func Delete(id string) error {
	dir := TaskDir(id)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("delete task %q: %w", id, err)
	}
	return nil
}
