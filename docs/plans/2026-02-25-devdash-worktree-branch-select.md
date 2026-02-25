# DevDash: Worktree/Branch Selection

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Select Directory" step to the DevDash launcher wizard so users can choose which working directory (main repo or worktree) to launch a process from.

**Architecture:** Insert a new `stepDirectory` between `stepRepo` (project selection) and `stepModule` (module selection). Step 1 shows only main repos. Step 2 shows all available directories (main + worktrees) for the selected project with branch info. Auto-skip step 2 when project has no worktrees.

**Tech Stack:** Go, Bubbletea TUI, existing `discovery.ScanWorktrees`

---

## Context

### Current Flow (5 steps)
```
stepWorktree → stepProject → stepScript → stepPort → stepConfirm
(flat list     (modules in    (npm scripts) (port)    (launch))
 repos+wts)    selected dir)
```

### New Flow (6 steps)
```
stepRepo → stepDirectory → stepModule → stepScript → stepPort → stepConfirm
(main       (main dir +     (modules    (scripts)    (port)    (launch))
 repos       worktrees       within
 only)       for project)    directory)
```

### Key Files
- `internal/tui/launcher.go` — launcher wizard model, steps, rendering
- `internal/tui/launcher_test.go` — existing tests for scrollWindow
- `internal/discovery/worktree.go` — already discovers all worktrees (no changes needed)
- `internal/discovery/project.go` — project detection (no changes needed)

### Data Flow
1. `ScanWorktrees(scanDirs)` returns ALL repos + worktrees (already works)
2. Main repos have `IsWorktree=false`
3. Worktrees have `IsWorktree=true`, `MainProject=<parent-repo-name>`
4. Worktrees in `.worktrees/` discovered via `git worktree list --porcelain`
5. Sidecar worktrees discovered by `collectGitRepos` + `detectWorktreeInfo`

### Constraints
- Do NOT break existing functionality (process launch, port saving, session naming)
- `LaunchRequestMsg` struct stays the same (Worktree, Project, Port, Script, PackageManager)
- Session names use `config.SessionName(wt.Name, proj.Name)` — must keep working
- Port overrides keyed by `config.PortKey(wt.Name, proj.Name)` — must keep working

---

## Task 1: Restructure launcherStep constants and launcherModel fields

**Files:**
- Modify: `internal/tui/launcher.go:28-51`

**Step 1: Update step constants**

Replace the current step constants:

```go
type launcherStep int

const (
	stepRepo      launcherStep = iota // select main project (repos only)
	stepDirectory                     // select working directory (main + worktrees)
	stepModule                        // select module within directory
	stepScript                        // select npm script
	stepPort                          // set port
	stepConfirm                       // confirm launch
)
```

**Step 2: Update launcherModel fields**

Replace the current fields:

```go
type launcherModel struct {
	step        launcherStep
	allWorktrees []discovery.Worktree  // full list (for worktree lookup)
	// Step 1: main repos
	mainRepos   []discovery.Worktree   // only IsWorktree=false, with projects
	repoIndex   int
	// Step 2: directories for selected project
	directories []discovery.Worktree   // main dir + worktrees, filtered to those with projects
	dirProjects [][]discovery.Project  // pre-detected projects per directory
	dirIndex    int
	// Step 3: modules
	projects    []discovery.Project
	projIndex   int
	// Step 4: scripts
	scripts     []string
	scriptIndex int
	// Step 5: port
	portInput   textinput.Model
	portFixed   bool
	portMap     map[string]int
	// layout
	width       int
	height      int
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/kimaguri/x/simplx/simplx-toolkit/.worktrees/fix-devdash-worktree-branch-select && go build ./...`
Expected: Compilation errors (references to old fields) — that's fine, we fix them in next tasks.

---

## Task 2: Rewrite newLauncherModel constructor

**Files:**
- Modify: `internal/tui/launcher.go:54-86`

**Step 1: Rewrite constructor**

```go
func newLauncherModel(worktrees []discovery.Worktree, portOverrides map[string]int) launcherModel {
	ti := textinput.New()
	ti.Placeholder = "3000"
	ti.Width = 10
	ti.CharLimit = 5

	// Separate main repos from worktrees
	var mainRepos []discovery.Worktree
	for _, wt := range worktrees {
		if !wt.IsWorktree {
			// Only include if it has runnable projects
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
```

**Step 2: Verify it compiles**

Run: `go build ./...`
Expected: Still errors from advance/render methods — fixed next.

---

## Task 3: Rewrite advance() for new step flow

**Files:**
- Modify: `internal/tui/launcher.go:143-250`

**Step 1: Rewrite advance()**

