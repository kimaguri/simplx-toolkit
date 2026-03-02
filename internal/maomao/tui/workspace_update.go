package tui

import (
	"strings"
	"time"

	"github.com/atotto/clipboard"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
)

func (w *Workspace) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w.SetSize(msg.Width, msg.Height)
		return w, nil

	case taskOpenMsg:
		return w, w.openTask(msg.task)

	case paneRefreshMsg:
		for i := range w.panes {
			w.panes[i].tick++
			if w.panes[i].vterm != nil {
				raw := w.panes[i].vterm.Render()
				// Dirty check: skip string processing if content unchanged
				if raw != w.panes[i].lastRawContent {
					w.panes[i].lastRawContent = raw
					// VTerm uses \r\n line separators — strip \r to avoid display corruption
					raw = strings.ReplaceAll(raw, "\r\n", "\n")
					raw = strings.ReplaceAll(raw, "\r", "")
					w.panes[i].content = raw
					// Invalidate scrollback cache on content change
					w.panes[i].cachedScrollResult = ""
					// Scrollback is fed by sanitized PTY output in readPTY — no TUI-side diff needed
					if w.panes[i].loading {
						plain := ansi.Strip(raw)
						if strings.TrimSpace(plain) != "" {
							w.panes[i].loading = false
						}
					}
				}
			}
		}
		// Sync sidebar task status indicators every 500ms (10 ticks)
		if len(w.panes) > 0 && w.panes[0].tick%10 == 0 {
			w.updateTaskStatuses()
		}
		// Async git status fetch every ~3s (60 ticks * 50ms)
		var cmds []tea.Cmd
		// Refresh TD summary every ~30s (600 ticks * 50ms)
		if len(w.panes) > 0 && w.panes[0].tick%600 == 0 &&
			w.activeID != "" && w.panes[0].worktreeDir != "" {
			cmds = append(cmds, fetchTdSummaryCmd(w.panes[0].worktreeDir, w.activeID))
		}
		if len(w.panes) > 0 && w.panes[0].tick%60 == 0 && !w.gitFetchPending {
			dirs := make(map[string]string, len(w.panes))
			for _, p := range w.panes {
				if p.worktreeDir != "" {
					dirs[p.name] = p.worktreeDir
				}
			}
			if len(dirs) > 0 {
				w.gitFetchPending = true
				cmds = append(cmds, fetchGitStatusesCmd(dirs))
			}
		}
		if w.hasRunningPanes() {
			cmds = append(cmds, schedulePaneRefresh())
		}
		if len(cmds) == 0 {
			return w, nil
		}
		return w, tea.Batch(cmds...)

	case gitStatusResultMsg:
		w.gitFetchPending = false
		w.sidebar.SetRepoStatuses(msg.statuses)
		return w, nil

	case diffResultMsg:
		d := newDiffOverlay(msg.content, "", msg.paneName, w.width, w.height)
		w.diffOverlay = &d
		// Don't show overlay during interactive mode — user is typing
		if w.mode == modeInteractive {
			w.diffOverlay = nil
		}
		return w, nil

	case tdStatusResultMsg:
		w.tdContent = msg.content
		// Don't activate overlay during interactive mode — it would steal all input
		if w.mode != modeInteractive {
			w.tdOverlay = true
		}
		return w, nil

	case tdSummaryResultMsg:
		w.sidebar.SetTdSummary(msg.taskID, msg.summary)
		return w, nil

	case overlayResultMsg:
		return w.handleOverlayResult(msg)

	case handoffScanMsg:
		return w.handleHandoffScan()

	case handoffDetectedMsg:
		return w.handleHandoffDetected(msg)

	case handoffResultMsg:
		return w.handleHandoffResult(msg)

	case messageResultMsg:
		return w.handleMessageResult(msg)

	case tea.MouseMsg:
		if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft {
			return w.handleMouseClick(msg.X, msg.Y)
		}
		// Scroll wheel: use scrollback if available, otherwise forward to PTY
		if w.paneIdx < len(w.panes) {
			p := &w.panes[w.paneIdx]
			switch msg.Button {
			case tea.MouseButtonWheelUp:
				if p.scrollback != nil {
					p.scrollOff += 3
					// Clamp: can't scroll past the beginning of scrollback
					total := p.scrollback.Len()
					visibleH := p.height - 3 // match innerH calc from View()
					if visibleH < 1 {
						visibleH = 1
					}
					maxOff := total - visibleH
					if maxOff < 0 {
						maxOff = 0
					}
					if p.scrollOff > maxOff {
						p.scrollOff = maxOff
					}
				} else if p.ptyWriter != nil {
					p.ptyWriter.Write([]byte("\x1b[5~"))
				}
			case tea.MouseButtonWheelDown:
				if p.scrollback != nil {
					p.scrollOff -= 3
					if p.scrollOff < 0 {
						p.scrollOff = 0
					}
				} else if p.ptyWriter != nil {
					p.ptyWriter.Write([]byte("\x1b[6~"))
				}
			}
		}
		return w, nil

	case rawInputMsg:
		// Raw stdin bytes in interactive mode — forward directly to PTY
		if w.mode == modeInteractive && w.paneIdx < len(w.panes) {
			p := &w.panes[w.paneIdx]
			if p.ptyWriter != nil {
				if _, err := p.ptyWriter.Write([]byte(msg)); err != nil {
					// Process exited — exit interactive mode
					p.status = paneStopped
					p.interactive = false
					p.ptyWriter = nil
					w.mode = modeNavigate
					if w.stdinProxy != nil {
						w.stdinProxy.SetInteractive(false)
					}
					w.syncStatusBar()
				}
			}
		}
		return w, nil

	case exitInteractiveMsg:
		// Double-Esc detected by raw stdin proxy — exit interactive mode
		w.mode = modeNavigate
		if w.paneIdx < len(w.panes) {
			w.panes[w.paneIdx].interactive = false
		}
		if w.stdinProxy != nil {
			w.stdinProxy.SetInteractive(false)
		}
		w.syncStatusBar()
		return w, nil

	case tabSwitchMsg:
		// Tab detected by raw stdin proxy — exit interactive + switch pane
		w.mode = modeNavigate
		if w.paneIdx < len(w.panes) {
			w.panes[w.paneIdx].interactive = false
		}
		if w.stdinProxy != nil {
			w.stdinProxy.SetInteractive(false)
		}
		// Switch to next pane (same logic as Tab in navigate mode)
		if w.sidebarHidden {
			if len(w.panes) > 0 {
				w.focus = focusPanes
				w.paneIdx = (w.paneIdx + 1) % len(w.panes)
			}
		} else if w.focus == focusPanes && w.paneIdx < len(w.panes)-1 {
			w.paneIdx++
		} else {
			w.focus = focusSidebar
		}
		w.updateFocusState()
		w.syncStatusBar()
		return w, nil

	case tea.KeyMsg:
		// Interactive mode has highest priority — keys go to agent, not overlays.
		// Overlays that arrive during interactive mode are suppressed (see diffResultMsg/tdStatusResultMsg).
		if w.mode == modeInteractive {
			return w.updateInteractive(msg)
		}
		// td status overlay
		if w.tdOverlay {
			if msg.String() == "esc" || msg.String() == "q" || msg.String() == "t" {
				w.tdOverlay = false
			}
			return w, nil
		}
		// Diff overlay
		if w.diffOverlay != nil {
			switch msg.String() {
			case "q", "esc", "d":
				w.diffOverlay = nil
			case "j", "down":
				w.diffOverlay.scrollOff++
				maxOff := len(w.diffOverlay.lines) - (w.height - 10)
				if maxOff < 0 {
					maxOff = 0
				}
				if w.diffOverlay.scrollOff > maxOff {
					w.diffOverlay.scrollOff = maxOff
				}
			case "k", "up":
				w.diffOverlay.scrollOff--
				if w.diffOverlay.scrollOff < 0 {
					w.diffOverlay.scrollOff = 0
				}
			case "G":
				// Jump to end
				maxOff := len(w.diffOverlay.lines) - (w.height - 10)
				if maxOff < 0 {
					maxOff = 0
				}
				w.diffOverlay.scrollOff = maxOff
			case "g":
				// Jump to start
				w.diffOverlay.scrollOff = 0
			}
			return w, nil
		}
		// Quit confirmation
		if w.quitConfirm {
			switch msg.String() {
			case "y":
				return w, tea.Quit
			case "n", "esc":
				w.quitConfirm = false
			}
			return w, nil
		}
		if w.deleteConfirm {
			switch msg.String() {
			case "j", "down":
				if w.deleteCursor < 1 {
					w.deleteCursor++
				}
			case "k", "up":
				if w.deleteCursor > 0 {
					w.deleteCursor--
				}
			case "enter":
				keepBranches := w.deleteCursor == 1
				taskID := w.deleteTaskID
				w.deleteConfirm = false
				// Stop agents if this is the active task
				if taskID == w.activeID {
					if w.paneCtrl != nil {
						for _, p := range w.panes {
							if p.status == paneRunning {
								w.paneCtrl.Stop(p.processKey)
							}
						}
					}
					w.panes = nil
					w.activeID = ""
					w.paneIdx = 0
					w.focus = focusSidebar
					w.fullscreen = false
					w.updateFocusState()
				}
				// Remove from pane cache
				delete(w.taskPanes, taskID)
				// Call delete callback
				w.deleteTask(taskID, keepBranches)
				event.Emit(event.New(event.TaskDeleted, taskID, "", ""))
				w.refreshSidebar()
				w.syncStatusBar()
			case "esc", "n":
				w.deleteConfirm = false
			}
			return w, nil
		}
		if w.mode == modeOverlay {
			return w.updateOverlay(msg)
		}
		return w.updateNavigate(msg)
	}
	return w, nil
}

