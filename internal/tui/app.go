package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/discovery"
	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// viewState tracks the current main view
type viewState int

const (
	viewDashboard viewState = iota
	viewLogFull
)

// overlayState tracks the current overlay (popup) on top of the dashboard
type overlayState int

const (
	overlayNone overlayState = iota
	overlayLauncher
	overlayConfirm
	overlaySettings
	overlayTunnel
)

// ProcessStatusMsg is sent periodically to refresh process list statuses
type ProcessStatusMsg struct{}

// App is the root tea.Model for the TUI application
type App struct {
	pm            *process.ProcessManager
	cfg           *config.LocalConfig
	view          viewState
	overlay       overlayState
	dashboard     dashboardModel
	logView       logViewModel
	launcher      launcherModel
	confirm       confirmModel
	settings      settingsModel
	tunnelOvl     tunnelOverlayModel
	width         int
	height        int
	worktrees      []discovery.Worktree
	pendingLaunch  *LaunchRequestMsg // stored while waiting for deps install confirmation
	pendingTunnel  string            // process name waiting for cloudflared install
}

// NewApp creates the root application model
func NewApp(cfg *config.LocalConfig, pm *process.ProcessManager) App {
	wts := discovery.ScanWorktrees(cfg.ScanDirs)

	dash := newDashboardModel()
	procs := pm.List()
	dash.SetProcesses(procs)

	overlay := overlayNone
	var settings settingsModel

	// First-run: auto-open settings if no scan directories configured
	if len(cfg.ScanDirs) == 0 {
		overlay = overlaySettings
		settings = newSettingsModel(cfg.ScanDirs)
	} else {
		// Show scan results when opening with existing config
		settings = newSettingsModel(cfg.ScanDirs)
		settings.totalFound = len(wts)
		settings.worktreeCounts = countWorktreesPerDir(cfg.ScanDirs, wts)
	}

	app := App{
		pm:        pm,
		cfg:       cfg,
		view:      viewDashboard,
		overlay:   overlay,
		dashboard: dash,
		settings:  settings,
		worktrees: wts,
	}

	return app
}

// Init implements tea.Model
func (a App) Init() tea.Cmd {
	var cmds []tea.Cmd

	cmd := a.dashboard.SubscribeToSelected()
	if cmd != nil {
		cmds = append(cmds, cmd)
	}

	return tea.Batch(cmds...)
}

