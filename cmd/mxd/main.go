package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/GianlucaP106/gotmux/gotmux"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/kimaguri/simplx-toolkit/internal/mxd/agent"
	mxdconfig "github.com/kimaguri/simplx-toolkit/internal/mxd/config"
	mxdlog "github.com/kimaguri/simplx-toolkit/internal/mxd/log"
	"github.com/kimaguri/simplx-toolkit/internal/mxd/repo"
	"github.com/kimaguri/simplx-toolkit/internal/mxd/task"
	mxdtmux "github.com/kimaguri/simplx-toolkit/internal/mxd/tmux"
	"github.com/kimaguri/simplx-toolkit/internal/mxd/tui"
)

var (
	version = "dev"
	commit  = "none"
)

var rootCmd = &cobra.Command{
	Use:   "mxd",
	Short: "Multi-repo agent orchestrator",
	Long:  "mxd orchestrates AI agents across multiple git repositories with tmux, worktrees, and shared context.",
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
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

var repoCmd = &cobra.Command{
	Use:   "repo",
	Short: "Manage repos in current task",
}

var repoAddCmd = &cobra.Command{
	Use:   "add <repo-name>",
	Short: "Add a repo to the current task",
	Args:  cobra.ExactArgs(1),
	RunE:  runRepoAdd,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("mxd %s (%s)\n", version, commit)
	},
}

