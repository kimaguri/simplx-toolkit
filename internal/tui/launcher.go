package tui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/discovery"
)

// LaunchRequestMsg is emitted when the user confirms a launch
type LaunchRequestMsg struct {
	Worktree       discovery.Worktree
	Project        discovery.Project
	Port           int
	Script         string // selected script name (e.g. "dev", "start")
	PackageManager string // detected package manager binary (e.g. "pnpm", "npm")
}

// launcherStep tracks which step of the wizard we're on
type launcherStep int

const (
	stepWorktree launcherStep = iota
	stepProject
	stepScript
	stepPort
	stepConfirm
)

// launcherModel is a multi-step launch wizard popup
type launcherModel struct {
	step        launcherStep
	worktrees   []discovery.Worktree
	projects    []discovery.Project
	wtProjects  [][]discovery.Project // pre-detected projects per worktree
	portMap     map[string]int        // port overrides from config
	wtIndex     int
	projIndex   int
	scripts     []string // scripts for currently selected project
	scriptIndex int      // selected script index
	portInput   textinput.Model
	portFixed   bool // true if port is hardcoded in project config
	width       int
	height      int
}

// newLauncherModel creates a new launch wizard
func newLauncherModel(worktrees []discovery.Worktree, portOverrides map[string]int) launcherModel {
	ti := textinput.New()
	ti.Placeholder = "3000"
	ti.Width = 10
	ti.CharLimit = 5

	// Sort: main repos first, then worktrees; each group by last modified desc
	sort.SliceStable(worktrees, func(i, j int) bool {
		if worktrees[i].IsWorktree != worktrees[j].IsWorktree {
			return !worktrees[i].IsWorktree // main repos first
		}
		return worktrees[i].LastModified.After(worktrees[j].LastModified)
	})

	// Pre-detect projects for each worktree and filter out empty ones
	var filtered []discovery.Worktree
	var filteredProjects [][]discovery.Project
	for _, wt := range worktrees {
		projects := discovery.DetectProjects(wt)
		if len(projects) > 0 {
			filtered = append(filtered, wt)
			filteredProjects = append(filteredProjects, projects)
		}
	}

	return launcherModel{
		step:       stepWorktree,
		worktrees:  filtered,
		wtProjects: filteredProjects,
		portMap:    portOverrides,
		portInput:  ti,
	}
}

// Init implements tea.Model
func (m launcherModel) Init() tea.Cmd {
	return nil
}

// Update handles wizard navigation and input
func (m launcherModel) Update(msg tea.Msg) (launcherModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			if m.step == stepWorktree {
				return m, func() tea.Msg { return cancelLauncherMsg{} }
			}
			// Skip script step when going back from port for Encore projects
			if m.step == stepPort && m.projIndex < len(m.projects) && m.projects[m.projIndex].IsEncore {
				m.step = stepProject
			} else {
				m.step--
			}
			return m, nil

		case "enter":
			return m.advance()

		case "up", "k":
			m.moveSelection(-1)
			return m, nil

		case "down", "j":
			m.moveSelection(1)
			return m, nil

		case "tab":
			if m.step == stepConfirm {
				return m.advance()
			}
			return m, nil
		}

		if m.step == stepPort && !m.portFixed {
			var cmd tea.Cmd
			m.portInput, cmd = m.portInput.Update(msg)
			return m, cmd
		}
	}

	return m, nil
}

// cancelLauncherMsg signals the launcher should close without action
type cancelLauncherMsg struct{}

