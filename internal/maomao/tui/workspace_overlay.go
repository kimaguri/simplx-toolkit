package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
)

func (w *Workspace) updateOverlay(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	// Handoff overlay (Task 2)
	if w.overlay.kind == overlayHandoff && w.handoffOvl != nil {
		var cmd tea.Cmd
		*w.handoffOvl, cmd = w.handoffOvl.Update(msg)
		if w.handoffOvl.done {
			w.handoffOvl = nil
			w.overlay.kind = overlayNone
			w.mode = modeNavigate
			w.syncStatusBar()
		}
		return w, cmd
	}

	// Message overlay (Task 5)
	if w.overlay.kind == overlayMessage && w.msgOverlay != nil {
		var cmd tea.Cmd
		*w.msgOverlay, cmd = w.msgOverlay.Update(msg)
		if w.msgOverlay.done {
			w.msgOverlay = nil
			w.overlay.kind = overlayNone
			w.mode = modeNavigate
			w.syncStatusBar()
		}
		return w, cmd
	}

	var cmd tea.Cmd
	w.overlay, cmd = w.overlay.Update(msg)
	// If overlay was dismissed (Esc), return to navigate
	if w.overlay.kind == overlayNone {
		w.mode = modeNavigate
		w.syncStatusBar()
	}
	return w, cmd
}

func (w *Workspace) handleOverlayResult(msg overlayResultMsg) (*Workspace, tea.Cmd) {
	w.mode = modeNavigate
	w.overlay.kind = overlayNone
	w.syncStatusBar()

	switch msg.kind {
	case overlayNewTask:
		if w.createTask != nil {
			taskID, err := w.createTask(msg.branch, msg.repoName, msg.repoPath)
			if err == nil && taskID != "" {
				// Refresh sidebar and open the new task
				w.refreshSidebar()
				// Find the new task in sidebar and open it
				for _, t := range w.sidebar.tasks {
					if t.ID == taskID {
						task := t
						return w, func() tea.Msg { return taskOpenMsg{task: task} }
					}
				}
			}
		}

	case overlayAddRepo:
		if w.addRepo != nil && w.activeID != "" {
			pi, err := w.addRepo(w.activeID, msg.repoName, msg.repoPath)
			if err == nil && pi != nil {
				tp := newTermPane(pi.RepoName, 20, 60)
				tp.colorIdx = len(w.panes) % len(paneColorPalette)
				tp.processKey = pi.ProcessKey
				if tp.processKey == "" {
					tp.processKey = pi.RepoName
				}
				tp.worktreeDir = pi.WorktreeDir
				tp.vterm = pi.VTerm
				tp.ptyWriter = pi.PTYWriter
				tp.scrollback = pi.Scrollback
				if pi.VTerm != nil {
					tp.status = paneRunning
					tp.loading = true
				}
				w.panes = append(w.panes, tp)
				// Update cache
				w.taskPanes[w.activeID] = w.panes
				// Focus the new pane
				w.paneIdx = len(w.panes) - 1
				w.focus = focusPanes
				w.updateFocusState()
				w.syncStatusBar()
				// Resize terminals to account for new pane layout
				w.resizeTerminals()
				// Refresh sidebar to show updated repo count
				w.refreshSidebar()
				return w, schedulePaneRefresh()
			}
		}
	}

	return w, nil
}

// handleHandoffScan scans all active worktrees for handoff files.
func (w *Workspace) handleHandoffScan() (*Workspace, tea.Cmd) {
	worktrees := make(map[string]string)
	for _, p := range w.panes {
		if p.worktreeDir != "" {
			worktrees[p.name] = p.worktreeDir
		}
	}
	handoffs := agent.ScanWorktrees(worktrees)
	if len(handoffs) > 0 {
		// Show first handoff as overlay
		return w, func() tea.Msg { return handoffDetectedMsg{handoff: handoffs[0]} }
	}
	// Reschedule scan
	return w, scheduleHandoffScan()
}

// handleHandoffDetected shows the handoff overlay.
func (w *Workspace) handleHandoffDetected(msg handoffDetectedMsg) (*Workspace, tea.Cmd) {
	ovl := newHandoffOverlay(msg.handoff, w.width, w.height)
	w.handoffOvl = &ovl
	w.overlay.kind = overlayHandoff
	w.mode = modeOverlay
	w.syncStatusBar()
	return w, nil
}

// handleHandoffResult processes the user's handoff approval/denial.
func (w *Workspace) handleHandoffResult(msg handoffResultMsg) (*Workspace, tea.Cmd) {
	w.handoffOvl = nil
	w.overlay.kind = overlayNone
	w.mode = modeNavigate
	w.syncStatusBar()

	if msg.approved {
		w.deliverHandoff(msg.handoff)
		agent.MarkDelivered(msg.handoff.FilePath)
	}

	return w, scheduleHandoffScan()
}

// deliverHandoff writes handoff content to the target pane's PTY.
func (w *Workspace) deliverHandoff(h agent.Handoff) {
	event.Emit(event.New(event.HandoffDelivered, "", h.TargetRepo, "from "+h.SourceRepo))
	for i, p := range w.panes {
		if p.name == h.TargetRepo && p.ptyWriter != nil {
			msg := fmt.Sprintf("\n--- Handoff from %s ---\n%s\n--- End Handoff ---\n",
				h.SourceRepo, h.Content)
			w.panes[i].ptyWriter.Write([]byte(msg + "\r"))
			return
		}
	}
}

// handleMessageResult delivers a manual cross-pane message.
func (w *Workspace) handleMessageResult(msg messageResultMsg) (*Workspace, tea.Cmd) {
	w.msgOverlay = nil
	w.overlay.kind = overlayNone
	w.mode = modeNavigate
	w.syncStatusBar()
	event.Emit(event.New(event.MessageSent, "", msg.targetPane, ""))

	for i, p := range w.panes {
		if p.name == msg.targetPane && p.ptyWriter != nil {
			w.panes[i].ptyWriter.Write([]byte(msg.message + "\r"))
			break
		}
	}
	return w, nil
}
