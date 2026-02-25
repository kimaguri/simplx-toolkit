package tui

import (
	"fmt"
	"path/filepath"
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
	stepRepo      launcherStep = iota // select main project (repos only)
	stepDirectory                     // select working directory (main + worktrees)
	stepModule                        // select module within directory
	stepScript                        // select npm script
	stepPort                          // set port
	stepConfirm                       // confirm launch
)

// launcherModel is a multi-step launch wizard popup
type launcherModel struct {
	step         launcherStep
	allWorktrees []discovery.Worktree  // full list (for worktree lookup)
	// Step 1: main repos
	mainRepos    []discovery.Worktree  // only IsWorktree=false, with projects
	repoIndex    int
	// Step 2: directories for selected project
	directories  []discovery.Worktree  // main dir + worktrees, filtered to those with projects
	dirProjects  [][]discovery.Project // pre-detected projects per directory
	dirIndex     int
	// Step 3: modules
	projects     []discovery.Project
	projIndex    int
	// Step 4: scripts
	scripts      []string
	scriptIndex  int
	// Step 5: port
	portInput    textinput.Model
	portFixed    bool
	portMap      map[string]int
	// layout
	width        int
	height       int
}

// newLauncherModel creates a new launch wizard
func newLauncherModel(worktrees []discovery.Worktree, portOverrides map[string]int) launcherModel {
	ti := textinput.New()
	ti.Placeholder = "3000"
	ti.Width = 10
	ti.CharLimit = 5

	// Separate main repos from worktrees, filter to those with projects
	var mainRepos []discovery.Worktree
	for _, wt := range worktrees {
		if !wt.IsWorktree {
			projects := discovery.DetectProjects(wt)
			if len(projects) > 0 {
				mainRepos = append(mainRepos, wt)
			}
		}
	}

	// Sort main repos by last modified desc
	sort.SliceStable(mainRepos, func(i, j int) bool {
		return mainRepos[i].LastModified.After(mainRepos[j].LastModified)
	})

	return launcherModel{
		step:         stepRepo,
		allWorktrees: worktrees,
		mainRepos:    mainRepos,
		portMap:      portOverrides,
		portInput:    ti,
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
			if m.step == stepRepo {
				return m, func() tea.Msg { return cancelLauncherMsg{} }
			}
			// Skip directory step when going back if it was auto-skipped
			if m.step == stepModule && len(m.directories) <= 1 {
				m.step = stepRepo
			} else if m.step == stepPort && m.projIndex < len(m.projects) &&
				m.projects[m.projIndex].IsEncore && len(m.projects[m.projIndex].Scripts) == 0 {
				m.step = stepModule
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

// selectedWorktree returns the currently selected directory (worktree).
func (m launcherModel) selectedWorktree() discovery.Worktree {
	if m.dirIndex < len(m.directories) {
		return m.directories[m.dirIndex]
	}
	if m.repoIndex < len(m.mainRepos) {
		return m.mainRepos[m.repoIndex]
	}
	return discovery.Worktree{}
}

// advance moves to the next step or confirms the launch
func (m launcherModel) advance() (launcherModel, tea.Cmd) {
	switch m.step {
	case stepRepo:
		return m.advanceFromRepo()
	case stepDirectory:
		return m.advanceFromDirectory()
	case stepModule:
		return m.advanceFromModule()
	case stepScript:
		return m.advanceFromScript()
	case stepPort:
		m.step = stepConfirm
		m.portInput.Blur()
		return m, nil
	case stepConfirm:
		return m.advanceFromConfirm()
	}
	return m, nil
}

func (m launcherModel) advanceFromRepo() (launcherModel, tea.Cmd) {
	if len(m.mainRepos) == 0 {
		return m, nil
	}
	selectedRepo := m.mainRepos[m.repoIndex]

	// Build directory list: main dir + worktrees belonging to this project
	dirs := []discovery.Worktree{selectedRepo}
	var dirProjects [][]discovery.Project
	dirProjects = append(dirProjects, discovery.DetectProjects(selectedRepo))

	for _, wt := range m.allWorktrees {
		if wt.IsWorktree && wt.MainProject == selectedRepo.Name {
			projects := discovery.DetectProjects(wt)
			if len(projects) > 0 {
				dirs = append(dirs, wt)
				dirProjects = append(dirProjects, projects)
			}
		}
	}

	m.directories = dirs
	m.dirProjects = dirProjects
	m.dirIndex = 0

	// Auto-skip directory step if only main dir exists
	if len(dirs) == 1 {
		m.projects = dirProjects[0]
		m.projIndex = 0
		m.step = stepModule
		return m, nil
	}
	m.step = stepDirectory
	return m, nil
}

func (m launcherModel) advanceFromDirectory() (launcherModel, tea.Cmd) {
	if len(m.directories) == 0 {
		return m, nil
	}
	if m.dirIndex < len(m.dirProjects) {
		m.projects = m.dirProjects[m.dirIndex]
	} else {
		m.projects = discovery.DetectProjects(m.directories[m.dirIndex])
	}
	m.projIndex = 0
	m.step = stepModule
	return m, nil
}

func (m launcherModel) advanceFromModule() (launcherModel, tea.Cmd) {
	if len(m.projects) == 0 {
		return m, nil
	}
	proj := m.projects[m.projIndex]

	if proj.IsEncore && len(proj.Scripts) == 0 {
		dir := m.selectedWorktree()
		key := config.PortKey(dir.Name, proj.Name)
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
	m.scriptIndex = 0
	m.step = stepScript
	return m, nil
}

func (m launcherModel) advanceFromScript() (launcherModel, tea.Cmd) {
	dir := m.selectedWorktree()
	proj := m.projects[m.projIndex]

	m.portFixed = proj.PortFixed
	if proj.PortFixed && proj.DetectedPort > 0 {
		m.portInput.SetValue(fmt.Sprintf("%d", proj.DetectedPort))
	} else {
		key := config.PortKey(dir.Name, proj.Name)
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
}

func (m launcherModel) advanceFromConfirm() (launcherModel, tea.Cmd) {
	if len(m.directories) == 0 || len(m.projects) == 0 {
		return m, nil
	}
	wt := m.selectedWorktree()
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

// moveSelection navigates the current list
func (m *launcherModel) moveSelection(delta int) {
	switch m.step {
	case stepRepo:
		if len(m.mainRepos) == 0 {
			return
		}
		m.repoIndex = clampIndex(m.repoIndex+delta, len(m.mainRepos))
	case stepDirectory:
		if len(m.directories) == 0 {
			return
		}
		m.dirIndex = clampIndex(m.dirIndex+delta, len(m.directories))
	case stepModule:
		if len(m.projects) == 0 {
			return
		}
		m.projIndex = clampIndex(m.projIndex+delta, len(m.projects))
	case stepScript:
		if len(m.scripts) == 0 {
			return
		}
		m.scriptIndex = clampIndex(m.scriptIndex+delta, len(m.scripts))
	}
}

// worktreeLocationHint returns a dim-styled hint showing whether a worktree
// lives inside the project (.worktrees/) or next to it (sidecar).
func worktreeLocationHint(wtPath, mainPath string) string {
	rel, err := filepath.Rel(mainPath, wtPath)
	if err != nil {
		return ""
	}
	if strings.HasPrefix(rel, ".worktrees"+string(filepath.Separator)) || strings.HasPrefix(rel, ".worktrees") {
		return "  " + dimStyle.Render(".worktrees/")
	}
	return "  " + dimStyle.Render("../")
}

// clampIndex keeps idx within [0, length-1]
func clampIndex(idx, length int) int {
	if idx < 0 {
		return 0
	}
	if idx >= length {
		return length - 1
	}
	return idx
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
	case stepRepo:
		body = m.renderRepoList(maxWidth - 6)
	case stepDirectory:
		body = m.renderDirectoryList(maxWidth - 6)
	case stepModule:
		body = m.renderModuleList(maxWidth - 6)
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
	type stepInfo struct {
		step  launcherStep
		label string
	}
	allSteps := []stepInfo{
		{stepRepo, "Repo"},
		{stepDirectory, "Directory"},
		{stepModule, "Module"},
		{stepScript, "Script"},
		{stepPort, "Port"},
		{stepConfirm, "Confirm"},
	}

	// Skip "Directory" in indicator when auto-skipped
	var steps []stepInfo
	for _, s := range allSteps {
		if s.step == stepDirectory && len(m.directories) <= 1 {
			continue
		}
		steps = append(steps, s)
	}

	var parts []string
	for _, s := range steps {
		if s.step == m.step {
			parts = append(parts, helpKeyStyle.Render("["+s.label+"]"))
		} else if s.step < m.step {
			parts = append(parts, statusRunning.Render(s.label))
		} else {
			parts = append(parts, dimStyle.Render(s.label))
		}
	}
	return strings.Join(parts, " > ")
}

// renderRepoList shows main repositories (not worktrees)
func (m launcherModel) renderRepoList(width int) string {
	if len(m.mainRepos) == 0 {
		return dimStyle.Render("No projects found. Press 's' to add scan directories.")
	}

	var lines []string
	for i, repo := range m.mainRepos {
		prefix := "  "
		style := normalItemStyle
		if i == m.repoIndex {
			prefix = "> "
			style = selectedItemStyle
		}

		var age string
		if !repo.LastModified.IsZero() {
			age = "  " + ageStyle.Render(formatAge(repo.LastModified))
		}

		// Count worktrees for this project
		wtCount := 0
		for _, wt := range m.allWorktrees {
			if wt.IsWorktree && wt.MainProject == repo.Name {
				wtCount++
			}
		}
		var wtBadge string
		if wtCount > 0 {
			wtBadge = "  " + dimStyle.Render(fmt.Sprintf("(%d wt)", wtCount))
		}

		line := fmt.Sprintf("%s%s  %s%s%s",
			prefix,
			style.Render(repo.Name),
			portStyle.Render(repo.Branch),
			age,
			wtBadge,
		)

		if lipgloss.Width(line) > width {
			line = lipgloss.NewStyle().MaxWidth(width).Render(line)
		}
		lines = append(lines, line)
	}

	maxVis := m.maxVisibleItems(0)
	return scrollWindow(lines, m.repoIndex, maxVis)
}

// renderDirectoryList shows working directories for the selected project
func (m launcherModel) renderDirectoryList(width int) string {
	repoName := m.mainRepos[m.repoIndex].Name
	header := dimStyle.Render("Project: ") + selectedItemStyle.Render(repoName)

	var lines []string
	for i, dir := range m.directories {
		prefix := "  "
		style := normalItemStyle
		if i == m.dirIndex {
			prefix = "> "
			style = selectedItemStyle
		}

		name := dir.Name
		var location string
		if !dir.IsWorktree {
			name = ". (main)"
		} else {
			// Show relative location hint
			mainPath := m.mainRepos[m.repoIndex].Path
			location = worktreeLocationHint(dir.Path, mainPath)
		}

		var age string
		if !dir.LastModified.IsZero() {
			age = "  " + ageStyle.Render(formatAge(dir.LastModified))
		}

		line := fmt.Sprintf("%s%s  %s%s%s",
			prefix,
			style.Render(name),
			portStyle.Render(dir.Branch),
			location,
			age,
		)
		if lipgloss.Width(line) > width {
			line = lipgloss.NewStyle().MaxWidth(width).Render(line)
		}
		lines = append(lines, line)
	}

	maxVis := m.maxVisibleItems(2)
	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		lipgloss.NewStyle().Width(width).Render(scrollWindow(lines, m.dirIndex, maxVis)),
	)
}

// renderModuleList shows available modules for the selected directory
func (m launcherModel) renderModuleList(width int) string {
	dir := m.selectedWorktree()
	header := dimStyle.Render("Directory: ") + selectedItemStyle.Render(dir.Name) +
		"  " + portStyle.Render(dir.Branch)

	if len(m.projects) == 0 {
		return lipgloss.JoinVertical(lipgloss.Left,
			header,
			"",
			dimStyle.Render("No projects found in this directory"),
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

	maxVis := m.maxVisibleItems(2)
	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		lipgloss.NewStyle().Width(width).Render(scrollWindow(lines, m.projIndex, maxVis)),
	)
}

// renderScriptList shows available scripts for the selected project
func (m launcherModel) renderScriptList(width int) string {
	dir := m.selectedWorktree()
	projName := m.projects[m.projIndex].Name
	pm := m.projects[m.projIndex].PackageManager

	header := lipgloss.JoinVertical(lipgloss.Left,
		dimStyle.Render("Directory: ")+selectedItemStyle.Render(dir.Name),
		dimStyle.Render("Project:   ")+selectedItemStyle.Render(projName)+" "+dimStyle.Render("["+pm+"]"),
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

	maxVis := m.maxVisibleItems(3) // header is 2 lines + 1 empty
	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		lipgloss.NewStyle().Width(width).Render(scrollWindow(lines, m.scriptIndex, maxVis)),
	)
}

// renderPortInput shows the port number input
func (m launcherModel) renderPortInput(width int) string {
	dir := m.selectedWorktree()
	projName := m.projects[m.projIndex].Name

	header := lipgloss.JoinVertical(lipgloss.Left,
		dimStyle.Render("Directory: ")+selectedItemStyle.Render(dir.Name),
		dimStyle.Render("Project:   ")+selectedItemStyle.Render(projName),
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
	wt := m.selectedWorktree()
	proj := m.projects[m.projIndex]
	port := m.portInput.Value()

	sessionName := config.SessionName(wt.Name, proj.Name)

	script := ""
	if m.scriptIndex < len(m.scripts) {
		script = m.scripts[m.scriptIndex]
	}

	var summaryLines []string
	summaryLines = append(summaryLines,
		dimStyle.Render("Directory: ")+selectedItemStyle.Render(wt.Name),
		dimStyle.Render("Project:   ")+selectedItemStyle.Render(proj.Name),
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

// modalOverheadLines is the number of lines used by title, step indicator,
// footer hint, empty lines, and modal border padding.
const modalOverheadLines = 12

// maxVisibleItems calculates how many list items fit in the modal,
// subtracting modal chrome and header lines.
func (m launcherModel) maxVisibleItems(headerLines int) int {
	avail := m.height - modalOverheadLines - headerLines
	if avail < 5 {
		avail = 5
	}
	return avail
}

// scrollWindow returns a visible slice of lines with "↑ N more" / "↓ N more"
// indicators when the list is longer than maxVisible.
func scrollWindow(lines []string, selectedIdx, maxVisible int) string {
	if len(lines) <= maxVisible {
		return strings.Join(lines, "\n")
	}

	// Keep selected item visible, roughly centered
	half := maxVisible / 2
	start := selectedIdx - half
	if start < 0 {
		start = 0
	}
	end := start + maxVisible
	if end > len(lines) {
		end = len(lines)
		start = end - maxVisible
		if start < 0 {
			start = 0
		}
	}

	var result []string
	if start > 0 {
		result = append(result, dimStyle.Render(fmt.Sprintf("  ↑ %d more", start)))
	}
	result = append(result, lines[start:end]...)
	if end < len(lines) {
		result = append(result, dimStyle.Render(fmt.Sprintf("  ↓ %d more", len(lines)-end)))
	}
	return strings.Join(result, "\n")
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
