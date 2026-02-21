package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	statusStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	helpStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	repoStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
)

// statusMsg is a custom message type for temporary status messages.
type statusMsg string

// TaskInfo holds the current task state for display.
type TaskInfo struct {
	Description string
	TaskType    string
	TaskID      string
	Mode        string // "supervised" or "autonomous"
	Repos       []RepoInfo
}

// RepoInfo holds per-repo status.
type RepoInfo struct {
	Name        string
	Branch      string
	AgentName   string
	Status      string // "running", "idle", "in_progress", "stopped"
	WorktreeDir string
}

// App is the root Bubbletea model for mxd TUI.
type App struct {
	task      TaskInfo
	width     int
	height    int
	mode      string // "normal", "add-repo"
	focused   int    // index into task.Repos for pane focus
	statusMsg string // temporary status message
}

// NewApp creates the TUI model.
func NewApp(task TaskInfo) *App {
	return &App{
		task: task,
		mode: "normal",
	}
}

func (a *App) Init() tea.Cmd {
	return nil
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height

	case statusMsg:
		a.statusMsg = string(msg)
		return a, nil

	case tea.KeyMsg:
		// Handle modal mode first
		if a.mode == "add-repo" {
			return a.updateAddRepo(msg)
		}

		switch msg.String() {
		case "q", "ctrl+c":
			return a, tea.Quit
		case "a":
			a.mode = "add-repo"
			a.statusMsg = "Select repo to add..."
			return a, nil
		case "s":
			a.statusMsg = "Refreshing status..."
			return a, nil
		case "f":
			a.focused = (a.focused + 1) % max(len(a.task.Repos), 1)
			return a, nil
		case "1", "2", "3", "4", "5", "6", "7", "8", "9":
			idx := int(msg.String()[0]-'0') - 1
			if idx < len(a.task.Repos) {
				a.focused = idx
			}
			return a, nil
		case "k":
			if len(a.task.Repos) > 0 && a.focused < len(a.task.Repos) {
				a.task.Repos[a.focused].Status = "stopped"
				a.statusMsg = fmt.Sprintf("Killed agent in %s", a.task.Repos[a.focused].Name)
			}
			return a, nil
		case "r":
			if len(a.task.Repos) > 0 && a.focused < len(a.task.Repos) {
				a.task.Repos[a.focused].Status = "running"
				a.statusMsg = fmt.Sprintf("Restarting agent in %s", a.task.Repos[a.focused].Name)
			}
			return a, nil
		case "p":
			if a.task.Mode == "" || a.task.Mode == "supervised" {
				a.task.Mode = "autonomous"
			} else {
				a.task.Mode = "supervised"
			}
			a.statusMsg = fmt.Sprintf("Mode: %s", a.task.Mode)
			return a, nil
		}
	}
	return a, nil
}

func (a *App) View() string {
	if a.width == 0 {
		return "Loading..."
	}

	title := titleStyle.Render(fmt.Sprintf("mxd: %s", a.task.Description))

	// Mode indicator
	modeStr := a.task.Mode
	if modeStr == "" {
		modeStr = "supervised"
	}
	modeIndicator := helpStyle.Render(fmt.Sprintf("[%s]", modeStr))

	var repoLines string
	if len(a.task.Repos) == 0 {
		repoLines = statusStyle.Render("  No repos connected yet")
	} else {
		for i, r := range a.task.Repos {
			cursor := "  "
			if i == a.focused {
				cursor = "→ "
			}
			status := "●"
			switch r.Status {
			case "running":
				status = statusStyle.Render("●")
			case "idle", "in_progress":
				status = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Render("○")
			case "stopped":
				status = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Render("✕")
			default:
				status = lipgloss.NewStyle().Foreground(lipgloss.Color("8")).Render("?")
			}
			line := fmt.Sprintf("%s%s %s  %s  [%s]",
				cursor,
				status,
				repoStyle.Render(r.Name),
				r.Branch,
				r.AgentName,
			)
			repoLines += line + "\n"
		}
	}

	help := helpStyle.Render("[a]dd repo  [s]tatus  [f/1-9]focus  [k]ill  [r]estart  [p]mode  [q]uit")

	var statusLine string
	if a.statusMsg != "" {
		statusLine = "\n" + lipgloss.NewStyle().Foreground(lipgloss.Color("13")).Render(a.statusMsg)
	}

	// Add-repo modal overlay
	if a.mode == "add-repo" {
		return fmt.Sprintf("%s  %s\n\n%s\n%s\n\n%s", title, modeIndicator, repoLines, a.renderAddRepoModal(), help)
	}

	return fmt.Sprintf("%s  %s\n\n%s%s\n%s", title, modeIndicator, repoLines, statusLine, help)
}

// updateAddRepo handles key events in add-repo modal mode.
func (a *App) updateAddRepo(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		a.mode = "normal"
		a.statusMsg = ""
		return a, nil
	case "enter":
		a.mode = "normal"
		a.statusMsg = "Repo addition will be wired in next phase"
		return a, nil
	}
	return a, nil
}

func (a *App) renderAddRepoModal() string {
	modal := modalStyle.
		Render("Add Repo\n\n(Repo selection will be wired in Task 9)\n\n[esc] cancel  [enter] confirm")
	return modal
}
