package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	"github.com/kimaguri/simplx-toolkit/internal/discovery"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
	maomaoconfig "github.com/kimaguri/simplx-toolkit/internal/maomao/config"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
	maomaolog "github.com/kimaguri/simplx-toolkit/internal/maomao/log"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/repo"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/tui"
	"github.com/kimaguri/simplx-toolkit/internal/process"
)

var (
	version = "dev"
	commit  = "none"
)

var rootCmd = &cobra.Command{
	Use:   "maomao",
	Short: "Multi-repo agent orchestrator",
	Long:  "maomao orchestrates AI agents across multiple git repositories with embedded terminal panes, worktrees, and shared context.",
	RunE:  runStatus,
}

var taskCmd = &cobra.Command{
	Use:   "task [description]",
	Short: "Create a new task and launch TUI",
	Args:  cobra.ArbitraryArgs,
	RunE:  runTask,
}

var taskListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all tasks",
	RunE:  runTaskList,
}

var taskResumeCmd = &cobra.Command{
	Use:   "resume <task-id>",
	Short: "Resume an existing task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTaskResume,
}

var agentsCmd = &cobra.Command{
	Use:   "agents",
	Short: "List available agents",
	RunE:  runAgents,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("maomao %s (%s)\n", version, commit)
	},
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize maomao config for current project",
	RunE:  runInit,
}

var logsCmd = &cobra.Command{
	Use:   "logs",
	Short: "View recent event log",
	RunE:  runLogs,
}

var defaultGlobalConfig = `default_agent = "claude"
mode = "supervised"
scan_dirs = []

[branch]
template = "{type}/{taskId}/{slug}"
base = "main"
worktree_dir = ".worktrees"

[agents.claude]
name = "Claude Code"
command = "claude"
detect = "command -v claude"
interactive = true
resume_flag = "--resume"
`

