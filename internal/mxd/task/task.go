package task

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/renameio/v2"
	toml "github.com/pelletier/go-toml/v2"

	mxdconfig "github.com/kimaguri/simplx-toolkit/internal/mxd/config"
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

// Task represents a persisted mxd task.
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
	Name   string `toml:"name"`
	Branch string `toml:"branch"`
	Agent  string `toml:"agent"`
	Status string `toml:"status"`
	PRTest int    `toml:"pr_test"`
	PRMain int    `toml:"pr_main"`
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
	return filepath.Join(mxdconfig.GlobalConfigDir(), "tasks")
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

// AddRepo adds a repo to the task and saves.
func AddRepo(t *Task, repoName, branch, agent string) error {
	t.Repos = append(t.Repos, TaskRepo{
		Name:   repoName,
		Branch: branch,
		Agent:  agent,
		Status: RepoInProgress,
	})
	return Save(t)
}
