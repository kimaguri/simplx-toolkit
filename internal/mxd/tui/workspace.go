package tui

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/atotto/clipboard"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/kimaguri/simplx-toolkit/internal/mxd/agent"
	"github.com/kimaguri/simplx-toolkit/internal/mxd/event"
)

// taskOpenMsg signals that a task should be opened (agents launched).
type taskOpenMsg struct {
	task TaskEntry
}

// TaskOpener is called when user opens a task. Returns pane info per repo.
type TaskOpener func(taskID string) ([]PaneInit, error)

// PaneInit holds the info needed to create a terminal pane for a repo.
type PaneInit struct {
	RepoName    string
	ProcessKey  string                       // unique key in ProcessManager (taskID:repoName)
	VTerm       interface{ Render() string } // process.VTermScreen for live refresh
	PTYWriter   io.Writer                    // PTY master fd for interactive input
	WorktreeDir string                       // worktree directory for handoff scanning
}

// PaneLauncher spawns a process and returns pane init (for lazygit, etc.)
type PaneLauncher func(info PaneLaunchInfo) (*PaneInit, error)

// PaneLaunchInfo holds the info needed to launch a process in a pane.
type PaneLaunchInfo struct {
	ProcessKey string
	Command    string
	Args       []string
	WorkDir    string
}

// PaneController provides callbacks to control agent processes from the workspace.
type PaneController struct {
	Stop    func(name string) error
	Restart func(name string) (*PaneInit, error)
}

// paneRefreshMsg triggers VTerm content refresh for all panes.
type paneRefreshMsg struct{}

// schedulePaneRefresh returns a Cmd that fires paneRefreshMsg after 50ms.
func schedulePaneRefresh() tea.Cmd {
	return tea.Tick(50*time.Millisecond, func(time.Time) tea.Msg {
		return paneRefreshMsg{}
	})
}

// TaskCreator creates a task (worktree + persist) and returns the task ID.
type TaskCreator func(branch, repoName, repoPath string) (string, error)

// RepoAdder adds a repo to an existing task and starts its agent.
type RepoAdder func(taskID, repoName, repoPath string) (*PaneInit, error)

// TaskParker parks a task (stops agents, sets status to parked).
type TaskParker func(taskID string) error

// TaskDeleter deletes a task (stops agents, removes worktrees, optionally branches, removes task files).
type TaskDeleter func(taskID string, keepBranches bool) error

// Workspace is the root Bubbletea model for the mxd embedded TUI.
type Workspace struct {
	mode          workspaceMode
	focus         workspaceFocus
	sidebar       sidebarModel
	panes         []termPaneModel
	paneIdx       int // focused pane index
	statusBar     statusBarModel
	loadTasks     func() []TaskEntry
	loadRepos     func() []RepoEntry
	opener        TaskOpener // callback to open a task
	createTask    TaskCreator
	addRepo       RepoAdder
	parkTask      TaskParker
	deleteTask    TaskDeleter
	activeID      string     // currently open task ID
	initialTaskID string     // task to auto-open on start
	taskPanes     map[string][]termPaneModel // cached panes per task ID
	paneCtrl      *PaneController
	paneLauncher  PaneLauncher
	overlay       overlayModel
	handoffOvl    *handoffOverlayModel       // active handoff overlay (Task 2)
	msgOverlay    *messageOverlayModel       // active message overlay (Task 5)
	backToDashboard bool // true = user wants to return to dashboard
	fullscreen    bool // true = show only focused pane
	sidebarHidden bool // true = sidebar collapsed
	quitConfirm    bool // true = showing quit confirmation prompt
	deleteConfirm  bool   // true = showing delete confirmation
	deleteTaskID   string // task being confirmed for deletion
	deleteCursor   int    // 0 = delete all, 1 = keep branches
	width          int
	height        int
	lastEsc       time.Time // for double-Esc detection
}

// NewWorkspace creates the root workspace model.
func NewWorkspace(tasks []TaskEntry, opener TaskOpener, loadTasks func() []TaskEntry, initialTaskID string) *Workspace {
	return &Workspace{
		mode:          modeNavigate,
		focus:         focusSidebar,
		sidebar:       newSidebar(tasks, 30, 20),
		statusBar:     newStatusBar(80),
		opener:        opener,
		loadTasks:     loadTasks,
		initialTaskID: initialTaskID,
		taskPanes:     make(map[string][]termPaneModel),
	}
}

// SetPaneController sets the callbacks for process control.
func (w *Workspace) SetPaneController(ctrl *PaneController) {
	w.paneCtrl = ctrl
}