func init() {
	taskCmd.AddCommand(taskListCmd)
	taskCmd.AddCommand(taskResumeCmd)
	rootCmd.AddCommand(taskCmd)
	rootCmd.AddCommand(agentsCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(logsCmd)
	logsCmd.Flags().StringP("task", "t", "", "Filter by task ID")
	logsCmd.Flags().IntP("count", "n", 50, "Number of events to show")
}

func main() {
	maomaoconfig.MigrateConfigDir()
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runStatus(cmd *cobra.Command, args []string) error {
	configDir := maomaoconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	maomaolog.Init(configDir)
	event.Init(configDir)

	// Run wizard if config is missing (standalone tea.Program)
	_, globalErr := maomaoconfig.LoadGlobalConfig(configDir)
	if globalErr != nil {
		if err := runWizard(configDir); err != nil {
			return err
		}
	}

	// Go straight to workspace (no initial task — user picks from sidebar)
	return launchWorkspace(configDir, "")
}

func runWizard(configDir string) error {
	checks := []tui.WizardCheck{
		{
			Label:   "Global config",
			Detail:  "~/.config/maomao/config.toml",
			OK:      false,
			Fixable: true,
			Fix:     func() error { return createGlobalConfig(configDir) },
		},
	}
	wizard := tui.NewWizardApp(checks)
	p := tea.NewProgram(wizard, tea.WithAltScreen())
	_, err := p.Run()
	return err
}

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

	// Task opener: loads task, launches agent PTYs, returns pane info per repo
	opener := func(taskID string) ([]tui.PaneInit, error) {
		tk, err := task.Load(taskID)
		if err != nil {
			return nil, fmt.Errorf("load task: %w", err)
		}
		tk.Status = task.StatusActive
		task.Save(tk)

		globalCfg, _ := maomaoconfig.LoadGlobalConfig(configDir)

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

			agentCmd := agent.BuildCommand(agentConf, r.Branch)

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

			panes = append(panes, tui.PaneInit{
				RepoName:    r.Name,
				ProcessKey:  processKey,
				VTerm:       rp.VTerm,
				PTYWriter:   rp.PtyFile,
				WorktreeDir: workDir,
			})
		}
		return panes, nil
	}

	workspace := tui.NewWorkspace(loadTasks(), opener, loadTasks, initialTaskID)

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
				VTerm:      rp.VTerm,
				PTYWriter:  rp.PtyFile,
			}, nil
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
			VTerm:       rp.VTerm,
			PTYWriter:   rp.PtyFile,
			WorktreeDir: info.WorkDir,
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

	// Create a new task: branch + repo → worktree + persist
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

		// Reuse branch from existing repos
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

		// Write agent context before launching
		agent.WriteContext(agent.ContextParams{
			RepoName:    repoName,
			TaskID:      tk.ID,
			TaskType:    tk.Type,
			TaskTitle:   tk.Title,
			TaskStatus:  tk.Status,
			Branch:      branchName,
			AllRepos:    tk.Repos,
			WorktreeDir: wtDir,
		})

		// Start agent
		var agentConf maomaoconfig.AgentConf
		if globalCfg != nil {
			if ac, ok := globalCfg.Agents[agentName]; ok {
				agentConf = ac
			}
		}
		if agentConf.Command == "" {
			agentConf = maomaoconfig.AgentConf{Name: "claude", Command: "claude"}
		}

		agentCmd := agent.BuildCommand(agentConf, branchName)
		processKey := taskID + ":" + repoName
		info := process.SessionInfo{
			Name:    processKey,
			Command: "sh",
			Args:    []string{"-c", agentCmd},
			WorkDir: wtDir,
		}

		rp, err := pm.Start(info)
		if err != nil {
			return &tui.PaneInit{RepoName: repoName, ProcessKey: processKey, WorktreeDir: wtDir}, nil
		}

		return &tui.PaneInit{
			RepoName:    repoName,
			ProcessKey:  processKey,
			VTerm:       rp.VTerm,
			PTYWriter:   rp.PtyFile,
			WorktreeDir: wtDir,
		}, nil
	}

	// Park a task
	parkTaskFn := func(taskID string) error {
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
		tk, err := task.Load(taskID)
		if err != nil {
			return err
		}
		// Stop all agents for this task
		for _, r := range tk.Repos {
			processKey := taskID + ":" + r.Name
			pm.Stop(processKey)
		}
		// Remove worktrees
		for _, r := range tk.Repos {
			if r.WorktreeDir != "" {
				repo.RemoveWorktree(r.Path, r.WorktreeDir)
			}
		}
		// Optionally delete branches
		if !keepBranches {
			for _, r := range tk.Repos {
				if r.Branch != "" {
					repo.DeleteBranch(r.Path, r.Branch)
				}
			}
		}
		// Delete task files
		return task.Delete(taskID)
	}

	workspace.SetCallbacks(loadRepos, createTask, addRepoFn, parkTaskFn, deleteTaskFn)

	p := tea.NewProgram(workspace, tea.WithAltScreen(), tea.WithMouseCellMotion())
	_, err := p.Run()
	if err != nil {
		return fmt.Errorf("TUI: %w", err)
	}

	// Save agent logs before stopping processes (all tasks, not just active)
	for _, rp := range pm.List() {
		content := rp.LogBuf.Content()
		if content == "" {
			continue
		}
		// Process key is taskID:repoName
		parts := strings.SplitN(rp.Info.Name, ":", 2)
		if len(parts) == 2 {
			task.SaveAgentLog(parts[0], parts[1], []byte(content))
		}
	}

	// On exit: stop all managed processes
	for _, rp := range pm.List() {
		pm.Stop(rp.Info.Name)
	}

	// Park active tasks
	parkActiveTasks()

	return nil
}

// parkActiveTasks marks all active tasks as parked.
func parkActiveTasks() {
	tasks, _ := task.List()
	for _, t := range tasks {
		if t.Status == task.StatusActive {
			t.Status = task.StatusParked
			task.Save(t)
		}
	}
}

// buildTaskEntries creates TaskEntry slice from persisted tasks.
func buildTaskEntries() []tui.TaskEntry {
	tasks, _ := task.List()
	var entries []tui.TaskEntry
	for _, t := range tasks {
		title := t.Title
		if len(title) > 30 {
			title = title[:27] + "..."
		}
		var repoNames []string
		for _, r := range t.Repos {
			repoNames = append(repoNames, r.Name)
		}
		entries = append(entries, tui.TaskEntry{
			ID:        t.ID,
			Type:      t.Type,
			Title:     title,
			Status:    t.Status,
			Active:    t.Status == task.StatusActive,
			Repos:     len(t.Repos),
			RepoNames: repoNames,
		})
	}
	return entries
}


func runAgents(cmd *cobra.Command, args []string) error {
	configDir := maomaoconfig.GlobalConfigDir()
	globalCfg, err := maomaoconfig.LoadGlobalConfig(configDir)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	fmt.Printf("%-15s %-20s %-10s %s\n", "KEY", "NAME", "STATUS", "COMMAND")
	fmt.Printf("%-15s %-20s %-10s %s\n", "---", "----", "------", "-------")
	for key, ac := range globalCfg.Agents {
		status := "missing"
		if agent.Detect(ac) {
			status = "available"
		}
		fmt.Printf("%-15s %-20s %-10s %s\n", key, ac.Name, status, ac.Command)
	}
	return nil
}

