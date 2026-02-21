package main

import (
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	mxdconfig "github.com/kimaguri/simplx-toolkit/internal/mxd/config"
	mxdlog "github.com/kimaguri/simplx-toolkit/internal/mxd/log"
	"github.com/kimaguri/simplx-toolkit/internal/mxd/repo"
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
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("No tasks yet.")
		return nil
	},
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
	rootCmd.AddCommand(taskCmd)
	rootCmd.AddCommand(versionCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
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

	// Get initial pane and send agent command
	panes, err := tmuxClient.GetSessionPanes(sessionName)
	if err != nil || len(panes) == 0 {
		return fmt.Errorf("get session panes: %w", err)
	}
	agentPane := panes[0]

	// Build agent command
	agentCmd := fmt.Sprintf("cd %q && claude %q", wtDir, desc)
	if globalCfg != nil {
		if ac, ok := globalCfg.Agents[agentName]; ok {
			agentCmd = fmt.Sprintf("cd %q && %s", wtDir, ac.Command)
			for _, a := range ac.Args {
				agentCmd += " " + a
			}
			agentCmd += fmt.Sprintf(" %q", desc)
		}
	}
	if err := tmuxClient.SendKeys(agentPane, agentCmd); err != nil {
		mxdlog.Logger.Warn().Err(err).Msg("failed to send agent command")
	}

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

	// Cleanup on quit
	mxdlog.Logger.Info().Msg("TUI exited, cleaning up tmux session")
	_ = tmuxClient.KillSession(sessionName)

	return nil
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