// Update implements tea.Model
func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height

		a.dashboard.width = msg.Width
		a.dashboard.height = msg.Height
		a.dashboard.initViewport()

		a.launcher.SetSize(msg.Width, msg.Height)
		a.confirm.SetSize(msg.Width, msg.Height)
		a.settings.SetSize(msg.Width, msg.Height)
		a.tunnelOvl.SetSize(msg.Width, msg.Height)

		if a.view == viewLogFull {
			a.logView.SetSize(msg.Width, msg.Height)
		}

		// Resize PTY to match the log viewport width (not full terminal width).
		// In dashboard view, the log panel is ~2/3 of the terminal;
		// in fullscreen log view, it's the full width.
		var ptyCols uint16
		if a.view == viewLogFull {
			ptyCols = uint16(msg.Width)
		} else {
			_, rightW := a.dashboard.panelWidths()
			ptyCols = uint16(rightW - 2) // subtract borders
		}
		ptyRows := uint16(msg.Height - 2)
		if ptyRows < 1 {
			ptyRows = 1
		}
		if ptyCols < 1 {
			ptyCols = 1
		}
		for _, rp := range a.pm.List() {
			if rp.PtyFile != nil {
				_ = a.pm.ResizePTY(rp.Info.Name, ptyRows, ptyCols)
			}
		}

		switch a.view {
		case viewDashboard:
			var cmd tea.Cmd
			a.dashboard, cmd = a.dashboard.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		case viewLogFull:
			var cmd tea.Cmd
			a.logView, cmd = a.logView.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}

		return a, tea.Batch(cmds...)

	// Handle overlay results
	case ConfirmResultMsg:
		a.overlay = overlayNone
		if msg.Confirmed {
			switch msg.Action {
			case "kill":
				return a, a.killProcess(msg.Target)
			case "restart":
				return a, a.restartProcess(msg.Target)
			case "install-deps":
				pmBin := "npm"
				if a.pendingLaunch != nil && a.pendingLaunch.PackageManager != "" {
					pmBin = a.pendingLaunch.PackageManager
				}
				pmPath := resolveBinary(pmBin)
				return a, installDeps(msg.Target, pmPath)
			case "stop-tunnel":
				return a, stopTunnelCmd(a.pm, msg.Target)
			case "install-cloudflared":
				a.dashboard.tunnelFeedback = "Installing cloudflared..."
				return a, installCloudflaredCmd()
			}
		} else if msg.Action == "install-cloudflared" {
			a.pendingTunnel = ""
			return a, nil
		} else if msg.Action == "install-deps" {
			// User declined install — launch anyway
			if a.pendingLaunch != nil {
				req := *a.pendingLaunch
				a.pendingLaunch = nil
				return a, a.launchProcess(req)
			}
		}
		return a, nil

	case settingsClosedMsg:
		a.overlay = overlayNone
		if msg.changed {
			a.cfg.ScanDirs = msg.scanDirs
			_ = config.SaveConfig(a.cfg)
		}
		// Always rescan on settings close
		a.worktrees = discovery.ScanWorktrees(a.cfg.ScanDirs)
		return a, nil

	case rescanRequestMsg:
		// Rescan worktrees and update settings with results
		a.worktrees = discovery.ScanWorktrees(a.settings.scanDirs)
		a.settings.totalFound = len(a.worktrees)
		a.settings.worktreeCounts = countWorktreesPerDir(a.settings.scanDirs, a.worktrees)
		return a, nil

	case LaunchRequestMsg:
		a.overlay = overlayNone

		// Save port override for next time
		key := config.PortKey(msg.Worktree.Name, msg.Project.Name)
		a.cfg.SetPort(key, msg.Port)
		_ = config.SaveConfig(a.cfg)

		// Check if node_modules is missing (skip for Encore projects)
		if !msg.Project.IsEncore && !hasDeps(msg.Worktree.Path) {
			a.pendingLaunch = &msg
			pm := msg.PackageManager
			if pm == "" {
				pm = "npm"
			}
			confirmMsg := fmt.Sprintf("node_modules not found in %s.\nRun %s install?", msg.Worktree.Name, pm)
			a.confirm = newConfirmModel(confirmMsg, "install-deps", msg.Worktree.Path)
			a.confirm.SetSize(a.width, a.height)
			a.overlay = overlayConfirm
			return a, nil
		}
		return a, a.launchProcess(msg)

	case depsInstalledMsg:
		if msg.err != "" {
			a.pendingLaunch = nil
			return a, func() tea.Msg {
				return processErrorMsg{name: "pnpm install", err: msg.err}
			}
		}
		if a.pendingLaunch != nil {
			req := *a.pendingLaunch
			a.pendingLaunch = nil
			return a, a.launchProcess(req)
		}
		return a, nil

	case cancelLauncherMsg:
		a.overlay = overlayNone
		return a, nil

	case ClipboardFeedbackMsg, ClearClipboardFeedbackMsg:
		switch a.view {
		case viewDashboard:
			var cmd tea.Cmd
			a.dashboard, cmd = a.dashboard.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		case viewLogFull:
			var cmd tea.Cmd
			a.logView, cmd = a.logView.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		return a, tea.Batch(cmds...)

	case LogLineMsg:
		switch a.view {
		case viewDashboard:
			var cmd tea.Cmd
			a.dashboard, cmd = a.dashboard.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		case viewLogFull:
			var cmd tea.Cmd
			a.logView, cmd = a.logView.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		return a, tea.Batch(cmds...)

	case processLaunchedMsg:
		// Resize PTY of the new process to match current terminal size
		if a.width > 0 && a.height > 0 {
			ptyRows := uint16(a.height - 2)
			if ptyRows < 1 {
				ptyRows = 1
			}
			_ = a.pm.ResizePTY(msg.name, ptyRows, uint16(a.width))
		}
		a.dashboard.SetProcesses(a.pm.List())
		cmd := a.dashboard.SubscribeToSelected()
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		return a, tea.Batch(cmds...)

	case processStoppedMsg:
		a.dashboard.SetProcesses(a.pm.List())
		cmd := a.dashboard.SubscribeToSelected()
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		return a, tea.Batch(cmds...)

	case processErrorMsg:
		a.dashboard.SetProcesses(a.pm.List())
		return a, nil

	case tunnelStartedMsg:
		a.dashboard.SetProcesses(a.pm.List())
		// Update overlay to show URL
		if a.overlay == overlayTunnel {
			a.tunnelOvl.phase = tunnelPhaseActive
			a.tunnelOvl.url = msg.url
		}
		return a, nil

	case tunnelStoppedMsg:
		a.dashboard.SetProcesses(a.pm.List())
		return a, func() tea.Msg {
			return tunnelFeedbackMsg{message: "[Tunnel stopped]"}
		}

	case tunnelErrorMsg:
		a.dashboard.SetProcesses(a.pm.List())
		// Update overlay to show error
		if a.overlay == overlayTunnel {
			a.tunnelOvl.phase = tunnelPhaseError
			a.tunnelOvl.errMsg = msg.err.Error()
			return a, nil
		}
		return a, func() tea.Msg {
			return tunnelFeedbackMsg{message: fmt.Sprintf("[Tunnel error: %v]", msg.err)}
		}

	case tunnelOverlayClosedMsg:
		a.overlay = overlayNone
		return a, nil

	case cloudflaredMissingMsg:
		a.overlay = overlayNone // close tunnel overlay
		a.pendingTunnel = msg.name
		confirmText := "cloudflared not found.\nInstall via Homebrew?"
		a.confirm = newConfirmModel(confirmText, "install-cloudflared", msg.name)
		a.confirm.SetSize(a.width, a.height)
		a.overlay = overlayConfirm
		return a, nil

	case cloudflaredInstalledMsg:
		if msg.err != "" {
			a.pendingTunnel = ""
			a.dashboard.tunnelFeedback = ""
			return a, func() tea.Msg {
				return tunnelFeedbackMsg{message: "[Install failed]"}
			}
		}
		// Install succeeded — open tunnel overlay and start tunnel
		name := a.pendingTunnel
		a.pendingTunnel = ""
		a.dashboard.tunnelFeedback = ""
		if name != "" {
			a.tunnelOvl = newTunnelOverlay(name)
			a.tunnelOvl.SetSize(a.width, a.height)
			a.overlay = overlayTunnel
			return a, startTunnelCmd(a.pm, name)
		}
		return a, nil

	case tunnelFeedbackMsg, clearTunnelFeedbackMsg:
		var cmd tea.Cmd
		a.dashboard, cmd = a.dashboard.Update(msg)
		return a, cmd

	case interactiveTickMsg:
		switch a.view {
		case viewDashboard:
			if a.dashboard.isInteractive {
				a.dashboard.refreshInteractiveViewport()
				return a, scheduleInteractiveTick()
			}
		case viewLogFull:
			if a.logView.isInteractive {
				a.logView.refreshInteractiveViewport()
				return a, scheduleInteractiveTick()
			}
		}
		return a, nil
	}

	// Route key messages
	if keyMsg, ok := msg.(tea.KeyMsg); ok {
		if a.overlay != overlayNone {
			return a.updateOverlay(keyMsg)
		}

		switch a.view {
		case viewDashboard:
			return a.updateDashboardKeys(keyMsg)
		case viewLogFull:
			return a.updateLogViewKeys(keyMsg)
		}
	}

	return a, nil
}

