package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

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

// HomeAction describes what the user wants after leaving the dashboard.
type HomeAction struct {
	Kind     string // "create", "resume", or "" (quit)
	TaskDesc string // for "create": raw description
	RepoName string // for "create": selected repo name
	RepoPath string // for "create": selected repo absolute path
	TaskID   string // for "resume": task ID
}

type homeOverlay int

const (
	homeOverlayNone    homeOverlay = iota
	homeOverlayNewTask
)

// StatusData holds environment status for the home view.
type StatusData struct {
	Version  string
	GlobalOK bool
	TmuxOK   bool
	ScanOK   bool // true if scan_dirs configured and repos found
	Agents   []AgentEntry
	Repos    []RepoEntry
	Tasks    []TaskEntry
}

// AgentEntry represents a detected agent.
type AgentEntry struct {
	Key       string
	Available bool
}

// RepoEntry represents a discovered git repo.
type RepoEntry struct {
	Name   string
	Path   string
	Branch string
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

// HomeApp is the root model for `mxd` (bare command).
type HomeApp struct {
	phase    string // "wizard" or "home"
	wizard   wizardModel
	status   StatusData
	reloadFn func() StatusData
	width    int
	height   int
	cursor   int
	overlay  homeOverlay
	newTask  newTaskModel
	action   HomeAction
	flash    string // transient message shown after returning from action
}

// Action returns the action the user selected before quitting.
func (h *HomeApp) Action() HomeAction {
	return h.action
}

// SetFlash sets a transient message to display on the dashboard.
func (h *HomeApp) SetFlash(msg string) {
	h.flash = msg
}

// NewHomeApp creates the home app. Shows wizard first if there are fixable issues.
func NewHomeApp(checks []WizardCheck, status StatusData, reloadFn func() StatusData) *HomeApp {
	hasFixable := false
	for _, c := range checks {
		if !c.OK && c.Fixable {
			hasFixable = true
			break
		}
	}

	h := &HomeApp{
		status:   status,
		reloadFn: reloadFn,
	}

	if hasFixable {
		h.phase = "wizard"
		h.wizard = newWizardModel(checks)
	} else {
		h.phase = "home"
	}

	return h
}

func (h *HomeApp) Init() tea.Cmd {
	return nil
}

func (h *HomeApp) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		h.width = msg.Width
		h.height = msg.Height
		h.wizard.width = msg.Width
		h.wizard.height = msg.Height
		h.newTask.SetSize(msg.Width, msg.Height)
		return h, nil

	case WizardDoneMsg:
		if msg.Applied && h.reloadFn != nil {
			h.status = h.reloadFn()
		}
		h.phase = "home"
		return h, nil

	case newTaskConfirmMsg:
		h.action = HomeAction{
			Kind:     "create",
			TaskDesc: msg.Description,
			RepoName: msg.RepoName,
			RepoPath: msg.RepoPath,
		}
		return h, tea.Quit

	case newTaskCancelMsg:
		h.overlay = homeOverlayNone
		return h, nil
	}

	// Forward to wizard
	if h.phase == "wizard" {
		switch msg.(type) {
		case tea.KeyMsg:
			var cmd tea.Cmd
			h.wizard, cmd = h.wizard.Update(msg)
			return h, cmd
		default:
			var cmd tea.Cmd
			h.wizard, cmd = h.wizard.Update(msg)
			return h, cmd
		}
	}

	// Forward to overlay if active
	if h.overlay == homeOverlayNewTask {
		if _, ok := msg.(tea.KeyMsg); ok {
			var cmd tea.Cmd
			h.newTask, cmd = h.newTask.Update(msg)
			return h, cmd
		}
	}

	// Dashboard keys
	if h.phase == "home" {
		if key, ok := msg.(tea.KeyMsg); ok {
			switch key.String() {
			case "j", "down":
				if len(h.status.Tasks) > 0 {
					h.cursor++
					if h.cursor >= len(h.status.Tasks) {
						h.cursor = len(h.status.Tasks) - 1
					}
				}
				return h, nil
			case "k", "up":
				if h.cursor > 0 {
					h.cursor--
				}
				return h, nil
			case "n":
				h.newTask = newNewTaskModel(h.status.Repos)
				h.newTask.SetSize(h.width, h.height)
				h.overlay = homeOverlayNewTask
				return h, h.newTask.input.Focus()
			case "enter":
				if len(h.status.Tasks) > 0 && h.cursor < len(h.status.Tasks) {
					t := h.status.Tasks[h.cursor]
					h.action = HomeAction{Kind: "resume", TaskID: t.ID}
					return h, tea.Quit
				}
				return h, nil
			case "r":
				if h.reloadFn != nil {
					h.status = h.reloadFn()
					if h.cursor >= len(h.status.Tasks) && len(h.status.Tasks) > 0 {
						h.cursor = len(h.status.Tasks) - 1
					} else if len(h.status.Tasks) == 0 {
						h.cursor = 0
					}
				}
				return h, nil
			case "q", "ctrl+c":
				return h, tea.Quit
			}
		}
	}

	return h, nil
}