// SetPaneLauncher sets the callback for launching processes in panes (e.g. lazygit).
func (w *Workspace) SetPaneLauncher(fn PaneLauncher) {
	w.paneLauncher = fn
}

// SetCallbacks sets optional callbacks for task/repo management.
func (w *Workspace) SetCallbacks(loadRepos func() []RepoEntry, create TaskCreator, add RepoAdder, park TaskParker, delete TaskDeleter) {
	w.loadRepos = loadRepos
	w.createTask = create
	w.addRepo = add
	w.parkTask = park
	w.deleteTask = delete
}

func (w *Workspace) Init() tea.Cmd {
	if w.initialTaskID != "" {
		// Find the task in sidebar and auto-open it
		for _, t := range w.sidebar.tasks {
			if t.ID == w.initialTaskID {
				task := t
				w.initialTaskID = "" // consume
				return func() tea.Msg { return taskOpenMsg{task: task} }
			}
		}
	}
	return nil
}

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
				w.panes[i].content = raw
				// Clear loading once VTerm produces visible content
				if w.panes[i].loading && strings.TrimSpace(ansi.Strip(raw)) != "" {
					w.panes[i].loading = false
				}
			}
		}
		// Sync sidebar task status indicators in realtime
		w.updateTaskStatuses()
		// Refresh git statuses every ~3s (60 ticks * 50ms)
		if len(w.panes) > 0 && w.panes[0].tick%60 == 0 {
			w.updateGitStatuses()
		}
		if w.hasRunningPanes() {
			return w, schedulePaneRefresh()
		}
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
		// Forward scroll wheel to focused pane PTY
		if w.paneIdx < len(w.panes) && w.panes[w.paneIdx].ptyWriter != nil {
			switch msg.Button {
			case tea.MouseButtonWheelUp:
				w.panes[w.paneIdx].ptyWriter.Write([]byte("\x1b[5~"))
			case tea.MouseButtonWheelDown:
				w.panes[w.paneIdx].ptyWriter.Write([]byte("\x1b[6~"))
			}
		}
		return w, nil

	case tea.KeyMsg:
		// Quit confirmation takes priority
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
		if w.mode == modeInteractive {
			return w.updateInteractive(msg)
		}
		return w.updateNavigate(msg)
	}
	return w, nil
}

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
		return w, nil
	case "ctrl+d":
		// Return to dashboard
		w.backToDashboard = true
		return w, tea.Quit
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
	}
	return w, nil
}

func (w *Workspace) updatePaneKeys(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
	switch msg.String() {
	case "i":
		if len(w.panes) > 0 && w.paneIdx < len(w.panes) && w.panes[w.paneIdx].status == paneRunning {
			w.mode = modeInteractive
			w.panes[w.paneIdx].interactive = true
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
				w.syncStatusBar()
				return w, schedulePaneRefresh()
			}
		}
	case "y":
		// Copy focused pane content to clipboard
		if len(w.panes) > 0 && w.paneIdx < len(w.panes) {
			content := w.panes[w.paneIdx].content
			stripped := ansi.Strip(content)
			clipboard.WriteAll(stripped)
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

func (w *Workspace) updateInteractive(msg tea.KeyMsg) (*Workspace, tea.Cmd) {
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
				w.panes[w.paneIdx].ptyWriter.Write([]byte(text))
			}
		}
		return w, nil
	}

	// Forward key to focused pane
	if w.paneIdx < len(w.panes) {
		w.panes[w.paneIdx], _ = w.panes[w.paneIdx].Update(msg)
	}
	return w, nil
}

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

