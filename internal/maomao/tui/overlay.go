package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type overlayKind int

const (
	overlayNone    overlayKind = iota
	overlayNewTask             // n: select repo → type branch → create
	overlayAddRepo             // a: select repo → add to current task
	overlayHandoff             // handoff detected from sibling repo
	overlayMessage             // m: manual cross-pane message
)

type overlayStep int

const (
	stepSelectRepo overlayStep = iota
	stepTypeBranch
)

// overlayResultMsg is sent when the overlay completes successfully.
type overlayResultMsg struct {
	kind     overlayKind
	repoName string
	repoPath string
	branch   string // only for overlayNewTask
}

type indexedRepo struct {
	idx  int
	repo RepoEntry
}

type repoGroup struct {
	project string
	entries []indexedRepo
}

// overlayModel manages modal overlays for task/repo creation.
type overlayModel struct {
	kind         overlayKind
	step         overlayStep
	repos        []RepoEntry // available repos
	cursor       int
	scrollOffset int
	input        string // text input for branch name
	width        int
	height       int
}

func newOverlay(kind overlayKind, repos []RepoEntry, width, height int) overlayModel {
	return overlayModel{
		kind:   kind,
		step:   stepSelectRepo,
		repos:  repos,
		width:  width,
		height: height,
	}
}

func (o overlayModel) Update(msg tea.KeyMsg) (overlayModel, tea.Cmd) {
	switch o.step {
	case stepSelectRepo:
		return o.updateRepoSelect(msg)
	case stepTypeBranch:
		return o.updateBranchInput(msg)
	}
	return o, nil
}

func (o overlayModel) updateRepoSelect(msg tea.KeyMsg) (overlayModel, tea.Cmd) {
	maxVisible := o.maxVisibleRepos()
	switch msg.String() {
	case "j", "down":
		if o.cursor < len(o.repos)-1 {
			o.cursor++
			if o.cursor >= o.scrollOffset+maxVisible {
				o.scrollOffset = o.cursor - maxVisible + 1
			}
		}
	case "k", "up":
		if o.cursor > 0 {
			o.cursor--
			if o.cursor < o.scrollOffset {
				o.scrollOffset = o.cursor
			}
		}
	case "enter":
		if len(o.repos) == 0 {
			return o, nil
		}
		if o.kind == overlayNewTask {
			o.step = stepTypeBranch
			o.input = ""
			return o, nil
		}
		// overlayAddRepo — done after selecting repo
		selected := o.repos[o.cursor]
		return o, func() tea.Msg {
			return overlayResultMsg{
				kind:     o.kind,
				repoName: selected.Name,
				repoPath: selected.Path,
			}
		}
	case "esc":
		o.kind = overlayNone
		return o, nil
	}
	return o, nil
}

func (o overlayModel) updateBranchInput(msg tea.KeyMsg) (overlayModel, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		branch := strings.TrimSpace(o.input)
		if branch == "" {
			return o, nil
		}
		selected := o.repos[o.cursor]
		return o, func() tea.Msg {
			return overlayResultMsg{
				kind:     o.kind,
				repoName: selected.Name,
				repoPath: selected.Path,
				branch:   branch,
			}
		}
	case tea.KeyEscape:
		o.kind = overlayNone
		return o, nil
	case tea.KeyBackspace:
		if len(o.input) > 0 {
			o.input = o.input[:len(o.input)-1]
		}
	case tea.KeyRunes:
		o.input += string(msg.Runes)
	}
	return o, nil
}

func (o overlayModel) modalWidth() int {
	modalW := o.width * 3 / 5
	if modalW < 50 {
		modalW = 50
	}
	if modalW > 80 {
		modalW = 80
	}
	if o.width > 0 && modalW > o.width-4 {
		modalW = o.width - 4
	}
	return modalW
}

func (o overlayModel) maxVisibleRepos() int {
	max := o.height - 14
	if max < 5 {
		max = 5
	}
	return max
}

