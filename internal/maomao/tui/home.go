package tui

import "github.com/charmbracelet/lipgloss"

// maomao color palette (shared across all TUI views)
var (
	catGreen    = lipgloss.Color("#00FF00")
	catRed      = lipgloss.Color("#FF4444")
	catYellow   = lipgloss.Color("#FFAA00")
	catBlue     = lipgloss.Color("#5599FF")
	catGray     = lipgloss.Color("#666666")
	catWhite    = lipgloss.Color("#FFFFFF")
	catDimWhite = lipgloss.Color("#AAAAAA")
	catBg       = lipgloss.Color("#1A1A2E")
	catModalBg  = lipgloss.Color("#16213E")
)

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
	ID        string
	Type      string
	Title     string
	Status    string
	Active    bool
	Repos     int
	RepoNames []string // repo names for display
}