func (w *Workspace) View() string {
	if w.width == 0 || w.height == 0 {
		return "Loading..."
	}

	sidebarW := w.width / 4
	if sidebarW < 20 {
		sidebarW = 20
	}
	if sidebarW > 40 {
		sidebarW = 40
	}
	if w.sidebarHidden {
		sidebarW = 0
	}
	rightW := w.width - sidebarW
	contentH := w.height - 1 // -1 for status bar

	// Sidebar
	var left string
	if !w.sidebarHidden {
		w.sidebar.width = sidebarW
		w.sidebar.height = contentH
		left = w.sidebar.View()
	}

	// Panes (right side, horizontally arranged)
	var right string
	if len(w.panes) == 0 {
		placeholder := lipgloss.NewStyle().
			Width(rightW).
			Height(contentH).
			Foreground(catGray).
			Align(lipgloss.Center, lipgloss.Center).
			Render("select a task to start")
		right = placeholder
	} else if w.fullscreen && w.paneIdx < len(w.panes) {
		// Fullscreen: only show focused pane
		w.panes[w.paneIdx].SetSize(contentH, rightW)
		right = w.panes[w.paneIdx].View()
	} else {
		paneW := rightW / len(w.panes)
		var paneViews []string
		for i := range w.panes {
			w.panes[i].SetSize(contentH, paneW)
			paneViews = append(paneViews, w.panes[i].View())
		}
		right = lipgloss.JoinHorizontal(lipgloss.Top, paneViews...)
	}

	var body string
	if w.sidebarHidden {
		body = right
	} else {
		body = lipgloss.JoinHorizontal(lipgloss.Top, left, right)
	}

	// Status bar
	w.statusBar.width = w.width
	bar := w.statusBar.View()

	screen := lipgloss.JoinVertical(lipgloss.Left, body, bar)

	// Overlay on top if active
	if w.mode == modeOverlay {
		if w.overlay.kind == overlayHandoff && w.handoffOvl != nil {
			w.handoffOvl.width = w.width
			w.handoffOvl.height = w.height
			return w.handoffOvl.View()
		}
		if w.overlay.kind == overlayMessage && w.msgOverlay != nil {
			w.msgOverlay.width = w.width
			w.msgOverlay.height = w.height
			return w.msgOverlay.View()
		}
		if w.overlay.kind != overlayNone {
			w.overlay.width = w.width
			w.overlay.height = w.height
			return w.overlay.View()
		}
	}

	// Quit confirmation overlay
	if w.quitConfirm {
		prompt := lipgloss.NewStyle().
			Bold(true).
			Foreground(catWhite).
			Background(catModalBg).
			Padding(1, 3).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(catBlue).
			Render("Quit マオマオ maomao? (y/n)")
		return lipgloss.Place(w.width, w.height,
			lipgloss.Center, lipgloss.Center,
			prompt)
	}

	// Delete confirmation overlay
	if w.deleteConfirm {
		cursorSt := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
		dimSt := lipgloss.NewStyle().Foreground(catDimWhite)
		graySt := lipgloss.NewStyle().Foreground(catGray)

		opt0prefix := "  "
		opt1prefix := "  "
		if w.deleteCursor == 0 {
			opt0prefix = cursorSt.Render("▸ ")
		} else {
			opt1prefix = cursorSt.Render("▸ ")
		}

		content := lipgloss.NewStyle().Bold(true).Foreground(catWhite).Render("Delete task "+w.deleteTaskID+"?") + "\n\n" +
			opt0prefix + dimSt.Render("Delete all (worktrees + branches)") + "\n" +
			opt1prefix + dimSt.Render("Keep branches") + "\n\n" +
			graySt.Render("j/k move  enter confirm  esc cancel")

		prompt := lipgloss.NewStyle().
			Background(catModalBg).
			Padding(1, 3).
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(catBlue).
			Render(content)

		return lipgloss.Place(w.width, w.height, lipgloss.Center, lipgloss.Center, prompt)
	}

	return screen
}

// SetSize updates all component dimensions.
func (w *Workspace) SetSize(width, height int) {
	w.width = width
	w.height = height
}

func (w *Workspace) refreshSidebar() {
	if w.loadTasks != nil {
		w.sidebar.SetTasks(w.loadTasks())
	}
	if evts, err := event.Recent(5); err == nil {
		w.sidebar.events = evts
	}
	w.updateTaskStatuses()
}

// updateTaskStatuses syncs the sidebar task status indicators with cached pane states.
func (w *Workspace) updateTaskStatuses() {
	statuses := make(map[string]string)
	for taskID, panes := range w.taskPanes {
		hasRunning := false
		for _, p := range panes {
			if p.status == paneRunning {
				hasRunning = true
				break
			}
		}
		if hasRunning {
			statuses[taskID] = "running"
		} else {
			statuses[taskID] = "cached"
		}
	}
	w.sidebar.taskStatuses = statuses
}

func (w *Workspace) updateFocusState() {
	w.sidebar.focused = (w.focus == focusSidebar)
	for i := range w.panes {
		w.panes[i].focused = (w.focus == focusPanes && i == w.paneIdx)
	}
}

func (w *Workspace) syncStatusBar() {
	w.statusBar.mode = w.mode
	w.statusBar.focus = w.focus
	if w.paneIdx < len(w.panes) {
		w.statusBar.paneName = w.panes[w.paneIdx].name
	}
}

