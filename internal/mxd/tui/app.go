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

// TaskInfo holds the current task state for display.
type TaskInfo struct {
	Description string
	TaskType    string
	TaskID      string
	Repos       []RepoInfo
}

// RepoInfo holds per-repo status.
type RepoInfo struct {
	Name        string
	Branch      string
	AgentName   string
	Status      string // "running", "idle", "stopped"
	WorktreeDir string
}

// App is the root Bubbletea model for mxd TUI.
type App struct {
	task   TaskInfo
	width  int
	height int
}

// NewApp creates the TUI model.
func NewApp(task TaskInfo) *App {
	return &App{task: task}
}

func (a *App) Init() tea.Cmd {
	return nil
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return a, tea.Quit
		}
	}
	return a, nil
}

func (a *App) View() string {
	if a.width == 0 {
		return "Loading..."
	}

	title := titleStyle.Render(fmt.Sprintf("mxd: %s", a.task.Description))

	var repoLines string
	if len(a.task.Repos) == 0 {
		repoLines = statusStyle.Render("  No repos connected yet")
	} else {
		for _, r := range a.task.Repos {
			status := "●"
			switch r.Status {
			case "running":
				status = statusStyle.Render("●")
			case "idle":
				status = lipgloss.NewStyle().Foreground(lipgloss.Color("11")).Render("○")
			default:
				status = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Render("✕")
			}
			line := fmt.Sprintf("  %s %s  %s  [%s]",
				status,
				repoStyle.Render(r.Name),
				r.Branch,
				r.AgentName,
			)
			repoLines += line + "\n"
		}
	}

	help := helpStyle.Render("[a]dd repo  [s]tatus  [t] PR test  [M] PR main  [q]uit")

	return fmt.Sprintf("%s\n\n%s\n\n%s", title, repoLines, help)
}
