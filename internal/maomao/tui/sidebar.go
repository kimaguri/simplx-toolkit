package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
)

// sidebarModel is the left-panel task list for the workspace TUI.
type sidebarModel struct {
	tasks        []TaskEntry
	events       []event.Event
	cursor       int
	width        int
	height       int
	focused      bool
	taskStatuses map[string]string        // task ID -> status ("running", "cached")
	repoStatuses map[string]gitStatus     // repoName -> git status
	tdSummaries  map[string]*tdTaskSummary // task ID -> TD summary
}

// newSidebar creates a sidebar populated with the given tasks.
func newSidebar(tasks []TaskEntry, width, height int) sidebarModel {
	return sidebarModel{
		tasks:  tasks,
		cursor: 0,
		width:  width,
		height: height,
	}
}

// Update handles keyboard navigation (j/k, up/down).
func (s sidebarModel) Update(msg tea.Msg) (sidebarModel, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		switch key.String() {
		case "j", "down":
			if len(s.tasks) > 0 && s.cursor < len(s.tasks)-1 {
				s.cursor++
			}
		case "k", "up":
			if s.cursor > 0 {
				s.cursor--
			}
		}
	}
	return s, nil
}

// View renders the sidebar task list with a polished box container.
func (s sidebarModel) View() string {
	// Styles adapt to focus state: bright when focused, muted when not
	var headerSt, labelSt, dimSt, graySt, cursorSt lipgloss.Style
	if s.focused {
		headerSt = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7dcfff"))
		labelSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#c0caf5"))
		dimSt = lipgloss.NewStyle().Foreground(catDimWhite)
		graySt = lipgloss.NewStyle().Foreground(catGray)
		cursorSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#7dcfff")).Bold(true)
	} else {
		headerSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89"))
		labelSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89"))
		dimSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#3b4261"))
		graySt = lipgloss.NewStyle().Foreground(lipgloss.Color("#3b4261"))
		cursorSt = lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89"))
	}

	selWidth := s.width - 4
	if selWidth < 1 {
		selWidth = 1
	}
	selectedBg := lipgloss.NewStyle().
		Background(lipgloss.Color("#1E2D4A")).
		Width(selWidth)

	var lines []string

	// Anime logo header
	logoBorderColor := lipgloss.Color("#3b4261")
	if s.focused {
		logoBorderColor = lipgloss.Color("#7dcfff")
	}
	logoSt := lipgloss.NewStyle().Foreground(logoBorderColor)
	var nameRendered, subRendered string
	if s.focused {
		nameRendered = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#c0caf5")).Render("マオマオ maomao")
		subRendered = lipgloss.NewStyle().Foreground(catDimWhite).Render("✦ multi-repo agent")
	} else {
		nameRendered = lipgloss.NewStyle().Foreground(lipgloss.Color("#565f89")).Render("マオマオ maomao")
		subRendered = lipgloss.NewStyle().Foreground(lipgloss.Color("#3b4261")).Render("✦ multi-repo agent")
	}

	nameW := lipgloss.Width(nameRendered)
	subW := lipgloss.Width(subRendered)
	boxW := s.width - 4
	if boxW < 22 {
		boxW = 22
	}

	// Top: " ╭─ マオマオ maomao ──...──╮"
	topDash := boxW - nameW - 5
	if topDash < 1 {
		topDash = 1
	}
	lines = append(lines, " "+logoSt.Render("╭─ ")+nameRendered+" "+logoSt.Render(strings.Repeat("─", topDash)+"╮"))

	// Mid: " │  ✦ multi-repo agent   │"
	midPad := boxW - subW - 4
	if midPad < 0 {
		midPad = 0
	}
	lines = append(lines, " "+logoSt.Render("│  ")+subRendered+strings.Repeat(" ", midPad)+logoSt.Render("│"))

	// Bot: " ╰────...────╯"
	botDash := boxW - 2
	if botDash < 1 {
		botDash = 1
	}
	lines = append(lines, " "+logoSt.Render("╰"+strings.Repeat("─", botDash)+"╯"))

	// Section header
	lines = append(lines, "  "+headerSt.Render("Tasks"))
	lines = append(lines, graySt.Render(" "+strings.Repeat("─", s.width-4)))

	if len(s.tasks) == 0 {
		lines = append(lines, "")
		lines = append(lines, graySt.Render("   no tasks yet"))
		lines = append(lines, graySt.Render("   create one from dashboard"))
	} else {
		lines = append(lines, "") // spacing

		for i, t := range s.tasks {
			mark := graySt.Render("○") // default: not started
			if status, ok := s.taskStatuses[t.ID]; ok {
				switch status {
				case "running":
					mark = lipgloss.NewStyle().Foreground(catBlue).Render("●") // blue = process alive
				case "cached":
					mark = graySt.Render("◉") // gray = stopped/cached
				}
			} else if t.Active {
				mark = lipgloss.NewStyle().Foreground(catBlue).Render("●")
			}
			// Override mark based on task status (review/done)
			switch t.Status {
			case "review":
				mark = lipgloss.NewStyle().Foreground(lipgloss.Color("#bb9af7")).Render("◈")
			case "done":
				mark = lipgloss.NewStyle().Foreground(lipgloss.Color("#9ece6a")).Render("✓")
			}

			// Truncate title to fit
			maxTitleW := s.width - 21
			if maxTitleW < 5 {
				maxTitleW = 5
			}
			title := t.Title
			if len(title) > maxTitleW {
				title = title[:maxTitleW-2] + ".."
			}

			prefix := "  "
			if i == s.cursor {
				prefix = cursorSt.Render("\u25B8 ")
			}

			line := fmt.Sprintf("%s%s %s", prefix, mark, labelSt.Render(t.ID))
			if i == s.cursor {
				line = selectedBg.Render(line)
			}
			lines = append(lines, line)

			// Show title underneath for selected item only (cleaner list)
			if i == s.cursor {
				lines = append(lines, dimSt.Render("     "+title))
			}
		}

		// Detail block for selected task
		if s.cursor >= 0 && s.cursor < len(s.tasks) {
			selected := s.tasks[s.cursor]
			lines = append(lines, "")
			lines = append(lines, graySt.Render(" "+strings.Repeat("\u2500", s.width-4)))
			lines = append(lines, "  "+headerSt.Render("Detail"))
			lines = append(lines, "")

			detail := func(key, val string) string {
				return fmt.Sprintf("   %s %s",
					graySt.Render(key),
					dimSt.Render(val))
			}

			lines = append(lines, detail("type:", selected.Type))

			// Color-coded status display
			statusVal := selected.Status
			var statusRendered string
			switch selected.Status {
			case "review":
				statusRendered = lipgloss.NewStyle().Foreground(lipgloss.Color("#bb9af7")).Render(statusVal)
			case "done":
				statusRendered = lipgloss.NewStyle().Foreground(lipgloss.Color("#9ece6a")).Render(statusVal)
			case "active":
				statusRendered = lipgloss.NewStyle().Foreground(catBlue).Render(statusVal)
			default:
				statusRendered = dimSt.Render(statusVal)
			}
			lines = append(lines, fmt.Sprintf("   %s %s", graySt.Render("status:"), statusRendered))

			repoWord := "repos"
			if selected.Repos == 1 {
				repoWord = "repo"
			}
			lines = append(lines, detail("repos:", fmt.Sprintf("%d %s", selected.Repos, repoWord)))

			if len(selected.RepoNames) > 0 {
				maxRepoW := s.width - 10 // 2 border + 5 indent + 2 bullet + 1 pad
				if maxRepoW < 10 {
					maxRepoW = 10
				}
				for _, name := range selected.RepoNames {
					statusLabel := ""
					if s.repoStatuses != nil {
						if gs, ok := s.repoStatuses[name]; ok {
							statusLabel = " " + gs.Label()
						}
					}
					display := name + statusLabel
					if len(display) > maxRepoW {
						display = display[:maxRepoW-1] + "\u2026"
					}
					lines = append(lines, dimSt.Render("     \u2022 "+display))
				}
			}

			// Time tracking stats
			if selected.ActiveTime != "" {
				lines = append(lines, "")
				timeColor := lipgloss.Color("#7dcfff")
				if !s.focused {
					timeColor = lipgloss.Color("#3b4261")
				}
				timeSt := lipgloss.NewStyle().Foreground(timeColor)
				lines = append(lines, fmt.Sprintf("   %s %s %s %s",
					timeSt.Render("\u23F1"),
					dimSt.Render(selected.ActiveTime),
					graySt.Render("today:"),
					dimSt.Render(selected.TodayTime)))
				lines = append(lines, fmt.Sprintf("   %s %s",
					graySt.Render("sessions:"),
					dimSt.Render(fmt.Sprintf("%d", selected.SessionCount))))
			}

			// TD task progress
			if s.tdSummaries != nil {
				if ts, ok := s.tdSummaries[selected.ID]; ok && ts != nil && ts.Total > 0 {
					lines = append(lines, "")
					tdLabel := ts.Label()
					if len(tdLabel) > s.width-8 {
						tdLabel = tdLabel[:s.width-11] + "..."
					}
					lines = append(lines, fmt.Sprintf("   %s %s",
						graySt.Render("td:"),
						dimSt.Render(tdLabel)))
				}
			}
		}
	}

	// Recent events timeline
	if len(s.events) > 0 {
		lines = append(lines, "")
		lines = append(lines, graySt.Render(" "+strings.Repeat("─", s.width-4)))
		lines = append(lines, "  "+headerSt.Render("Recent"))
		lines = append(lines, "")
		for _, evt := range s.events {
			ts := evt.Timestamp.Format("15:04")
			icon := evt.Icon()
			label := evt.ShortLabel()
			// Truncate label if needed
			maxLabelW := s.width - 15
			if maxLabelW < 10 {
				maxLabelW = 10
			}
			if len(label) > maxLabelW {
				label = label[:maxLabelW-2] + ".."
			}
			lines = append(lines, fmt.Sprintf("   %s  %s %s",
				graySt.Render(ts),
				dimSt.Render(icon),
				dimSt.Render(label)))
		}
	}

	// Scroll viewport: pin logo header, scroll task list
	pinnedCount := 3 // logo header lines (top/mid/bot)
	pinned := lines
	scrollable := []string{}
	if len(lines) > pinnedCount {
		pinned = lines[:pinnedCount]
		scrollable = lines[pinnedCount:]
	}

	// Available height for scrollable content
	scrollH := s.height - pinnedCount - 2 // -2 for top+bottom border
	if scrollH < 1 {
		scrollH = 1
	}

	// Calculate cursor position within scrollable content
	// Layout after pinned: section header + separator + blank = 3 lines, then tasks
	cursorLine := 0
	if len(s.tasks) > 0 {
		taskLineStart := 3 // "Tasks" header + separator + blank line
		lineIdx := 0
		for i := 0; i < len(s.tasks) && i <= s.cursor; i++ {
			if i == s.cursor {
				cursorLine = taskLineStart + lineIdx
				break
			}
			lineIdx++ // task line
			if i == s.cursor-1 {
				// selected task has title line too, but that's the previous cursor
			}
		}
	}

	// Compute scroll offset to keep cursor visible
	scrollOffset := 0
	if cursorLine >= scrollH {
		scrollOffset = cursorLine - scrollH + 2 // +2 for some context
	}
	if scrollOffset < 0 {
		scrollOffset = 0
	}

	// Apply scroll
	visibleScrollable := scrollable
	if scrollOffset < len(scrollable) {
		endIdx := scrollOffset + scrollH
		if endIdx > len(scrollable) {
			endIdx = len(scrollable)
		}
		visibleScrollable = scrollable[scrollOffset:endIdx]
	} else if len(scrollable) > 0 {
		// scrollOffset beyond content, show last chunk
		startIdx := len(scrollable) - scrollH
		if startIdx < 0 {
			startIdx = 0
		}
		visibleScrollable = scrollable[startIdx:]
	}

	allVisible := append(pinned, visibleScrollable...)

	content := strings.Join(allVisible, "\n")

	// Full 4-sided box border (teal when focused)
	borderFg := lipgloss.Color("#3b4261")
	if s.focused {
		borderFg = lipgloss.Color("#7dcfff")
	}
	borderSt := lipgloss.NewStyle().Foreground(borderFg)

	innerW := s.width - 2 // left + right border
	if innerW < 1 {
		innerW = 1
	}

	// Top border
	topBar := borderSt.Render("╭" + strings.Repeat("─", innerW) + "╮")

	// Side borders on each content line
	contentLines := strings.Split(content, "\n")
	var bordered []string
	leftB := borderSt.Render("│")
	rightB := borderSt.Render("│")
	for _, line := range contentLines {
		lineW := lipgloss.Width(line)
		pad := innerW - lineW
		if pad < 0 {
			pad = 0
		}
		bordered = append(bordered, leftB+line+strings.Repeat(" ", pad)+rightB)
	}
	// Pad to fill height (-2 for top/bottom border)
	for len(bordered) < s.height-2 {
		bordered = append(bordered, leftB+strings.Repeat(" ", innerW)+rightB)
	}
	bordered = bordered[:s.height-2] // trim to exact height

	// Bottom border
	bottomBar := borderSt.Render("╰" + strings.Repeat("─", innerW) + "╯")

	return topBar + "\n" + strings.Join(bordered, "\n") + "\n" + bottomBar
}