func (h *HomeApp) View() string {
	if h.width == 0 || h.height == 0 {
		return "Initializing..."
	}

	if h.phase == "wizard" {
		modal := h.wizard.View()
		return lipgloss.NewStyle().
			Width(h.width).
			Height(h.height).
			Background(catBg).
			Align(lipgloss.Center, lipgloss.Center).
			Render(modal)
	}

	if h.overlay == homeOverlayNewTask {
		return h.newTask.View()
	}

	return h.renderDashboard()
}

func (h *HomeApp) renderDashboard() string {
	// Styles
	titleBg := lipgloss.NewStyle().
		Bold(true).
		Foreground(catWhite).
		Background(catBlue).
		Padding(0, 1)
	sectionSt := lipgloss.NewStyle().Bold(true).Foreground(catBlue)
	okSt := lipgloss.NewStyle().Foreground(catGreen).Bold(true)
	failSt := lipgloss.NewStyle().Foreground(catRed).Bold(true)
	labelSt := lipgloss.NewStyle().Foreground(catWhite)
	dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
	graySt := lipgloss.NewStyle().Foreground(catGray)
	helpKey := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
	helpDesc := lipgloss.NewStyle().Foreground(catDimWhite)
	warnSt := lipgloss.NewStyle().Foreground(catYellow)
	cursorSt := lipgloss.NewStyle().Foreground(catBlue).Bold(true)

	// Title bar
	titleText := titleBg.Render(fmt.Sprintf(" マオマオ maomao %s ", h.status.Version))

	// Content area
	contentWidth := h.width - 4
	if contentWidth < 40 {
		contentWidth = 40
	}

	var sections []string

	// Warnings
	allOK := h.status.GlobalOK && h.status.ScanOK
	if !allOK {
		var warnings []string
		if !h.status.GlobalOK {
			warnings = append(warnings, warnSt.Render("  ⚠ global config missing")+" "+graySt.Render("(maomao init)"))
		}
		if !h.status.ScanOK {
			warnings = append(warnings, warnSt.Render("  ⚠ no scan_dirs configured")+" "+graySt.Render("(add scan_dirs to ~/.config/maomao/config.toml)"))
		}
		sections = append(sections, strings.Join(warnings, "\n"))
	}

	// Flash message (from previous action)
	if h.flash != "" {
		flashSt := lipgloss.NewStyle().Foreground(catYellow).Bold(true)
		sections = append(sections, flashSt.Render("  "+h.flash))
	}

	// Agents
	if len(h.status.Agents) > 0 {
		var lines []string
		lines = append(lines, sectionSt.Render("Agents"))
		for _, a := range h.status.Agents {
			mark := okSt.Render("●")
			stat := dimSt.Render("ready")
			if !a.Available {
				mark = failSt.Render("○")
				stat = graySt.Render("missing")
			}
			lines = append(lines, fmt.Sprintf("  %s %s  %s", mark, labelSt.Render(a.Key), stat))
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}

	// Repos
	if len(h.status.Repos) > 0 {
		var lines []string
		lines = append(lines, sectionSt.Render("Repos"))
		for _, r := range h.status.Repos {
			lines = append(lines, fmt.Sprintf("  %s  %s  %s",
				labelSt.Render(r.Name),
				dimSt.Render(r.Branch),
				graySt.Render(r.Path)))
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}

	// Tasks
	{
		var lines []string
		lines = append(lines, sectionSt.Render("Tasks"))
		if len(h.status.Tasks) == 0 {
			lines = append(lines, graySt.Render("  no tasks yet — press n to create"))
		} else {
			for i, t := range h.status.Tasks {
				prefix := "  "
				if i == h.cursor {
					prefix = cursorSt.Render("> ")
				}
				mark := graySt.Render("○")
				st := graySt.Render(t.Status)
				if t.Active {
					mark = okSt.Render("●")
					st = okSt.Render(t.Status)
				}
				repoWord := "repos"
				if t.Repos == 1 {
					repoWord = "repo"
				}
				lines = append(lines, fmt.Sprintf("%s%s %-12s %s  %s  %s",
					prefix, mark, labelSt.Render(t.ID), st, dimSt.Render(t.Title),
					graySt.Render(fmt.Sprintf("(%d %s)", t.Repos, repoWord))))
			}
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}

	body := strings.Join(sections, "\n\n")

	// Help bar
	help := helpKey.Render("[j/k]") + helpDesc.Render(" navigate  ") +
		helpKey.Render("[enter]") + helpDesc.Render(" resume  ") +
		helpKey.Render("[n]") + helpDesc.Render(" new task  ") +
		helpKey.Render("[r]") + helpDesc.Render(" refresh  ") +
		helpKey.Render("[q]") + helpDesc.Render(" quit")

	// Layout
	bodyArea := lipgloss.NewStyle().
		Background(catBg).
		Padding(1, 2).
		Render(body)

	helpBar := lipgloss.NewStyle().
		Background(lipgloss.Color("#0E1525")).
		Foreground(catDimWhite).
		Width(h.width).
		Padding(0, 1).
		Render(help)

	titleLine := lipgloss.NewStyle().
		Width(h.width).
		Background(catBlue).
		Render(titleText)

	bodyHeight := h.height - 2
	if bodyHeight < 1 {
		bodyHeight = 1
	}
	bodyBlock := lipgloss.NewStyle().
		Width(h.width).
		Height(bodyHeight).
		Background(catBg).
		Render(bodyArea)

	return lipgloss.JoinVertical(lipgloss.Left, titleLine, bodyBlock, helpBar)
}
