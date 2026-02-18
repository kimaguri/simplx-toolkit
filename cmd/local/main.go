package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/process"
	"github.com/kimaguri/simplx-toolkit/internal/tui"
)

var (
	version = "dev"
	commit  = "none"
)

func main() {
	if len(os.Args) > 1 {
		arg := os.Args[1]
		if arg == "--help" || arg == "-h" {
			printUsage()
			os.Exit(0)
		}
		if arg == "--version" || arg == "-v" {
			fmt.Printf("devdash %s (%s)\n", version, commit)
			os.Exit(0)
		}
	}

	// Load persistent config
	cfg := config.LoadConfig()

	// Ensure sessions and logs directories exist
	sessionsDir := config.SessionsDir()
	logsDir := config.LogsDir()
	for _, dir := range []string{sessionsDir, logsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "Error creating directory %s: %v\n", dir, err)
			os.Exit(1)
		}
	}

	// Initialize process manager
	pm := process.NewProcessManager(sessionsDir, logsDir)

	// Reconnect to existing sessions
	reconnected := pm.Reconnect()
	if len(reconnected) > 0 {
		fmt.Fprintf(os.Stderr, "Reconnected to %d existing process(es)\n", len(reconnected))
	}

	// Create and run TUI
	app := tui.NewApp(cfg, pm)
	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// printUsage displays help information
func printUsage() {
	fmt.Println(`devdash - Dev Process Dashboard

Usage:
  devdash              Start the TUI dashboard
  devdash --help       Show this help message

Keyboard shortcuts:
  n          Launch new process
  k          Kill selected process
  r          Restart selected process
  t          Toggle Cloudflare tunnel (requires cloudflared)
  u          Copy tunnel URL
  s          Settings (manage scan directories)
  Enter      Fullscreen log view
  Tab        Switch focus (list / logs)
  Up/Down    Navigate session list
  j/k        Navigate (vim-style)
  G          Jump to bottom of logs
  g          Jump to top of logs
  q          Quit (processes keep running)
  Esc        Close popup / back to dashboard

Configuration:
  Config file:  ~/.config/local-dev/config.json
  Sessions dir: ~/.config/local-dev/sessions/
  Logs dir:     ~/.config/local-dev/logs/

On first run, the settings overlay opens automatically.
Add scan directories pointing to your worktree parent directories.

Processes are spawned in the background and persist after quitting.
Re-running 'devdash' will reconnect to existing processes.`)
}