func runTaskList(cmd *cobra.Command, args []string) error {
	tasks, err := task.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	if len(tasks) == 0 {
		fmt.Println("No tasks.")
		return nil
	}

	fmt.Printf("%-15s %-8s %-8s %s\n", "ID", "TYPE", "STATUS", "TITLE")
	fmt.Printf("%-15s %-8s %-8s %s\n", "---", "----", "------", "-----")
	for _, t := range tasks {
		repoCount := len(t.Repos)
		title := t.Title
		if len(title) > 40 {
			title = title[:37] + "..."
		}
		fmt.Printf("%-15s %-8s %-8s %s (%d repos)\n", t.ID, t.Type, t.Status, title, repoCount)
	}
	return nil
}

func runTaskResume(cmd *cobra.Command, args []string) error {
	configDir := maomaoconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	maomaolog.Init(configDir)
	event.Init(configDir)
	return launchWorkspace(configDir, args[0])
}

func runTask(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	if len(args) < 2 {
		return fmt.Errorf("usage: maomao task <branch-name> <repo-path>")
	}
	configDir := maomaoconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	maomaolog.Init(configDir)
	event.Init(configDir)

	repoPath, _ := filepath.Abs(args[1])
	repoName := filepath.Base(repoPath)
	branchName := strings.TrimSpace(args[0])

	taskID, err := createTaskDirect(configDir, branchName, repoName, repoPath)
	if err != nil {
		return err
	}
	return launchWorkspace(configDir, taskID)
}

func createTaskDirect(configDir, branchName, repoName, repoPath string) (string, error) {
	maomaolog.Logger.Info().Str("branch", branchName).Str("repo", repoName).Msg("task started")

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

	// Derive task fields from branch name segments: type/id/slug
	parts := strings.Split(branchName, "/")
	taskType := parts[0]
	taskID := branchName
	if len(parts) >= 2 {
		taskID = parts[1]
	}
	taskTitle := branchName
	if len(parts) >= 3 {
		taskTitle = strings.Join(parts[2:], " ")
	}

	// Worktree dir name: branch slashes → dashes
	wtName := strings.ReplaceAll(branchName, "/", "-")
	wtDir := filepath.Join(repoPath, wtBaseDir, wtName)

	if err := repo.CreateWorktree(repoPath, wtDir, branchName, baseBranch); err != nil {
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
			Branch:      branchName,
			WorktreeDir: wtDir,
			Agent:       agentName,
			Status:      task.RepoInProgress,
		}},
	}
	if err := task.Save(tk); err != nil {
		return "", err
	}
	event.Emit(event.New(event.TaskCreated, taskID, repoName, branchName))
	return taskID, nil
}

func runLogs(cmd *cobra.Command, args []string) error {
	configDir := maomaoconfig.GlobalConfigDir()
	event.Init(configDir)

	taskFilter, _ := cmd.Flags().GetString("task")
	count, _ := cmd.Flags().GetInt("count")

	var events []event.Event
	var err error
	if taskFilter != "" {
		events, err = event.ByTask(taskFilter, count)
	} else {
		events, err = event.Recent(count)
	}
	if err != nil {
		return fmt.Errorf("read events: %w", err)
	}

	if len(events) == 0 {
		fmt.Println("No events.")
		return nil
	}

	for _, e := range events {
		ts := e.Timestamp.Format("2006-01-02 15:04:05")
		taskID := e.TaskID
		if taskID == "" {
			taskID = "-"
		}
		repoName := e.Repo
		if repoName == "" {
			repoName = "-"
		}
		fmt.Printf("%s  %-18s  %-12s  %-15s  %s\n", ts, e.Type, taskID, repoName, e.Detail)
	}
	return nil
}

func runInit(cmd *cobra.Command, args []string) error {
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	dimStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("8"))

	configDir := maomaoconfig.GlobalConfigDir()
	globalPath := filepath.Join(configDir, "config.toml")
	if _, err := os.Stat(globalPath); err != nil {
		if err := createGlobalConfig(configDir); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", okStyle.Render("Created"), globalPath)
		fmt.Println("  Add scan_dirs to config.toml to discover repos")
	} else {
		fmt.Printf("  %s  %s\n", dimStyle.Render("Exists"), globalPath)
	}

	return nil
}

func createGlobalConfig(configDir string) error {
	globalPath := filepath.Join(configDir, "config.toml")
	os.MkdirAll(configDir, 0o755)
	if err := os.WriteFile(globalPath, []byte(defaultGlobalConfig), 0o644); err != nil {
		return fmt.Errorf("create global config: %w", err)
	}
	return nil
}