// openTask handles the taskOpenMsg by calling the opener callback.
// Caches panes per task ID so that switching between tasks preserves
// running PTY sessions instead of destroying and re-creating them.
func (w *Workspace) openTask(task TaskEntry) tea.Cmd {
	if task.ID == w.activeID && len(w.panes) > 0 {
		// Same task with live panes — re-launch any missing repos
		w.focus = focusPanes
		w.reopenMissing(task.ID)
		w.updateFocusState()
		w.syncStatusBar()
		if w.hasRunningPanes() {
			return schedulePaneRefresh()
		}
		return nil
	}

	// Save current panes before switching
	if w.activeID != "" && len(w.panes) > 0 {
		w.taskPanes[w.activeID] = w.panes
	}

	w.activeID = task.ID
	event.Emit(event.New(event.TaskOpened, task.ID, "", ""))

	// Check for cached panes from a previous visit (skip empty cache)
	if cached, ok := w.taskPanes[task.ID]; ok && len(cached) > 0 {
		w.panes = cached
	} else {
		delete(w.taskPanes, task.ID) // clean stale empty entry
		// First time opening this task -- call opener
		w.panes = nil
		w.launchAllRepos(task.ID)
		// Cache the newly created panes
		if len(w.panes) > 0 {
			w.taskPanes[task.ID] = w.panes
		}
	}

	if len(w.panes) > 0 {
		w.paneIdx = 0
		w.focus = focusPanes
		w.updateFocusState()
		w.syncStatusBar()
		return tea.Batch(schedulePaneRefresh(), scheduleHandoffScan())
	}

	return nil
}

// launchAllRepos calls the opener and creates panes for all returned repos.
func (w *Workspace) launchAllRepos(taskID string) {
	if w.opener == nil {
		return
	}
	panes, err := w.opener(taskID)
	if err != nil {
		return
	}
	for i, p := range panes {
		tp := newTermPane(p.RepoName, 20, 60)
		tp.colorIdx = i % len(paneColorPalette)
		tp.processKey = p.ProcessKey
		if tp.processKey == "" {
			tp.processKey = p.RepoName
		}
		tp.worktreeDir = p.WorktreeDir
		tp.vterm = p.VTerm
		tp.ptyWriter = p.PTYWriter
		if p.VTerm != nil {
			tp.status = paneRunning
			tp.loading = true
		}
		w.panes = append(w.panes, tp)
	}
}

// reopenMissing calls the opener and adds panes only for repos that don't
// already have a live pane. This restores repos that were stopped/removed
// while keeping existing running panes untouched.
func (w *Workspace) reopenMissing(taskID string) {
	if w.opener == nil {
		return
	}
	existing := make(map[string]bool)
	for _, p := range w.panes {
		existing[p.processKey] = true
	}

	panes, err := w.opener(taskID)
	if err != nil {
		return
	}
	for _, p := range panes {
		key := p.ProcessKey
		if key == "" {
			key = p.RepoName
		}
		if existing[key] {
			continue // already have a live pane
		}
		tp := newTermPane(p.RepoName, 20, 60)
		tp.colorIdx = len(w.panes) % len(paneColorPalette)
		tp.processKey = key
		tp.worktreeDir = p.WorktreeDir
		tp.vterm = p.VTerm
		tp.ptyWriter = p.PTYWriter
		if p.VTerm != nil {
			tp.status = paneRunning
			tp.loading = true
		}
		w.panes = append(w.panes, tp)
	}
	// Update cache
	if len(w.panes) > 0 {
		w.taskPanes[taskID] = w.panes
	}
}

// ActiveID returns the currently open task ID.
func (w *Workspace) ActiveID() string {
	return w.activeID
}

// BackToDashboard returns true if the user requested to go back to the dashboard.
func (w *Workspace) BackToDashboard() bool {
	return w.backToDashboard
}

// hasRunningPanes returns true if any pane has a live VTerm.
func (w *Workspace) hasRunningPanes() bool {
	for _, p := range w.panes {
		if p.vterm != nil {
			return true
		}
	}
	return false
}

// updateGitStatuses fetches git status for all active panes and updates the sidebar.
func (w *Workspace) updateGitStatuses() {
	statuses := make(map[string]gitStatus)
	for _, p := range w.panes {
		if p.worktreeDir != "" {
			statuses[p.name] = fetchGitStatus(p.worktreeDir)
		}
	}
	w.sidebar.SetRepoStatuses(statuses)
}

// collectPaneNames returns names from all panes.
func collectPaneNames(panes []termPaneModel) []string {
	var names []string
	for _, p := range panes {
		names = append(names, p.name)
	}
	return names
}