// updateOverlay routes key events to the active overlay
func (a App) updateOverlay(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch a.overlay {
	case overlayLauncher:
		var cmd tea.Cmd
		a.launcher, cmd = a.launcher.Update(msg)
		return a, cmd
	case overlayConfirm:
		var cmd tea.Cmd
		a.confirm, cmd = a.confirm.Update(msg)
		return a, cmd
	case overlaySettings:
		var cmd tea.Cmd
		a.settings, cmd = a.settings.Update(msg)
		return a, cmd
	case overlayTunnel:
		var cmd tea.Cmd
		a.tunnelOvl, cmd = a.tunnelOvl.Update(msg)
		return a, cmd
	}
	return a, nil
}

// updateDashboardKeys handles key events on the dashboard
func (a App) updateDashboardKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Interactive mode: forward all keys to PTY (except exit key)
	if a.dashboard.isInteractive {
		return a.handleDashboardInteractiveKey(msg)
	}

	// When selection is active, handle keys directly (bypass app-level switch to avoid k→kill conflict)
	if a.dashboard.selection.isActive() {
		key := msg.String()
		switch key {
		case "tab":
			a.dashboard.selection.deactivate()
			a.dashboard.refreshLogViewport()
			a.dashboard.focus = focusList
			return a, nil
		case "y":
			text := a.dashboard.selection.selectedText()
			count := a.dashboard.selection.selectedLineCount()
			a.dashboard.selection.deactivate()
			a.dashboard.refreshLogViewport()
			return a, copySelectedLines(text, count)
		case "esc":
			a.dashboard.selection.deactivate()
			a.dashboard.refreshLogViewport()
			return a, nil
		default:
			action := a.dashboard.selection.handleKey(key, a.dashboard.logViewport.Height)
			if action == selActionMoved {
				a.dashboard.selection.applyToViewport(&a.dashboard.logViewport)
			}
			return a, nil
		}
	}
	if a.dashboard.search.isActive() {
		var cmd tea.Cmd
		a.dashboard, cmd = a.dashboard.Update(msg)
		return a, cmd
	}

	switch msg.String() {
	case "q", "ctrl+c":
		return a, tea.Quit

	case "n":
		// Refresh worktrees before showing launcher
		a.worktrees = discovery.ScanWorktrees(a.cfg.ScanDirs)
		a.launcher = newLauncherModel(a.worktrees, a.cfg.PortOverrides)
		a.launcher.SetSize(a.width, a.height)
		a.overlay = overlayLauncher
		return a, nil

	case "s":
		a.worktrees = discovery.ScanWorktrees(a.cfg.ScanDirs)
		a.settings = newSettingsModel(a.cfg.ScanDirs)
		a.settings.totalFound = len(a.worktrees)
		a.settings.worktreeCounts = countWorktreesPerDir(a.cfg.ScanDirs, a.worktrees)
		a.settings.SetSize(a.width, a.height)
		a.overlay = overlaySettings
		return a, nil

	case "k":
		sel := a.dashboard.SelectedProcess()
		if sel != nil {
			msg := fmt.Sprintf("Kill process %q (PID %d)?", sel.Info.Name, sel.Info.PID)
			a.confirm = newConfirmModel(msg, "kill", sel.Info.Name)
			a.confirm.SetSize(a.width, a.height)
			a.overlay = overlayConfirm
		}
		return a, nil

	case "r":
		sel := a.dashboard.SelectedProcess()
		if sel != nil {
			msg := fmt.Sprintf("Restart process %q?", sel.Info.Name)
			a.confirm = newConfirmModel(msg, "restart", sel.Info.Name)
			a.confirm.SetSize(a.width, a.height)
			a.overlay = overlayConfirm
		}
		return a, nil

	case "t":
		sel := a.dashboard.SelectedProcess()
		if sel == nil || sel.Status != process.StatusRunning {
			return a, nil
		}
		if sel.Tunnel != nil && sel.Tunnel.Status != process.TunnelOff {
			confirmText := fmt.Sprintf("Stop tunnel for %q?", sel.Info.Name)
			a.confirm = newConfirmModel(confirmText, "stop-tunnel", sel.Info.Name)
			a.confirm.SetSize(a.width, a.height)
			a.overlay = overlayConfirm
			return a, nil
		}
		a.tunnelOvl = newTunnelOverlay(sel.Info.Name)
		a.tunnelOvl.SetSize(a.width, a.height)
		a.overlay = overlayTunnel
		return a, startTunnelCmd(a.pm, sel.Info.Name)

	case "u":
		sel := a.dashboard.SelectedProcess()
		if sel != nil && sel.Tunnel != nil && sel.Tunnel.URL != "" {
			return a, copyTunnelURL(sel.Tunnel.URL)
		}
		return a, nil

	case "enter":
		sel := a.dashboard.SelectedProcess()
		if sel != nil {
			a.dashboard.unsubscribeLogs()
			a.logView = newLogViewModel(sel)
			a.logView.SetSize(a.width, a.height)
			a.view = viewLogFull

			// Resize PTY to full width for fullscreen log view
			if sel.PtyFile != nil {
				_ = a.pm.ResizePTY(sel.Info.Name, uint16(a.height-2), uint16(a.width))
			}

			var cmds []tea.Cmd
			sizeMsg := tea.WindowSizeMsg{Width: a.width, Height: a.height}
			var cmd tea.Cmd
			a.logView, cmd = a.logView.Update(sizeMsg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
			subCmd := a.logView.Subscribe()
			if subCmd != nil {
				cmds = append(cmds, subCmd)
			}
			return a, tea.Batch(cmds...)
		}
		return a, nil
	}

	var cmd tea.Cmd
	a.dashboard, cmd = a.dashboard.Update(msg)
	return a, cmd
}

