package tui

// RepoEntry represents a discovered git repo.
type RepoEntry struct {
	Name        string
	Path        string
	Branch      string
	IsWorktree  bool   // true if git worktree (not main repo)
	MainProject string // parent project name (only for worktrees)
}

// TaskEntry represents a persisted task.
type TaskEntry struct {
	ID           string
	Type         string
	Title        string
	Status       string
	Active       bool
	Repos        int
	RepoNames    []string // repo names for display
	ActiveTime   string   // formatted active time (e.g. "2h 47m")
	TodayTime    string   // formatted today time (e.g. "1h 12m")
	SessionCount int      // number of sessions
}
