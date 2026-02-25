package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/discovery"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
	maomaoconfig "github.com/kimaguri/simplx-toolkit/internal/maomao/config"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/hooks"
	maomaolog "github.com/kimaguri/simplx-toolkit/internal/maomao/log"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/repo"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/tui"
	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// launchWorkspace creates and runs the embedded workspace TUI.
func launchWorkspace(configDir string, initialTaskID string) error {
	loadTasks := func() []tui.TaskEntry {
		return buildTaskEntries()
	}

	sessionsDir := filepath.Join(configDir, "sessions")
	logsDir := filepath.Join(configDir, "logs")
	os.MkdirAll(sessionsDir, 0o755)
	os.MkdirAll(logsDir, 0o755)
	pm := process.NewProcessManager(sessionsDir, logsDir)

	// Wire agent lifecycle events via OnExit callback
	pm.OnExit = func(key string, exitCode int) {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			return
		}
		taskID, repoName := parts[0], parts[1]
		if exitCode == 0 {
			event.Emit(event.New(event.AgentStopped, taskID, repoName, ""))
		} else {
			event.Emit(event.New(event.AgentCrashed, taskID, repoName, fmt.Sprintf("exit code %d", exitCode)))
		}
		// Write session summary + run on_agent_stop hook (best-effort)
		if tk, err := task.Load(taskID); err == nil {
			for _, r := range tk.Repos {
				if r.Name == repoName {
					if r.WorktreeDir != "" {
						writeRepoSessionSummary(pm, taskID, repoName, r.WorktreeDir)
					}
					if cfg, cfgErr := maomaoconfig.LoadGlobalConfig(configDir); cfgErr == nil && cfg != nil && cfg.Hooks.OnAgentStop != "" {
						hooks.Run("on_agent_stop", cfg.Hooks.OnAgentStop, hooks.HookEnv{
							TaskID: taskID, RepoName: repoName, WorktreeDir: r.WorktreeDir, Branch: r.Branch,
						})
					}
					break
				}
			}
		}
	}

	// Reconnect to surviving tmux sessions from previous run
	reconnected := pm.Reconnect()
	if len(reconnected) > 0 {
		maomaolog.Logger.Info().Int("count", len(reconnected)).Msg("reconnected to existing agent sessions")
	}

	// Task opener: loads task, launches agent PTYs, returns pane info per repo
	opener := func(taskID string) ([]tui.PaneInit, error) {
		tk, err := task.Load(taskID)
		if err != nil {
			return nil, fmt.Errorf("load task: %w", err)
		}
		tk.Status = task.StatusActive
		task.Save(tk)

		globalCfg, _ := maomaoconfig.LoadGlobalConfig(configDir)

		// Run on_task_open hook for each repo (best-effort)
		if globalCfg != nil && globalCfg.Hooks.OnTaskOpen != "" {
			hooks.RunAll("on_task_open", globalCfg.Hooks.OnTaskOpen, taskHookEnvs(tk))
		}
		var panes []tui.PaneInit
		for _, r := range tk.Repos {
			agentName := r.Agent
			var agentConf maomaoconfig.AgentConf
			if globalCfg != nil {
				if ac, ok := globalCfg.Agents[agentName]; ok {
					agentConf = ac
				}
			}
			if agentConf.Command == "" {
				agentConf = maomaoconfig.AgentConf{Name: "claude", Command: "claude"}
			}

			workDir := r.WorktreeDir
			if workDir == "" {
				workDir = r.Path
			}

			// Write agent context before launching
			agent.WriteContext(agent.ContextParams{
				RepoName:    r.Name,
				TaskID:      tk.ID,
				TaskType:    tk.Type,
				TaskTitle:   tk.Title,
				TaskStatus:  tk.Status,
				Branch:      r.Branch,
				AllRepos:    tk.Repos,
				WorktreeDir: workDir,
			})

			// Determine if we should resume an existing session
			shouldResume := r.SessionID != ""
			agentCmd := agent.BuildCommand(agentConf, r.Branch, shouldResume)

			processKey := taskID + ":" + r.Name
			info := process.SessionInfo{
				Name:    processKey,
				Command: "sh",
				Args:    []string{"-c", agentCmd},
				WorkDir: workDir,
			}

			rp, err := pm.Start(info)
			if err != nil {
				maomaolog.Logger.Warn().Err(err).Str("repo", r.Name).Str("key", processKey).Msg("failed to start agent")
				panes = append(panes, tui.PaneInit{RepoName: r.Name, ProcessKey: processKey, WorktreeDir: workDir})
				continue
			}
			event.Emit(event.New(event.AgentStarted, taskID, r.Name, ""))
			// Run on_agent_start hook (best-effort)
			if globalCfg != nil && globalCfg.Hooks.OnAgentStart != "" {
				hooks.Run("on_agent_start", globalCfg.Hooks.OnAgentStart, hooks.HookEnv{
					TaskID: taskID, RepoName: r.Name, WorktreeDir: workDir, Branch: r.Branch,
				})
			}

			// Persist session ID for future resume
			_ = task.UpdateRepoSession(taskID, r.Name, processKey)

			panes = append(panes, tui.PaneInit{
				RepoName:    r.Name,
				ProcessKey:  processKey,
				VTerm:       rp.Terminal(),
				PTYWriter:   rp.InputWriter(),
				WorktreeDir: workDir,
				Scrollback:  rp.ScrollbackSource(),
			})
		}

		// Start time tracking session
		var repoNames []string
		for _, p := range panes {
			repoNames = append(repoNames, p.RepoName)
		}
		task.StartSession(taskID, repoNames) // best-effort, ignore error

		return panes, nil
	}

	// Restore UI state from previous session
	session := maomaoconfig.LoadSession(configDir)
	if initialTaskID == "" && session.LastTask != "" {
		initialTaskID = session.LastTask
	}

	workspace := tui.NewWorkspace(loadTasks(), opener, loadTasks, initialTaskID)
	if session.SidebarHidden {
		workspace.SetSidebarHidden(true)
	}

	paneCtrl := &tui.PaneController{
		Stop: func(name string) error {
			return pm.Stop(name)
		},
		Restart: func(processKey string) (*tui.PaneInit, error) {
			rp, err := pm.Restart(processKey)
			if err != nil {
				return nil, err
			}
			// Extract repo name from processKey (taskID:repoName)
			repoName := processKey
			if parts := strings.SplitN(processKey, ":", 2); len(parts) == 2 {
				repoName = parts[1]
			}
			return &tui.PaneInit{
				RepoName:   repoName,
				ProcessKey: processKey,
				VTerm:      rp.Terminal(),
				PTYWriter:  rp.InputWriter(),
				Scrollback: rp.ScrollbackSource(),
			}, nil
		},
		Resize: func(name string, rows, cols int) {
			_ = pm.ResizePTY(name, uint16(rows), uint16(cols))
		},
	}
	workspace.SetPaneController(paneCtrl)

	workspace.SetPaneLauncher(func(info tui.PaneLaunchInfo) (*tui.PaneInit, error) {
		si := process.SessionInfo{
			Name:    info.ProcessKey,
			Command: info.Command,
			Args:    info.Args,
			WorkDir: info.WorkDir,
		}
		rp, err := pm.Start(si)
		if err != nil {
			return nil, err
		}
		return &tui.PaneInit{
			ProcessKey:  info.ProcessKey,
			VTerm:       rp.Terminal(),
			PTYWriter:   rp.InputWriter(),
			WorktreeDir: info.WorkDir,
			Scrollback:  rp.ScrollbackSource(),
		}, nil
	})

	// Load available repos from scan_dirs
	loadRepos := func() []tui.RepoEntry {
		cfg, _ := maomaoconfig.LoadGlobalConfig(configDir)
		if cfg == nil || len(cfg.ScanDirs) == 0 {
			return nil
		}
		worktrees := discovery.ScanWorktrees(cfg.ScanDirs)
		var repos []tui.RepoEntry
		for _, wt := range worktrees {
			repos = append(repos, tui.RepoEntry{
				Name:        wt.Name,
				Path:        wt.Path,
				Branch:      wt.Branch,
				IsWorktree:  wt.IsWorktree,
				MainProject: wt.MainProject,
			})
		}
		return repos
	}

	// Create a new task: branch + repo -> worktree + persist
	createTask := func(branch, repoName, repoPath string) (string, error) {
		globalCfg, _ := maomaoconfig.LoadGlobalConfig(configDir)
		agentName := "claude"
		baseBranch := "main"
		wtBaseDir := ".worktrees"
		if globalCfg != nil {
			if globalCfg.DefaultAgent != "" {
				agentName = globalCfg.DefaultAgent
			}
			if globalCfg.Branch.Base != "" {
				baseBranch = globalCfg.Branch.Base
			}
			if globalCfg.Branch.WorktreeDir != "" {
				wtBaseDir = globalCfg.Branch.WorktreeDir
			}
		}

		parts := strings.Split(branch, "/")
		taskType := parts[0]
		taskID := branch
		if len(parts) >= 2 {
			taskID = parts[1]
		}
		taskTitle := branch
		if len(parts) >= 3 {
			taskTitle = strings.Join(parts[2:], " ")
		}

		wtName := strings.ReplaceAll(branch, "/", "-")
		wtDir := filepath.Join(repoPath, wtBaseDir, wtName)

		if err := repo.CreateWorktree(repoPath, wtDir, branch, baseBranch); err != nil {
			return "", fmt.Errorf("create worktree: %w", err)
		}

		tk := &task.Task{
			ID:      taskID,
			Type:    taskType,
			Title:   taskTitle,
			Status:  task.StatusActive,
			Created: time.Now(),
			Repos: []task.TaskRepo{{
				Name:        repoName,
				Path:        repoPath,
				Branch:      branch,
				WorktreeDir: wtDir,
				Agent:       agentName,
				Status:      task.RepoInProgress,
			}},
		}
		if err := task.Save(tk); err != nil {
			return "", err
		}
		// Run on_task_create hook (best-effort)
		if globalCfg != nil && globalCfg.Hooks.OnTaskCreate != "" {
			hooks.Run("on_task_create", globalCfg.Hooks.OnTaskCreate, hooks.HookEnv{
				TaskID: taskID, RepoName: repoName, WorktreeDir: wtDir, Branch: branch,
			})
		}
		return taskID, nil
	}

	// Add a repo to an existing task
	addRepoFn := func(taskID, repoName, repoPath string) (*tui.PaneInit, error) {
		tk, err := task.Load(taskID)
		if err != nil {
			return nil, err
		}
		globalCfg, _ := maomaoconfig.LoadGlobalConfig(configDir)
		agentName := "claude"
		baseBranch := "main"
		wtBaseDir := ".worktrees"
		if globalCfg != nil {
			if globalCfg.DefaultAgent != "" {
				agentName = globalCfg.DefaultAgent
			}
			if globalCfg.Branch.Base != "" {
				baseBranch = globalCfg.Branch.Base
			}
			if globalCfg.Branch.WorktreeDir != "" {
				wtBaseDir = globalCfg.Branch.WorktreeDir
			}
		}
		branchName := ""
		if len(tk.Repos) > 0 {
			branchName = tk.Repos[0].Branch
		}
		if branchName == "" {
			return nil, fmt.Errorf("no branch found for task %s", taskID)
		}
		wtName := strings.ReplaceAll(branchName, "/", "-")
		wtDir := filepath.Join(repoPath, wtBaseDir, wtName)
		if err := repo.CreateWorktree(repoPath, wtDir, branchName, baseBranch); err != nil {
			return nil, fmt.Errorf("create worktree: %w", err)
		}
		task.AddRepo(tk, repoName, repoPath, branchName, wtDir, agentName)
		agent.WriteContext(agent.ContextParams{
			RepoName: repoName, TaskID: tk.ID, TaskType: tk.Type, TaskTitle: tk.Title,
			TaskStatus: tk.Status, Branch: branchName, AllRepos: tk.Repos, WorktreeDir: wtDir,
		})
		var agentConf maomaoconfig.AgentConf
		if globalCfg != nil {
			if ac, ok := globalCfg.Agents[agentName]; ok {
				agentConf = ac
			}
		}
		if agentConf.Command == "" {
			agentConf = maomaoconfig.AgentConf{Name: "claude", Command: "claude"}
		}
		agentCmd := agent.BuildCommand(agentConf, branchName, false)
		processKey := taskID + ":" + repoName
		info := process.SessionInfo{
			Name: processKey, Command: "sh", Args: []string{"-c", agentCmd}, WorkDir: wtDir,
		}
		rp, err := pm.Start(info)
		if err != nil {
			return &tui.PaneInit{RepoName: repoName, ProcessKey: processKey, WorktreeDir: wtDir}, nil
		}
		return &tui.PaneInit{
			RepoName: repoName, ProcessKey: processKey, VTerm: rp.Terminal(),
			PTYWriter: rp.InputWriter(), WorktreeDir: wtDir, Scrollback: rp.ScrollbackSource(),
		}, nil
	}

	// Park a task
	parkTaskFn := func(taskID string) error {
		// Write session summaries + run on_task_park hook (best-effort)
		if tk, loadErr := task.Load(taskID); loadErr == nil {
			for _, r := range tk.Repos {
				if r.WorktreeDir != "" {
					writeRepoSessionSummary(pm, taskID, r.Name, r.WorktreeDir)
				}
			}
			if cfg, cfgErr := maomaoconfig.LoadGlobalConfig(configDir); cfgErr == nil && cfg != nil && cfg.Hooks.OnTaskPark != "" {
				hooks.RunAll("on_task_park", cfg.Hooks.OnTaskPark, taskHookEnvs(tk))
			}
		}

		// End time tracking session
		task.EndSession(taskID) // best-effort

		tk, err := task.Load(taskID)
		if err != nil {
			return err
		}
		tk.Status = task.StatusParked
		event.Emit(event.New(event.TaskParked, taskID, "", ""))
		return task.Save(tk)
	}

	// Delete a task (stop agents, remove worktrees, optionally branches, remove task files)
	deleteTaskFn := func(taskID string, keepBranches bool) error {
		task.EndSession(taskID) // end time tracking if active
		tk, err := task.Load(taskID)
		if err != nil {
			return err
		}
		for _, r := range tk.Repos {
			pm.Stop(taskID + ":" + r.Name)
			if r.WorktreeDir != "" {
				repo.RemoveWorktree(r.Path, r.WorktreeDir)
			}
			if !keepBranches && r.Branch != "" {
				repo.DeleteBranch(r.Path, r.Branch)
			}
		}
		return task.Delete(taskID)
	}

	workspace.SetCallbacks(loadRepos, createTask, addRepoFn, parkTaskFn, deleteTaskFn)

	// NOTE: StdinProxy (raw passthrough for interactive mode) is disabled for now.
	// Using tea.WithInput(proxy) prevents Bubbletea from setting terminal raw mode
	// because stdinProxy is not *os.File and has no fd for term.MakeRaw().
	// Phase 1 raw passthrough needs a different approach (e.g. tea.Exec or fd-aware proxy).
	// The fallback path in updateInteractive() handles KeyMsg→PTY forwarding.
	p := tea.NewProgram(workspace, tea.WithAltScreen(), tea.WithMouseCellMotion())
	_, err := p.Run()
	if err != nil {
		return fmt.Errorf("TUI: %w", err)
	}

	// Save UI state for next session
	maomaoconfig.SaveSession(configDir, maomaoconfig.SessionState{
		LastTask:      workspace.ActiveID(),
		SidebarHidden: workspace.IsSidebarHidden(),
	})

	// Save agent logs and write session summaries before stopping processes
	for _, rp := range pm.List() {
		content := rp.LogBuf.Content()
		parts := strings.SplitN(rp.Info.Name, ":", 2)
		if len(parts) == 2 {
			taskID, repoName := parts[0], parts[1]
			if content != "" {
				task.SaveAgentLog(taskID, repoName, []byte(content))
			}
			// Write session summary before stopping
			if tk, loadErr := task.Load(taskID); loadErr == nil {
				for _, r := range tk.Repos {
					if r.Name == repoName && r.WorktreeDir != "" {
						writeRepoSessionSummary(pm, taskID, repoName, r.WorktreeDir)
						break
					}
				}
			}
		}
	}

	// On exit: stop all managed processes
	for _, rp := range pm.List() {
		pm.Stop(rp.Info.Name)
	}

	// End time tracking sessions for all active tasks
	tasks, _ := task.List()
	for _, t := range tasks {
		if t.Status == task.StatusActive {
			task.EndSession(t.ID)
		}
	}

	// Park active tasks
	parkActiveTasks()

	return nil
}

// taskHookEnvs builds HookEnv entries for all repos in a task.
func taskHookEnvs(tk *task.Task) []hooks.HookEnv {
	envs := make([]hooks.HookEnv, 0, len(tk.Repos))
	for _, r := range tk.Repos {
		wd := r.WorktreeDir
		if wd == "" {
			wd = r.Path
		}
		envs = append(envs, hooks.HookEnv{TaskID: tk.ID, RepoName: r.Name, WorktreeDir: wd, Branch: r.Branch})
	}
	return envs
}