// advance moves to the next step or confirms the launch
func (m launcherModel) advance() (launcherModel, tea.Cmd) {
	switch m.step {
	case stepWorktree:
		if len(m.worktrees) == 0 {
			return m, nil
		}
		// Use pre-detected projects
		if m.wtIndex < len(m.wtProjects) {
			m.projects = m.wtProjects[m.wtIndex]
		} else {
			m.projects = discovery.DetectProjects(m.worktrees[m.wtIndex])
		}
		m.projIndex = 0
		m.step = stepProject
		return m, nil

	case stepProject:
		if len(m.projects) == 0 {
			return m, nil
		}
		proj := m.projects[m.projIndex]

		// For Encore projects, skip script selection
		if proj.IsEncore {
			wt := m.worktrees[m.wtIndex]
			key := config.PortKey(wt.Name, proj.Name)
			m.portFixed = false
			if savedPort, ok := m.portMap[key]; ok && savedPort > 0 {
				m.portInput.SetValue(fmt.Sprintf("%d", savedPort))
			} else {
				m.portInput.SetValue("3000")
			}
			m.portInput.Focus()
			m.scripts = nil
			m.scriptIndex = 0
			m.step = stepPort
			return m, textinput.Blink
		}

		m.scripts = proj.Scripts
		m.scriptIndex = 0 // dev/start already sorted first
		m.step = stepScript
		return m, nil

	case stepScript:
		wt := m.worktrees[m.wtIndex]
		proj := m.projects[m.projIndex]

		m.portFixed = proj.PortFixed
		if proj.PortFixed && proj.DetectedPort > 0 {
			// Hardcoded port — show as read-only
			m.portInput.SetValue(fmt.Sprintf("%d", proj.DetectedPort))
		} else {
			// Check for saved port override, then detected default, then 3000
			key := config.PortKey(wt.Name, proj.Name)
			if savedPort, ok := m.portMap[key]; ok && savedPort > 0 {
				m.portInput.SetValue(fmt.Sprintf("%d", savedPort))
			} else if proj.DetectedPort > 0 {
				m.portInput.SetValue(fmt.Sprintf("%d", proj.DetectedPort))
			} else {
				m.portInput.SetValue("3000")
			}
		}
		if !m.portFixed {
			m.portInput.Focus()
		}
		m.step = stepPort
		if m.portFixed {
			return m, nil
		}
		return m, textinput.Blink

	case stepPort:
		m.step = stepConfirm
		m.portInput.Blur()
		return m, nil

	case stepConfirm:
		if len(m.worktrees) == 0 || len(m.projects) == 0 {
			return m, nil
		}
		wt := m.worktrees[m.wtIndex]
		proj := m.projects[m.projIndex]

		port := 3000
		if v := m.portInput.Value(); v != "" {
			if p := parsePort(v); p > 0 {
				port = p
			}
		}

		script := ""
		if m.scriptIndex < len(m.scripts) {
			script = m.scripts[m.scriptIndex]
		}

		return m, func() tea.Msg {
			return LaunchRequestMsg{
				Worktree:       wt,
				Project:        proj,
				Port:           port,
				Script:         script,
				PackageManager: proj.PackageManager,
			}
		}
	}
	return m, nil
}

// moveSelection navigates the current list
func (m *launcherModel) moveSelection(delta int) {
	switch m.step {
	case stepWorktree:
		m.wtIndex += delta
		if m.wtIndex < 0 {
			m.wtIndex = 0
		}
		if m.wtIndex >= len(m.worktrees) {
			m.wtIndex = len(m.worktrees) - 1
		}
	case stepProject:
		m.projIndex += delta
		if m.projIndex < 0 {
			m.projIndex = 0
		}
		if m.projIndex >= len(m.projects) {
			m.projIndex = len(m.projects) - 1
		}
	case stepScript:
		m.scriptIndex += delta
		if m.scriptIndex < 0 {
			m.scriptIndex = 0
		}
		if m.scriptIndex >= len(m.scripts) {
			m.scriptIndex = len(m.scripts) - 1
		}
	}
}

// View renders the launcher popup
func (m launcherModel) View() string {
	maxWidth := m.width * 80 / 100
	if maxWidth < 50 {
		maxWidth = 50
	}
	if maxWidth > 120 {
		maxWidth = 120
	}

	title := modalTitleStyle.Render("Launch New Process")
	var body string

	switch m.step {
	case stepWorktree:
		body = m.renderWorktreeList(maxWidth - 6)
	case stepProject:
		body = m.renderProjectList(maxWidth - 6)
	case stepScript:
		body = m.renderScriptList(maxWidth - 6)
	case stepPort:
		body = m.renderPortInput(maxWidth - 6)
	case stepConfirm:
		body = m.renderConfirm(maxWidth - 6)
	}

	stepIndicator := m.renderStepIndicator()

	content := lipgloss.JoinVertical(lipgloss.Left,
		title,
		"",
		stepIndicator,
		"",
		body,
		"",
		dimStyle.Render("enter:select  esc:back  arrows:navigate"),
	)

	popup := modalStyle.
		Width(maxWidth).
		Render(content)

	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, popup)
}

