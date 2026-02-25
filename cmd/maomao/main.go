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

	"github.com/kimaguri/simplx-toolkit/internal/maomao/agent"
	maomaoconfig "github.com/kimaguri/simplx-toolkit/internal/maomao/config"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/event"
	maomaolog "github.com/kimaguri/simplx-toolkit/internal/maomao/log"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/repo"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/task"
	"github.com/kimaguri/simplx-toolkit/internal/maomao/tui"
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

var statsCmd = &cobra.Command{
	Use:   "stats [task-id]",
	Short: "Show time tracking statistics",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runStats,
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
	rootCmd.AddCommand(statsCmd)
	statsCmd.Flags().Bool("json", false, "Output as JSON")
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

	// Worktree dir name: branch slashes -> dashes
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

func runStats(cmd *cobra.Command, args []string) error {
	jsonOut, _ := cmd.Flags().GetBool("json")

	if len(args) == 1 {
		return printTaskStats(args[0], jsonOut)
	}
	return printAllStats(jsonOut)
}

func printTaskStats(taskID string, jsonOut bool) error {
	stats, err := task.GetStats(taskID)
	if err != nil {
		return fmt.Errorf("get stats for %s: %w", taskID, err)
	}

	if jsonOut {
		fmt.Printf(`{"task_id":%q,"total_active_sec":%d,"total_idle_sec":%d,"today_active_sec":%d,"session_count":%d,"first_session":%q,"last_session":%q}`,
			taskID,
			stats.TotalActiveSec,
			stats.TotalIdleSec,
			stats.TodayActiveSec,
			stats.SessionCount,
			stats.FirstSession.Format("2006-01-02 15:04"),
			stats.LastSession.Format("2006-01-02 15:04"),
		)
		fmt.Println()
		return nil
	}

	fmt.Printf("Task: %s\n", taskID)
	fmt.Printf("  Active time:  %s\n", task.FormatDuration(stats.TotalActiveSec))
	fmt.Printf("  Today:        %s\n", task.FormatDuration(stats.TodayActiveSec))
	fmt.Printf("  Idle time:    %s\n", task.FormatDuration(stats.TotalIdleSec))
	fmt.Printf("  Sessions:     %d\n", stats.SessionCount)
	if !stats.FirstSession.IsZero() {
		fmt.Printf("  First:        %s\n", stats.FirstSession.Format("2006-01-02 15:04"))
		fmt.Printf("  Last:         %s\n", stats.LastSession.Format("2006-01-02 15:04"))
	}
	return nil
}

func printAllStats(jsonOut bool) error {
	tasks, err := task.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	if len(tasks) == 0 {
		fmt.Println("No tasks.")
		return nil
	}

	if jsonOut {
		fmt.Print("[")
		for i, t := range tasks {
			stats, _ := task.GetStats(t.ID)
			if stats == nil {
				continue
			}
			if i > 0 {
				fmt.Print(",")
			}
			fmt.Printf(`{"task_id":%q,"status":%q,"total_active_sec":%d,"today_active_sec":%d,"session_count":%d}`,
				t.ID, t.Status, stats.TotalActiveSec, stats.TodayActiveSec, stats.SessionCount)
		}
		fmt.Println("]")
		return nil
	}

	fmt.Printf("%-15s %-8s %-12s %-12s %-8s\n", "TASK", "STATUS", "ACTIVE", "TODAY", "SESSIONS")
	fmt.Printf("%-15s %-8s %-12s %-12s %-8s\n", "----", "------", "------", "-----", "--------")

	totalActive := 0
	totalToday := 0
	for _, t := range tasks {
		stats, _ := task.GetStats(t.ID)
		if stats == nil {
			stats = &task.TimeStats{}
		}
		totalActive += stats.TotalActiveSec
		totalToday += stats.TodayActiveSec

		id := t.ID
		if len(id) > 15 {
			id = id[:12] + "..."
		}
		fmt.Printf("%-15s %-8s %-12s %-12s %-8d\n",
			id,
			t.Status,
			task.FormatDuration(stats.TotalActiveSec),
			task.FormatDuration(stats.TodayActiveSec),
			stats.SessionCount,
		)
	}

	fmt.Printf("\n%-15s %-8s %-12s %-12s\n", "TOTAL", "", task.FormatDuration(totalActive), task.FormatDuration(totalToday))
	return nil
}