func (w *Workspace) updateInteractive(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	// When stdinProxy is active, raw bytes are forwarded via rawInputMsg.
	// Ignore KeyMsg to avoid double-sending to PTY.
	if w.stdinProxy != nil && w.stdinProxy.interactive.Load() {
		return w, nil
	}

	// Fallback: non-proxy mode (direct PTY without stdinProxy)
	// Tab: exit interactive + switch pane (same as tabSwitchMsg)
	if msg.Type == tea.KeyTab {
		w.mode = modeNavigate
		if w.paneIdx < len(w.panes) {
			w.panes[w.paneIdx].interactive = false
		}
		if w.sidebarHidden {
			if len(w.panes) > 0 {
				w.focus = focusPanes
				w.paneIdx = (w.paneIdx + 1) % len(w.panes)
			}
		} else if w.focus == focusPanes && w.paneIdx < len(w.panes)-1 {
			w.paneIdx++
		} else {
			w.focus = focusSidebar
		}
		w.updateFocusState()
		w.syncStatusBar()
		return w, nil
	}

	// Double-Esc detection
	if msg.Type == tea.KeyEscape {
		now := time.Now()
		if !w.lastEsc.IsZero() && now.Sub(w.lastEsc) < 300*time.Millisecond {
			// Double-Esc: exit interactive
			w.mode = modeNavigate
			if w.paneIdx < len(w.panes) {
				w.panes[w.paneIdx].interactive = false
			}
			w.syncStatusBar()
			w.lastEsc = time.Time{}
			return w, nil
		}
		w.lastEsc = now
		// Still forward single Esc to PTY
	}

	// Paste from clipboard
	if msg.String() == "ctrl+v" {
		if text, err := clipboard.ReadAll(); err == nil && text != "" {
			if w.paneIdx < len(w.panes) && w.panes[w.paneIdx].ptyWriter != nil {
				if _, err := w.panes[w.paneIdx].ptyWriter.Write([]byte(text)); err != nil {
					// Process exited — exit interactive mode
					w.panes[w.paneIdx].status = paneStopped
					w.panes[w.paneIdx].interactive = false
					w.panes[w.paneIdx].ptyWriter = nil
					w.mode = modeNavigate
					w.syncStatusBar()
				}
			}
		}
		return w, nil
	}

	// Forward key to focused pane
	if w.paneIdx < len(w.panes) {
		w.panes[w.paneIdx], _ = w.panes[w.paneIdx].Update(msg)
		// If pane detected a write failure, it clears interactive flag — sync workspace mode
		if !w.panes[w.paneIdx].interactive {
			w.mode = modeNavigate
			w.syncStatusBar()
		}
	}
	return w, nil
}