// updateLogViewKeys handles key events on the fullscreen log view
func (a App) updateLogViewKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Interactive mode: forward all keys to PTY (except exit key)
	if a.logView.isInteractive {
		return a.handleLogViewInteractiveKey(msg)
	}

	// When selection is active, handle keys directly at app level
	if a.logView.selection.isActive() {
		key := msg.String()
		switch key {
		case "y":
			text := a.logView.selection.selectedText()
			count := a.logView.selection.selectedLineCount()
			a.logView.selection.deactivate()
			a.logView.refreshLogViewport()
			return a, copySelectedLines(text, count)
		case "esc":
			a.logView.selection.deactivate()
			a.logView.refreshLogViewport()
			return a, nil
		default:
			action := a.logView.selection.handleKey(key, a.logView.viewport.Height)
			if action == selActionMoved {
				a.logView.selection.applyToViewport(&a.logView.viewport)
			}
			return a, nil
		}
	}
	if a.logView.search.isActive() {
		var cmd tea.Cmd
		a.logView, cmd = a.logView.Update(msg)
		return a, cmd
	}

	switch msg.String() {
	case "q", "esc":
		a.logView.Unsubscribe()
		a.view = viewDashboard

		// Resize PTY back to dashboard panel width
		_, rightW := a.dashboard.panelWidths()
		ptyCols := uint16(rightW - 2)
		if ptyCols < 1 {
			ptyCols = 1
		}
		for _, rp := range a.pm.List() {
			if rp.PtyFile != nil {
				_ = a.pm.ResizePTY(rp.Info.Name, uint16(a.height-2), ptyCols)
			}
		}

		a.dashboard.SetProcesses(a.pm.List())
		cmd := a.dashboard.SubscribeToSelected()

		var cmds []tea.Cmd
		if cmd != nil {
			cmds = append(cmds, cmd)
		}

		return a, tea.Batch(cmds...)
	}

	var cmd tea.Cmd
	a.logView, cmd = a.logView.Update(msg)
	return a, cmd
}

