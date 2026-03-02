package tui

import (
	"github.com/atotto/clipboard"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
)

func (w *Workspace) updateNavigate(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	key := msg.String()

	// Global keys
	switch key {
	case "q", "ctrl+c":
		w.quitConfirm = true
		return w, nil
	case "b":
		// Toggle sidebar visibility
		w.sidebarHidden = !w.sidebarHidden
		if w.sidebarHidden && w.focus == focusSidebar && len(w.panes) > 0 {
			w.focus = focusPanes
			w.paneIdx = 0
		}
		w.updateFocusState()
		w.syncStatusBar()
		w.resizeTerminals()
		return w, nil
	case "tab":
		// Cycle: sidebar → pane0 → pane1 → ... → sidebar
		if w.sidebarHidden {
			// Sidebar hidden — cycle only panes
			if len(w.panes) > 0 {
				w.focus = focusPanes
				w.paneIdx = (w.paneIdx + 1) % len(w.panes)
			}
			w.updateFocusState()
			w.syncStatusBar()
			return w, nil
		}
		if w.focus == focusSidebar && len(w.panes) > 0 {
			w.focus = focusPanes
			w.paneIdx = 0
		} else if w.focus == focusPanes && w.paneIdx < len(w.panes)-1 {
			w.paneIdx++
		} else {
			w.focus = focusSidebar
		}
		w.updateFocusState()
		w.syncStatusBar()
		return w, nil
	case "shift+tab":
		// Reverse cycle: sidebar ← pane0 ← pane1 ← ...
		if w.sidebarHidden {
			if len(w.panes) > 0 {
				w.focus = focusPanes
				w.paneIdx--
				if w.paneIdx < 0 {
					w.paneIdx = len(w.panes) - 1
				}
			}
			w.updateFocusState()
			w.syncStatusBar()
			return w, nil
		}
		if w.focus == focusSidebar && len(w.panes) > 0 {
			w.focus = focusPanes
			w.paneIdx = len(w.panes) - 1
		} else if w.focus == focusPanes && w.paneIdx > 0 {
			w.paneIdx--
		} else {
			w.focus = focusSidebar
		}
		w.updateFocusState()
		w.syncStatusBar()
		return w, nil
	}

	if w.focus == focusSidebar {
		return w.updateSidebarKeys(msg)
	}
	return w.updatePaneKeys(msg)
}

func (w *Workspace) updateSidebarKeys(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	switch msg.String() {
	case "j", "k", "down", "up":
		w.sidebar, _ = w.sidebar.Update(msg)
		// Auto-switch to cached task on cursor move
		if sel := w.sidebar.SelectedTask(); sel != nil && sel.ID != w.activeID {
			if _, cached := w.taskPanes[sel.ID]; cached {
				task := *sel
				return w, func() tea.Msg { return taskOpenMsg{task: task} }
			}
		}
	case "enter":
		if sel := w.sidebar.SelectedTask(); sel != nil {
			task := *sel
			return w, func() tea.Msg { return taskOpenMsg{task: task} }
		}
	case "n":
		if w.loadRepos != nil && w.createTask != nil {
			repos := w.loadRepos()
			if len(repos) > 0 {
				w.overlay = newOverlay(overlayNewTask, repos, w.width, w.height)
				w.mode = modeOverlay
				w.syncStatusBar()
			}
		}
	case "d":
		if sel := w.sidebar.SelectedTask(); sel != nil && w.deleteTask != nil {
			w.deleteConfirm = true
			w.deleteTaskID = sel.ID
			w.deleteCursor = 0
		}
	case "r":
		w.refreshSidebar()
	case "R":
		// Mark selected task as review
		if sel := w.sidebar.SelectedTask(); sel != nil && sel.ID != "" {
			if t, err := task.Load(sel.ID); err == nil {
				t.Status = task.StatusReview
				_ = task.Save(t)
				w.refreshSidebar()
			}
		}
	case "D":
		// Mark selected task as done
		if sel := w.sidebar.SelectedTask(); sel != nil && sel.ID != "" {
			if t, err := task.Load(sel.ID); err == nil {
				t.Status = task.StatusDone
				_ = task.Save(t)
				w.refreshSidebar()
			}
		}
	}
	return w, nil
}