// renderStepIndicator shows the current step
func (m launcherModel) renderStepIndicator() string {
	steps := []string{"Worktree", "Project", "Script", "Port", "Confirm"}
	var parts []string
	for i, s := range steps {
		if launcherStep(i) == m.step {
			parts = append(parts, helpKeyStyle.Render("["+s+"]"))
		} else if launcherStep(i) < m.step {
			parts = append(parts, statusRunning.Render(s))
		} else {
			parts = append(parts, dimStyle.Render(s))
		}
	}
	return strings.Join(parts, " > ")
}

// renderWorktreeList shows available worktrees in two sections
func (m launcherModel) renderWorktreeList(width int) string {
	if len(m.worktrees) == 0 {
		return dimStyle.Render("No worktrees found. Press 's' to add scan directories.")
	}

	// Find where worktrees section starts
	wtStart := -1
	hasRepos := false
	for i, wt := range m.worktrees {
		if !wt.IsWorktree {
			hasRepos = true
		}
		if wt.IsWorktree && wtStart == -1 {
			wtStart = i
		}
	}

	var lines []string

	if hasRepos {
		lines = append(lines, sectionStyle.Render("── Projects ──"))
	}

	for i, wt := range m.worktrees {
		if i == wtStart {
			if hasRepos {
				lines = append(lines, "")
			}
			lines = append(lines, sectionStyle.Render("── Worktrees ──"))
		}
		lines = append(lines, m.renderWorktreeItem(i, wt, width))
	}

	return strings.Join(lines, "\n")
}

// renderWorktreeItem renders a single item in the worktree list
func (m launcherModel) renderWorktreeItem(idx int, wt discovery.Worktree, width int) string {
	prefix := "  "
	style := normalItemStyle
	if idx == m.wtIndex {
		prefix = "> "
		style = selectedItemStyle
	}

	// Age
	var age string
	if !wt.LastModified.IsZero() {
		age = "  " + ageStyle.Render(formatAge(wt.LastModified))
	}

	// Parent project indicator for worktrees
	var parent string
	if wt.IsWorktree && wt.MainProject != "" {
		parent = "  " + dimStyle.Render("-> "+wt.MainProject)
	}

	line := fmt.Sprintf("%s%s  %s%s%s",
		prefix,
		style.Render(wt.Name),
		portStyle.Render(wt.Branch),
		age,
		parent,
	)

	if lipgloss.Width(line) > width {
		line = lipgloss.NewStyle().MaxWidth(width).Render(line)
	}

	return line
}

// renderProjectList shows available projects for the selected worktree
func (m launcherModel) renderProjectList(width int) string {
	wtName := m.worktrees[m.wtIndex].Name
	header := dimStyle.Render("Worktree: ") + selectedItemStyle.Render(wtName)

	if len(m.projects) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left,
			header,
			"",
			dimStyle.Render("No projects found in this worktree"),
		)
	}

	var lines []string
	for i, proj := range m.projects {
		prefix := "  "
		style := normalItemStyle
		if i == m.projIndex {
			prefix = "> "
			style = selectedItemStyle
		}
		var badges []string
		if proj.IsEncore {
			badges = append(badges, "[encore]")
		} else if proj.PackageManager != "" {
			badges = append(badges, "["+proj.PackageManager+"]")
		}
		suffix := ""
		if len(badges) > 0 {
			suffix = " " + dimStyle.Render(strings.Join(badges, " "))
		}
		line := fmt.Sprintf("%s%s%s", prefix, style.Render(proj.Name), suffix)
		lines = append(lines, line)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		lipgloss.NewStyle().Width(width).Render(strings.Join(lines, "\n")),
	)
}