// View implements tea.Model
func (a App) View() string {
	if a.width == 0 || a.height == 0 {
		return "Initializing..."
	}

	var base string
	switch a.view {
	case viewDashboard:
		base = a.dashboard.View()
	case viewLogFull:
		base = a.logView.View()
	}

	switch a.overlay {
	case overlayLauncher:
		return a.launcher.View()
	case overlayConfirm:
		return a.confirm.View()
	case overlaySettings:
		return a.settings.View()
	case overlayTunnel:
		return a.tunnelOvl.View()
	}

	return base
}

// handleDashboardInteractiveKey forwards keys to PTY or exits interactive mode (dashboard)
func (a App) handleDashboardInteractiveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if isExitInteractiveKey(msg) {
		a.dashboard.isInteractive = false
		a.dashboard.refreshLogViewport()
		return a, nil
	}
	sel := a.dashboard.SelectedProcess()
	if sel != nil {
		raw := keyMsgToBytes(msg)
		if raw != nil {
			_ = a.pm.WriteInput(sel.Info.Name, raw)
		}
	}
	return a, nil
}

// handleLogViewInteractiveKey forwards keys to PTY or exits interactive mode (logview)
func (a App) handleLogViewInteractiveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if isExitInteractiveKey(msg) {
		a.logView.isInteractive = false
		a.logView.refreshLogViewport()
		return a, nil
	}
	raw := keyMsgToBytes(msg)
	if raw != nil {
		_ = a.pm.WriteInput(a.logView.sessionName, raw)
	}
	return a, nil
}

