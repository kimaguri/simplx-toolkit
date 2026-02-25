package tui

import (
	"io"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
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
	Scrollback  ScrollbackReader             // segmented log for infinite scrollback (optional)
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
	Resize  func(name string, rows, cols int) // resize underlying terminal (tmux/PTY)
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

// Workspace is the root Bubbletea model for the maomao embedded TUI.
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
	diffOverlay   *diffOverlayModel          // active diff view overlay
	fullscreen    bool // true = show only focused pane
	sidebarHidden bool // true = sidebar collapsed
	quitConfirm    bool // true = showing quit confirmation prompt
	deleteConfirm  bool   // true = showing delete confirmation
	deleteTaskID   string // task being confirmed for deletion
	deleteCursor   int    // 0 = delete all, 1 = keep branches
	tdOverlay      bool   // true = showing td status overlay
	tdContent      string // cached td status output
	width          int
	height        int
	lastEsc       time.Time // for double-Esc detection
	stdinProxy    *stdinProxy // raw stdin proxy for interactive mode passthrough

	// Performance: prevent concurrent async operations from stacking up
	gitFetchPending bool
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

// SetStdinProxy sets the raw stdin proxy for interactive mode passthrough.
func (w *Workspace) SetStdinProxy(proxy *stdinProxy) {
	w.stdinProxy = proxy
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

// SetSize updates all component dimensions and resizes underlying terminals.
func (w *Workspace) SetSize(width, height int) {
	w.width = width
	w.height = height
	w.resizeTerminals()
}

// resizeTerminals propagates pane dimensions to underlying tmux sessions or PTYs.
// Uses the same sidebar width calculation as View() to ensure consistency.
// Safe to call frequently — TmuxSession.Resize() deduplicates unchanged dimensions.
func (w *Workspace) resizeTerminals() {
	if w.paneCtrl == nil || w.paneCtrl.Resize == nil || len(w.panes) == 0 {
		return
	}
	if w.width == 0 || w.height == 0 {
		return
	}

	// Match sidebar width calculation from View()
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
	contentH := w.height - 1 // status bar
	if rightW < 10 || contentH < 5 {
		return
	}

	borderCols := 2 // left + right border
	borderRows := 3 // top + bottom border + title

	if w.fullscreen && w.paneIdx < len(w.panes) {
		p := w.panes[w.paneIdx]
		if p.processKey != "" && p.status == paneRunning {
			w.paneCtrl.Resize(p.processKey, contentH-borderRows, rightW-borderCols)
		}
	} else {
		paneW := rightW / len(w.panes)
		for _, p := range w.panes {
			if p.processKey != "" && p.status == paneRunning {
				w.paneCtrl.Resize(p.processKey, contentH-borderRows, paneW-borderCols)
			}
		}
	}
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
		// Resize terminals to match current TUI dimensions (they start at default 80x24)
		w.resizeTerminals()

		cmds := []tea.Cmd{schedulePaneRefresh(), scheduleHandoffScan()}
		// Fetch TD summary for this task
		if w.panes[0].worktreeDir != "" {
			cmds = append(cmds, fetchTdSummaryCmd(w.panes[0].worktreeDir, task.ID))
		}
		return tea.Batch(cmds...)
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
		tp.scrollback = p.Scrollback
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
		tp.scrollback = p.Scrollback
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

// SetSidebarHidden sets the sidebar hidden state (for session restore).
func (w *Workspace) SetSidebarHidden(hidden bool) {
	w.sidebarHidden = hidden
}

// IsSidebarHidden returns whether the sidebar is currently hidden.
func (w *Workspace) IsSidebarHidden() bool {
	return w.sidebarHidden
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

// updateGitStatuses is now async — see fetchGitStatusesCmd in githelper.go.
// The result is handled by gitStatusResultMsg in Update().

// collectPaneNames returns names from all panes.
func collectPaneNames(panes []termPaneModel) []string {
	var names []string
	for _, p := range panes {
		names = append(names, p.name)
	}
	return names
}