// SelectedTask returns the task under the cursor, or nil if the list is empty.
func (s *sidebarModel) SelectedTask() *TaskEntry {
	if len(s.tasks) == 0 || s.cursor < 0 || s.cursor >= len(s.tasks) {
		return nil
	}
	return &s.tasks[s.cursor]
}

// SetRepoStatuses updates the cached git status for each repo.
func (s *sidebarModel) SetRepoStatuses(statuses map[string]gitStatus) {
	s.repoStatuses = statuses
}

// SetTdSummary updates the cached TD summary for a task.
func (s *sidebarModel) SetTdSummary(taskID string, summary *tdTaskSummary) {
	if s.tdSummaries == nil {
		s.tdSummaries = make(map[string]*tdTaskSummary)
	}
	s.tdSummaries[taskID] = summary
}

// SetTasks replaces the task list and clamps the cursor to valid bounds.
func (s *sidebarModel) SetTasks(tasks []TaskEntry) {
	s.tasks = tasks
	if len(s.tasks) == 0 {
		s.cursor = 0
	} else if s.cursor >= len(s.tasks) {
		s.cursor = len(s.tasks) - 1
	}
}

// taskIndexFromY maps a Y coordinate to a task index.
// Returns -1 if the click doesn't correspond to a task item.
// Layout: logo(3) + header(1) + separator(1) + blank(1) = 6 header lines,
// then each task is 1 line (2 lines for selected item with title).
func (s *sidebarModel) taskIndexFromY(y int) int {
	if len(s.tasks) == 0 {
		return -1
	}
	// Header takes 6 lines (logo box 3 + section header + separator + blank)
	taskStartY := 7
	row := 0
	for i := range s.tasks {
		if y == taskStartY+row {
			return i
		}
		row++
		// Selected task shows title line underneath
		if i == s.cursor {
			row++
		}
	}
	return -1
}