func (o overlayModel) View() string {
	if o.kind == overlayNone {
		return ""
	}

	modalW := o.modalWidth()

	headerSt := lipgloss.NewStyle().Bold(true).Foreground(catBlue)
	dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
	graySt := lipgloss.NewStyle().Foreground(catGray)
	cursorSt := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
	inputSt := lipgloss.NewStyle().Foreground(catWhite)

	var lines []string

	switch o.kind {
	case overlayNewTask:
		lines = append(lines, headerSt.Render("  New Task"))
	case overlayAddRepo:
		lines = append(lines, headerSt.Render("  Add Repo"))
	}
	lines = append(lines, graySt.Render("  "+strings.Repeat("\u2500", modalW-4)))
	lines = append(lines, "")

	switch o.step {
	case stepSelectRepo:
		lines = append(lines, dimSt.Render("  Select repository:"))
		lines = append(lines, "")

		// Separate projects and worktrees
		var projects, worktrees []indexedRepo
		for i, r := range o.repos {
			if r.IsWorktree {
				worktrees = append(worktrees, indexedRepo{idx: i, repo: r})
			} else {
				projects = append(projects, indexedRepo{idx: i, repo: r})
			}
		}

		// Build all repo lines (with group headers)
		var repoLines []struct {
			line string
			idx  int // -1 for headers/separators
		}

		// Projects section
		if len(projects) > 0 {
			repoLines = append(repoLines, struct {
				line string
				idx  int
			}{headerSt.Render("  Projects"), -1})
			for _, ir := range projects {
				prefix := "    "
				if ir.idx == o.cursor {
					prefix = "  " + cursorSt.Render("\u25B8 ")
				}
				name := truncate(ir.repo.Name, modalW-16)
				branch := graySt.Render(ir.repo.Branch)
				repoLines = append(repoLines, struct {
					line string
					idx  int
				}{prefix + inputSt.Render(name) + "  " + branch, ir.idx})
			}
		}

		// Worktrees section (grouped by MainProject)
		if len(worktrees) > 0 {
			if len(projects) > 0 {
				repoLines = append(repoLines, struct {
					line string
					idx  int
				}{"", -1})
			}
			repoLines = append(repoLines, struct {
				line string
				idx  int
			}{headerSt.Render("  Worktrees"), -1})

			grouped := groupByMainProject(worktrees)
			for _, group := range grouped {
				repoLines = append(repoLines, struct {
					line string
					idx  int
				}{graySt.Render("  " + group.project), -1})
				for _, ir := range group.entries {
					prefix := "      "
					if ir.idx == o.cursor {
						prefix = "    " + cursorSt.Render("\u25B8 ")
					}
					name := truncate(ir.repo.Name, modalW-18)
					branch := graySt.Render(ir.repo.Branch)
					repoLines = append(repoLines, struct {
						line string
						idx  int
					}{prefix + inputSt.Render(name) + "  " + branch, ir.idx})
				}
			}
		}

		if len(o.repos) == 0 {
			lines = append(lines, graySt.Render("    no repos available"))
			lines = append(lines, graySt.Render("    configure scan_dirs in config.toml"))
		} else {
			for _, rl := range repoLines {
				lines = append(lines, rl.line)
			}
		}

	case stepTypeBranch:
		selected := o.repos[o.cursor]
		lines = append(lines, dimSt.Render("  Repo: "+selected.Name))
		lines = append(lines, "")
		lines = append(lines, dimSt.Render("  Branch name (type/id/slug):"))
		lines = append(lines, "")
		cursor := inputSt.Render(o.input) + cursorSt.Render("\u2588")
		lines = append(lines, "  "+cursor)
	}

	lines = append(lines, "")
	lines = append(lines, graySt.Render("  esc cancel  enter confirm"))

	content := strings.Join(lines, "\n")

	modal := lipgloss.NewStyle().
		Width(modalW).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(catBlue).
		Background(lipgloss.Color("#0E1525")).
		Padding(1, 0).
		Render(content)

	// Center the modal
	return lipgloss.Place(o.width, o.height, lipgloss.Center, lipgloss.Center, modal)
}

func groupByMainProject(worktrees []indexedRepo) []repoGroup {
	order := []string{}
	groups := map[string][]indexedRepo{}
	for _, ir := range worktrees {
		proj := ir.repo.MainProject
		if proj == "" {
			proj = "other"
		}
		if _, exists := groups[proj]; !exists {
			order = append(order, proj)
		}
		groups[proj] = append(groups[proj], ir)
	}
	var result []repoGroup
	for _, proj := range order {
		result = append(result, repoGroup{project: proj, entries: groups[proj]})
	}
	return result
}

func truncate(s string, maxW int) string {
	if maxW < 5 {
		maxW = 5
	}
	if len(s) > maxW {
		return s[:maxW-2] + ".."
	}
	return s
}