func init() {
	taskCmd.AddCommand(taskListCmd)
	taskCmd.AddCommand(taskResumeCmd)
	rootCmd.AddCommand(taskCmd)
	rootCmd.AddCommand(agentsCmd)
	repoCmd.AddCommand(repoAddCmd)
	rootCmd.AddCommand(repoCmd)
	rootCmd.AddCommand(versionCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runAgents(cmd *cobra.Command, args []string) error {
	configDir := mxdconfig.GlobalConfigDir()
	globalCfg, err := mxdconfig.LoadGlobalConfig(configDir)
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

func runRepoAdd(cmd *cobra.Command, args []string) error {
	repoName := args[0]

	// Init logger
	configDir := mxdconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	mxdlog.Init(configDir)

	// Find project config
	cwd, _ := os.Getwd()
	projectRoot := findProjectRoot(cwd)
	if projectRoot == "" {
		return fmt.Errorf("no .mxd/project.toml found")
	}

	projCfg, err := mxdconfig.LoadProjectConfig(projectRoot)
	if err != nil {
		return fmt.Errorf("load project config: %w", err)
	}

	// Find repo in project config
	var repoConf *mxdconfig.RepoConf
	for _, r := range projCfg.Project.Repos {
		if r.Name == repoName {
			rc := r
			repoConf = &rc
			break
		}
	}
	if repoConf == nil {
		return fmt.Errorf("repo %q not found in project.toml", repoName)
	}

	// Find active task (most recently saved)
	tasks, err := task.List()
	if err != nil || len(tasks) == 0 {
		return fmt.Errorf("no active tasks found")
	}

	// Find the active task
	var tk *task.Task
	for _, t := range tasks {
		if t.Status == task.StatusActive {
			tk = t
			break
		}
	}
	if tk == nil {
		tk = tasks[len(tasks)-1] // fallback to last task
	}

	// Check if repo already in task
	for _, r := range tk.Repos {
		if r.Name == repoName {
			return fmt.Errorf("repo %q already in task %s", repoName, tk.ID)
		}
	}

	// Load global config for agent
	globalCfg, _ := mxdconfig.LoadGlobalConfig(configDir)
	agentName := "claude"
	if globalCfg != nil && globalCfg.DefaultAgent != "" {
		agentName = globalCfg.DefaultAgent
	}

	// Build branch name using same template
	branchVars := map[string]string{
		"type":   tk.Type,
		"taskId": tk.ID,
		"slug":   repo.Slugify(tk.Title),
		"repo":   repoName,
	}
	branchName := repo.BranchName(projCfg.Branch.Template, branchVars)

	// Create worktree
	repoPath := filepath.Join(projectRoot, repoConf.Path)
	slug := repo.Slugify(tk.Title)
	wtDir := filepath.Join(repoPath, projCfg.Branch.WorktreeDir, slug)
	if err := repo.CreateWorktree(repoPath, wtDir, branchName, projCfg.Branch.Base); err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}

	// Add repo to task
	if err := task.AddRepo(tk, repoName, branchName, agentName); err != nil {
		return fmt.Errorf("add repo: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Added repo %s → %s\n", repoName, branchName)
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
	taskID := args[0]

	// Init logger
	configDir := mxdconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	mxdlog.Init(configDir)

	// Load task from disk
	tk, err := task.Load(taskID)
	if err != nil {
		return fmt.Errorf("load task: %w", err)
	}

	mxdlog.Logger.Info().Str("id", taskID).Msg("resuming task")
	tk.Status = task.StatusActive
	task.Save(tk)

	// Load configs
	globalCfg, _ := mxdconfig.LoadGlobalConfig(configDir)

	// Create tmux client
	tmuxClient, err := mxdtmux.NewClient()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}

	sessionName := "mxd-" + taskID

	// Check if session exists, create if not
	if !tmuxClient.HasSession(sessionName) {
		_, err = tmuxClient.NewSession(sessionName)
		if err != nil {
			return fmt.Errorf("create tmux session: %w", err)
		}
	}

	// Build TUI task info from persisted task
	var repos []tui.RepoInfo
	for _, r := range tk.Repos {
		repos = append(repos, tui.RepoInfo{
			Name:      r.Name,
			Branch:    r.Branch,
			AgentName: r.Agent,
			Status:    r.Status,
		})
	}

	taskInfo := tui.TaskInfo{
		Description: fmt.Sprintf("%s %s: %s", tk.Type, tk.ID, tk.Title),
		TaskType:    tk.Type,
		TaskID:      tk.ID,
		Repos:       repos,
	}

	app := tui.NewApp(taskInfo)
	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	// Update task on exit
	tk.Status = task.StatusParked
	task.Save(tk)
	_ = tmuxClient
	_ = globalCfg

	mxdlog.Logger.Info().Msg("TUI exited (resumed task)")
	return nil
}

func runTask(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	desc := args[0]

	// Init logger
	configDir := mxdconfig.GlobalConfigDir()
	os.MkdirAll(configDir, 0o755)
	mxdlog.Init(configDir)
	mxdlog.Logger.Info().Str("desc", desc).Msg("task started")

	// Parse task description
	taskType, taskID, taskText := repo.ParseTaskDescription(desc)
	if taskType == "" {
		taskType = "fix"
	}

	// Find project config
	cwd, _ := os.Getwd()
	projectRoot := findProjectRoot(cwd)
	if projectRoot == "" {
		return fmt.Errorf("no .mxd/project.toml found (run 'mxd init' first)")
	}

	projCfg, err := mxdconfig.LoadProjectConfig(projectRoot)
	if err != nil {
		return fmt.Errorf("load project config: %w", err)
	}

	// Load global config (optional)
	globalCfg, _ := mxdconfig.LoadGlobalConfig(configDir)
	agentName := "claude"
	if globalCfg != nil && globalCfg.DefaultAgent != "" {
		agentName = globalCfg.DefaultAgent
	}

	// Pick first repo
	if len(projCfg.Project.Repos) == 0 {
		return fmt.Errorf("no repos configured in project.toml")
	}
	selectedRepo := projCfg.Project.Repos[0]

	// Build branch name
	slug := taskText
	if slug == "" {
		slug = desc
	}
	slug = repo.Slugify(slug)
	branchVars := map[string]string{
		"type":   taskType,
		"taskId": taskID,
		"slug":   slug,
		"repo":   selectedRepo.Name,
	}
	branchName := repo.BranchName(projCfg.Branch.Template, branchVars)

	// Create worktree
	repoPath := filepath.Join(projectRoot, selectedRepo.Path)
	wtDir := filepath.Join(repoPath, projCfg.Branch.WorktreeDir, slug)
	mxdlog.Logger.Info().
		Str("repo", selectedRepo.Name).
		Str("branch", branchName).
		Str("worktree", wtDir).
		Msg("creating worktree")

	if err := repo.CreateWorktree(repoPath, wtDir, branchName, projCfg.Branch.Base); err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Created worktree: %s → %s\n", selectedRepo.Name, branchName)

	// Save task state
	tk := &task.Task{
		ID:      taskID,
		Type:    taskType,
		Title:   taskText,
		Status:  task.StatusActive,
		Created: time.Now(),
		Repos: []task.TaskRepo{{
			Name:   selectedRepo.Name,
			Branch: branchName,
			Agent:  agentName,
			Status: task.RepoInProgress,
		}},
	}
	if taskID == "" {
		tk.ID = slug // fallback ID
	}
	if err := task.Save(tk); err != nil {
		mxdlog.Logger.Warn().Err(err).Msg("failed to save task")
	}

	// Create tmux session
	tmuxClient, err := mxdtmux.NewClient()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}

	sessionName := "mxd"
	if taskID != "" {
		sessionName = "mxd-" + taskID
	}

	// Kill existing session if any
	_ = tmuxClient.KillSession(sessionName)

	_, err = tmuxClient.NewSession(sessionName)
	if err != nil {
		return fmt.Errorf("create tmux session: %w", err)
	}
	mxdlog.Logger.Info().Str("session", sessionName).Msg("tmux session created")

	// Get lead pane (mxd control)
	panes, err := tmuxClient.GetSessionPanes(sessionName)
	if err != nil || len(panes) == 0 {
		return fmt.Errorf("get session panes: %w", err)
	}
	leadPane := panes[0]

	// Spawn agent in split pane
	var agentConf mxdconfig.AgentConf
	if globalCfg != nil {
		if ac, ok := globalCfg.Agents[agentName]; ok {
			agentConf = ac
		}
	}
	if agentConf.Command == "" {
		agentConf = mxdconfig.AgentConf{Name: "claude", Command: "claude"}
	}

	agentPane, err := spawnAgentInRepo(tmuxClient, leadPane, agentConf, wtDir, desc)
	if err != nil {
		mxdlog.Logger.Warn().Err(err).Msg("failed to spawn agent")
	}
	_ = agentPane // will be used by TUI later

	// Launch TUI in current terminal
	taskInfo := tui.TaskInfo{
		Description: desc,
		TaskType:    taskType,
		TaskID:      taskID,
		Repos: []tui.RepoInfo{{
			Name:        selectedRepo.Name,
			Branch:      branchName,
			AgentName:   agentName,
			Status:      "running",
			WorktreeDir: wtDir,
		}},
	}

	app := tui.NewApp(taskInfo)
	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	// Update task status on exit
	tk.Status = task.StatusParked
	task.Save(tk)

	// Cleanup on quit
	mxdlog.Logger.Info().Msg("TUI exited, cleaning up tmux session")
	_ = tmuxClient.KillSession(sessionName)

	return nil
}

// spawnAgentInRepo creates a pane and launches an agent in it.
func spawnAgentInRepo(tmuxClient *mxdtmux.Client, leadPane *gotmux.Pane, agentConf mxdconfig.AgentConf, wtDir, prompt string) (*gotmux.Pane, error) {
	agentPane, err := tmuxClient.SplitPane(leadPane, false, wtDir)
	if err != nil {
		return nil, fmt.Errorf("split pane: %w", err)
	}

	agentCmd := fmt.Sprintf("cd %q && %s", wtDir, agent.BuildCommand(agentConf, prompt))
	if err := tmuxClient.SendKeys(agentPane, agentCmd); err != nil {
		return agentPane, fmt.Errorf("send keys: %w", err)
	}
	return agentPane, nil
}

// findProjectRoot walks up from dir looking for .mxd/project.toml
func findProjectRoot(dir string) string {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".mxd", "project.toml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}