```go
func (m launcherModel) advance() (launcherModel, tea.Cmd) {
	switch m.step {
	case stepRepo:
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

	case stepDirectory:
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

	case stepModule:
		if len(m.projects) == 0 {
			return m, nil
		}
		proj := m.projects[m.projIndex]

		// For Encore projects without package.json scripts, skip to port
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

	case stepScript:
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

	case stepPort:
		m.step = stepConfirm
		m.portInput.Blur()
		return m, nil

	case stepConfirm:
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
	return m, nil
}

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
```

**Step 2: Verify it compiles**

Run: `go build ./...`

---

## Task 4: Update moveSelection() and Update() for new steps

**Files:**
- Modify: `internal/tui/launcher.go:253-280` (moveSelection)
- Modify: `internal/tui/launcher.go:94-137` (Update)

**Step 1: Update moveSelection**

```go
func (m *launcherModel) moveSelection(delta int) {
	switch m.step {
	case stepRepo:
		m.repoIndex += delta
		if m.repoIndex < 0 {
			m.repoIndex = 0
		}
		if m.repoIndex >= len(m.mainRepos) {
			m.repoIndex = len(m.mainRepos) - 1
		}
	case stepDirectory:
		m.dirIndex += delta
		if m.dirIndex < 0 {
			m.dirIndex = 0
		}
		if m.dirIndex >= len(m.directories) {
			m.dirIndex = len(m.directories) - 1
		}
	case stepModule:
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
```

**Step 2: Update Esc handling in Update()**

In the `"esc"` case, update back-navigation:

```go
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
```

**Step 3: Verify it compiles**

Run: `go build ./...`

---

## Task 5: Update View() and render methods

**Files:**
- Modify: `internal/tui/launcher.go:283-415` (View, renderStepIndicator, renderWorktreeList, renderWorktreeItem)

**Step 1: Update View() switch**

```go
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
```

**Step 2: Update renderStepIndicator**

```go
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

	// Skip "Directory" in indicator when auto-skipped (only 1 directory)
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
```

**Step 3: Rename renderWorktreeList → renderRepoList (show only main repos)**

```go
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
```

**Step 4: Add renderDirectoryList**

```go
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
		if !dir.IsWorktree {
			name = ". (main)"
		}

		var age string
		if !dir.LastModified.IsZero() {
			age = "  " + ageStyle.Render(formatAge(dir.LastModified))
		}

		line := fmt.Sprintf("%s%s  %s%s",
			prefix,
			style.Render(name),
			portStyle.Render(dir.Branch),
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
```

**Step 5: Rename renderProjectList → renderModuleList**

Rename the function. Update `wtName` reference to use `selectedWorktree()`:

```go
func (m launcherModel) renderModuleList(width int) string {
	dir := m.selectedWorktree()
	header := dimStyle.Render("Directory: ") + selectedItemStyle.Render(dir.Name) +
		"  " + portStyle.Render(dir.Branch)

	// ... rest stays the same but uses dir instead of m.worktrees[m.wtIndex]
}
```

**Step 6: Update renderScriptList, renderPortInput, renderConfirm**

Replace all `m.worktrees[m.wtIndex]` with `m.selectedWorktree()`.

**Step 7: Verify it compiles and runs**

Run: `go build ./...`
Run: `go test ./internal/tui/...`

---

## Task 6: Update existing tests and add new tests

**Files:**
- Modify: `internal/tui/launcher_test.go`

**Step 1: Add test for directory step auto-skip (no worktrees)**

```go
func TestLauncher_AutoSkipDirectory_NoWorktrees(t *testing.T) {
	// Verify that when a project has no worktrees,
	// stepDirectory is skipped and we go straight to stepModule.
	// This requires mock worktrees - test the advance() logic.
}
```

**Step 2: Add test for directory step shown (has worktrees)**

```go
func TestLauncher_ShowsDirectoryStep_WithWorktrees(t *testing.T) {
	// Verify that when a project has worktrees,
	// stepDirectory is shown with main dir + worktrees.
}
```

**Step 3: Run tests**

Run: `go test ./internal/tui/... -v`
Expected: All tests PASS

---

## Task 7: Verify end-to-end and commit

**Step 1: Build both binaries**

Run: `go build -o /dev/null ./cmd/local/ && go build -o /dev/null ./cmd/maomao/`
Expected: Both compile successfully

**Step 2: Run all tests**

Run: `go test ./...`
Expected: All PASS

**Step 3: Commit**

```bash
git add internal/tui/launcher.go internal/tui/launcher_test.go
git commit -m "feat(devdash): add directory selection step for worktree branches

When launching a new process, users now select a project first,
then choose which working directory (main or worktree) to use.
Auto-skips directory step when project has no worktrees."
```