// renderScriptList shows available scripts for the selected project
func (m launcherModel) renderScriptList(width int) string {
	wtName := m.worktrees[m.wtIndex].Name
	projName := m.projects[m.projIndex].Name
	pm := m.projects[m.projIndex].PackageManager

	header := lipgloss.JoinVertical(lipgloss.Left,
		dimStyle.Render("Worktree: ")+selectedItemStyle.Render(wtName),
		dimStyle.Render("Project:  ")+selectedItemStyle.Render(projName)+" "+dimStyle.Render("["+pm+"]"),
	)

	if len(m.scripts) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left,
			header,
			"",
			dimStyle.Render("No scripts found in package.json"),
		)
	}

	var lines []string
	for i, script := range m.scripts {
		prefix := "  "
		style := normalItemStyle
		if i == m.scriptIndex {
			prefix = "> "
			style = selectedItemStyle
		}
		line := fmt.Sprintf("%s%s", prefix, style.Render(script))
		lines = append(lines, line)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		lipgloss.NewStyle().Width(width).Render(strings.Join(lines, "\n")),
	)
}

// renderPortInput shows the port number input
func (m launcherModel) renderPortInput(width int) string {
	wtName := m.worktrees[m.wtIndex].Name
	projName := m.projects[m.projIndex].Name

	header := lipgloss.JoinVertical(lipgloss.Left,
		dimStyle.Render("Worktree: ")+selectedItemStyle.Render(wtName),
		dimStyle.Render("Project:  ")+selectedItemStyle.Render(projName),
	)

	var portLine string
	if m.portFixed {
		portLine = dimStyle.Render("Port: ") + portStyle.Render(m.portInput.Value()) + " " + dimStyle.Render("(hardcoded in config)")
	} else {
		portLine = dimStyle.Render("Port: ") + m.portInput.View()
	}

	var lines []string
	lines = append(lines, header, "", lipgloss.NewStyle().Width(width).Render(portLine))

	if m.portFixed {
		lines = append(lines, "", dimStyle.Render("Port is set in project config and cannot be changed here."))
		lines = append(lines, dimStyle.Render("Press Enter to continue."))
	}

	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

// renderConfirm shows the final confirmation
func (m launcherModel) renderConfirm(width int) string {
	wt := m.worktrees[m.wtIndex]
	proj := m.projects[m.projIndex]
	port := m.portInput.Value()

	sessionName := config.SessionName(wt.Name, proj.Name)

	script := ""
	if m.scriptIndex < len(m.scripts) {
		script = m.scripts[m.scriptIndex]
	}

	var summaryLines []string
	summaryLines = append(summaryLines,
		dimStyle.Render("Worktree: ")+selectedItemStyle.Render(wt.Name),
		dimStyle.Render("Project:  ")+selectedItemStyle.Render(proj.Name),
	)
	if script != "" {
		pm := proj.PackageManager
		if pm == "" {
			pm = "npm"
		}
		summaryLines = append(summaryLines,
			dimStyle.Render("Command:  ")+selectedItemStyle.Render(pm+" run "+script),
		)
	}
	portDisplay := portStyle.Render(":" + port)
	if m.portFixed {
		portDisplay += " " + dimStyle.Render("(hardcoded)")
	}
	summaryLines = append(summaryLines,
		dimStyle.Render("Port:     ")+portDisplay,
		dimStyle.Render("Session:  ")+selectedItemStyle.Render(sessionName),
	)

	summary := lipgloss.JoinVertical(lipgloss.Left, summaryLines...)

	hint := helpKeyStyle.Render("Press Enter to launch")

	return lipgloss.JoinVertical(lipgloss.Left,
		summary,
		"",
		lipgloss.NewStyle().Width(width).Render(hint),
	)
}

// SetSize updates dimensions for centering
func (m *launcherModel) SetSize(w, h int) {
	m.width = w
	m.height = h
}

// parsePort converts a string to an integer port number
func parsePort(s string) int {
	var port int
	for _, c := range s {
		if c >= '0' && c <= '9' {
			port = port*10 + int(c-'0')
		} else {
			return 0
		}
	}
	if port < 1 || port > 65535 {
		return 0
	}
	return port
}