func (w *Workspace) updatePaneKeys(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	switch msg.String() {
	case "i":
		if len(w.panes) > 0 && w.paneIdx < len(w.panes) && w.panes[w.paneIdx].status == paneRunning {
			w.mode = modeInteractive
			w.panes[w.paneIdx].interactive = true
			if w.stdinProxy != nil {
				w.stdinProxy.SetInteractive(true)
			}
			w.syncStatusBar()
		}
	case "s":
		// Stop the focused pane's agent and remove the pane
		if w.paneCtrl != nil && w.paneIdx < len(w.panes) && w.panes[w.paneIdx].status == paneRunning {
			key := w.panes[w.paneIdx].processKey
			if err := w.paneCtrl.Stop(key); err == nil {
				w.panes = append(w.panes[:w.paneIdx], w.panes[w.paneIdx+1:]...)
				// Update cache
				if w.activeID != "" {
					w.taskPanes[w.activeID] = w.panes
				}
				// Fix focus after removal
				if len(w.panes) == 0 {
					w.paneIdx = 0
					w.focus = focusSidebar
					w.fullscreen = false
				} else if w.paneIdx >= len(w.panes) {
					w.paneIdx = len(w.panes) - 1
				}
				w.updateFocusState()
				w.syncStatusBar()
			}
		}
	case "r":
		// Restart the focused pane's agent
		if w.paneCtrl != nil && w.paneIdx < len(w.panes) {
			key := w.panes[w.paneIdx].processKey
			pi, err := w.paneCtrl.Restart(key)
			if err == nil && pi != nil {
				w.panes[w.paneIdx].vterm = pi.VTerm
				w.panes[w.paneIdx].ptyWriter = pi.PTYWriter
				w.panes[w.paneIdx].status = paneRunning
				w.panes[w.paneIdx].content = ""
				return w, schedulePaneRefresh()
			}
		}
	case "f":
		// Toggle fullscreen for focused pane
		w.fullscreen = !w.fullscreen
		w.resizeTerminals()
	case "p":
		// Park the active task
		if w.parkTask != nil && w.activeID != "" {
			// Stop all agents for this task
			if w.paneCtrl != nil {
				for _, p := range w.panes {
					if p.status == paneRunning {
						w.paneCtrl.Stop(p.processKey)
					}
				}
			}
			event.Emit(event.New(event.TaskParked, w.activeID, "", ""))
			w.parkTask(w.activeID)
			// Remove from cache and clear
			delete(w.taskPanes, w.activeID)
			w.panes = nil
			w.activeID = ""
			w.paneIdx = 0
			w.focus = focusSidebar
			w.fullscreen = false
			w.updateFocusState()
			w.syncStatusBar()
			w.refreshSidebar()
		}
	case "a":
		// Add repo to current task
		if w.loadRepos != nil && w.addRepo != nil && w.activeID != "" {
			repos := w.loadRepos()
			// Filter out repos already in this task
			existing := make(map[string]bool)
			for _, p := range w.panes {
				existing[p.name] = true
			}
			var available []RepoEntry
			for _, r := range repos {
				if !existing[r.Name] {
					available = append(available, r)
				}
			}
			if len(available) > 0 {
				w.overlay = newOverlay(overlayAddRepo, available, w.width, w.height)
				w.mode = modeOverlay
				w.syncStatusBar()
			}
		}
	case "g":
		// Launch lazygit in the focused pane's worktree directory
		if w.paneLauncher != nil && w.paneIdx < len(w.panes) && w.panes[w.paneIdx].worktreeDir != "" {
			pane := &w.panes[w.paneIdx]
			// Stop current agent if running
			if pane.status == paneRunning && w.paneCtrl != nil {
				w.paneCtrl.Stop(pane.processKey)
			}
			lgKey := pane.processKey + ":lazygit"
			pi, err := w.paneLauncher(PaneLaunchInfo{
				ProcessKey: lgKey,
				Command:    "lazygit",
				Args:       []string{"-p", pane.worktreeDir},
				WorkDir:    pane.worktreeDir,
			})
			if err == nil && pi != nil {
				pane.vterm = pi.VTerm
				pane.ptyWriter = pi.PTYWriter
				pane.status = paneRunning
				pane.content = ""
				pane.interactive = true
				w.mode = modeInteractive
				if w.stdinProxy != nil {
					w.stdinProxy.SetInteractive(true)
				}
				w.syncStatusBar()
				return w, schedulePaneRefresh()
			}
		}
	case "t":
		// Show td status for focused pane's worktree (async to avoid blocking UI)
		if w.paneIdx < len(w.panes) && w.panes[w.paneIdx].worktreeDir != "" {
			return w, fetchTdStatusCmd(w.panes[w.paneIdx].worktreeDir)
		}
	case "y":
		// Copy focused pane content to clipboard
		if len(w.panes) > 0 && w.paneIdx < len(w.panes) {
			content := w.panes[w.paneIdx].content
			stripped := ansi.Strip(content)
			clipboard.WriteAll(stripped)
		}
	case "d":
		// Show git diff for focused pane's worktree
		if w.paneIdx < len(w.panes) && w.panes[w.paneIdx].worktreeDir != "" {
			return w, fetchDiffCmd(w.panes[w.paneIdx].worktreeDir, w.panes[w.paneIdx].name)
		}
	case "m":
		// Manual cross-pane message (Task 5)
		if len(w.panes) > 1 {
			names := collectPaneNames(w.panes)
			current := w.panes[w.paneIdx].name
			mo := newMessageOverlay(names, current, w.width, w.height)
			w.msgOverlay = &mo
			w.overlay.kind = overlayMessage
			w.mode = modeOverlay
			w.syncStatusBar()
		}
	default:
		// Auto-enter interactive mode on keystroke
		if len(w.panes) > 0 && w.paneIdx < len(w.panes) &&
			w.panes[w.paneIdx].status == paneRunning && w.panes[w.paneIdx].ptyWriter != nil {
			switch msg.Type {
			case tea.KeyRunes, tea.KeyEnter, tea.KeySpace, tea.KeyBackspace, tea.KeyDelete:
				w.mode = modeInteractive
				w.panes[w.paneIdx].interactive = true
				if w.stdinProxy != nil {
					w.stdinProxy.SetInteractive(true)
				}
				w.syncStatusBar()
				// Forward the key that triggered the switch
				raw := keyMsgToBytes(msg)
				if raw != nil {
					w.panes[w.paneIdx].ptyWriter.Write(raw)
				}
			}
		}
	}
	return w, nil
}