// --- Process action commands ---

type processLaunchedMsg struct{ name string }
type processStoppedMsg struct{ name string }
type processErrorMsg struct{ name, err string }

// launchProcess creates and starts a new process
func (a App) launchProcess(req LaunchRequestMsg) tea.Cmd {
	pm := a.pm
	return func() tea.Msg {
		wt := req.Worktree
		proj := req.Project
		port := req.Port

		sessionName := config.SessionName(wt.Name, proj.Name)

		// For workspace packages, use --filter and run from workspace root
		filterPkg := ""
		workDir := proj.Path
		if proj.WorkspaceRoot != "" && proj.PkgName != "" {
			filterPkg = proj.PkgName
			workDir = proj.WorkspaceRoot
		}

		pmBin := req.PackageManager
		if pmBin == "" {
			pmBin = "pnpm"
		}
		pmPath := resolveBinary(pmBin)

		cmd, args, extraEnv := config.DevCommand(proj.IsEncore, port, pmPath, filterPkg, req.Script)

		info := process.SessionInfo{
			Name:     sessionName,
			Port:     port,
			Command:  cmd,
			Args:     args,
			ExtraEnv: extraEnv,
			WorkDir:  workDir,
			Project:  proj.Name,
			WtName:   wt.Name,
			WtPath:   wt.Path,
		}

		_, err := pm.Start(info)
		if err != nil {
			return processErrorMsg{name: sessionName, err: err.Error()}
		}
		return processLaunchedMsg{name: sessionName}
	}
}

// killProcess stops a running process
func (a App) killProcess(name string) tea.Cmd {
	pm := a.pm
	return func() tea.Msg {
		rp := pm.Get(name)
		var err error
		if rp != nil && rp.Cmd == nil {
			err = pm.StopReconnected(name)
		} else {
			err = pm.Stop(name)
		}
		if err != nil {
			return processErrorMsg{name: name, err: err.Error()}
		}
		return processStoppedMsg{name: name}
	}
}

// restartProcess restarts a process
func (a App) restartProcess(name string) tea.Cmd {
	pm := a.pm
	return func() tea.Msg {
		_, err := pm.Restart(name)
		if err != nil {
			return processErrorMsg{name: name, err: err.Error()}
		}
		return processLaunchedMsg{name: name}
	}
}

// --- Dependency check ---

// hasDeps checks if dependencies are properly installed in the worktree root.
// Checks for pnpm (.modules.yaml), npm (.package-lock.json), or yarn (.yarn-integrity).
func hasDeps(wtPath string) bool {
	markers := []string{
		filepath.Join(wtPath, "node_modules", ".modules.yaml"),
		filepath.Join(wtPath, "node_modules", ".package-lock.json"),
		filepath.Join(wtPath, "node_modules", ".yarn-integrity"),
	}
	for _, m := range markers {
		if _, err := os.Stat(m); err == nil {
			return true
		}
	}
	return false
}

// depsInstalledMsg is sent after pnpm install completes
type depsInstalledMsg struct {
	err string
}

// installDeps runs package manager install in the given directory
func installDeps(dir string, pmPath string) tea.Cmd {
	return func() tea.Msg {
		cmd := exec.Command(pmPath, "install")
		cmd.Dir = dir
		output, err := cmd.CombinedOutput()
		if err != nil {
			return depsInstalledMsg{err: fmt.Sprintf("%s install failed: %v\n%s", filepath.Base(pmPath), err, string(output))}
		}
		return depsInstalledMsg{}
	}
}

// resolveBinary finds the full path for a binary name
func resolveBinary(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return name
	}
	return path
}

// countWorktreesPerDir counts how many worktrees were found per scan directory
func countWorktreesPerDir(scanDirs []string, worktrees []discovery.Worktree) map[string]int {
	counts := make(map[string]int)
	for _, dir := range scanDirs {
		absDir := normalizeDir(dir)
		count := 0
		for _, wt := range worktrees {
			if strings.HasPrefix(wt.Path, absDir+"/") || wt.Path == absDir {
				count++
			}
		}
		counts[dir] = count
	}
	return counts
}

