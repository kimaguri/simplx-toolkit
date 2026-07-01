package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/devdash"
	"github.com/kimaguri/simplx-toolkit/internal/orchestrator"
	"github.com/kimaguri/simplx-toolkit/internal/process"
	"github.com/kimaguri/simplx-toolkit/internal/proxy"
	"github.com/kimaguri/simplx-toolkit/internal/tui"
)

var (
	version = "dev"
	commit  = "none"
)

// stringSlice implements flag.Value to collect a repeatable string flag
// (e.g. --local core --local front) into a slice.
type stringSlice []string

func (s *stringSlice) String() string {
	if s == nil {
		return ""
	}
	return strings.Join(*s, ",")
}

func (s *stringSlice) Set(value string) error {
	*s = append(*s, value)
	return nil
}

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
		if arg == "help" {
			runHelp(os.Args[2:])
			return
		}
		if arg == "up" {
			runUp(os.Args[2:])
			return
		}
		if arg == "logs" {
			runLogs(os.Args[2:])
			return
		}
		if arg == "status" {
			runStatus(os.Args[2:])
			return
		}
		if arg == "down" {
			runDown(os.Args[2:])
			return
		}
	}

	// Migrate legacy ~/.config/local-dev to ~/.config/devdash before anything
	// else touches config paths, so already-running processes stay reconnectable.
	migratedBefore := false
	if _, err := os.Stat(config.ConfigDir()); os.IsNotExist(err) {
		migratedBefore = true
	}
	if err := config.MigrateFromLegacy(); err != nil {
		fmt.Fprintf(os.Stderr, "Error migrating config from legacy location: %v\n", err)
		os.Exit(1)
	}
	if migratedBefore {
		if _, err := os.Stat(config.ConfigDir()); err == nil {
			fmt.Fprintf(os.Stderr, "Migrated config from ~/.config/local-dev to %s\n", config.ConfigDir())
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
	pm := devdash.NewProcessManager(sessionsDir, logsDir)

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

// usageUp is the stable help text for `devdash up --help` / `devdash help up`.
// Kept in sync with contracts/cli.md so the dotclaude skill can rely on it.
const usageUp = `Usage: devdash up --project <name> [--branch <branch>] [--local <svc>]... [--remote <svc>]...

Bring an instance (project + branch) up: for each declared service, local
mode spawns a background dev process from its git worktree on an
OS-assigned free port; remote mode proxies to the configured upstream.
Every service is reached at http://<slug>-<service>.<domainSuffix>, an
instance identity derived from --project + --branch (single-layout
projects use --project alone, no branch). Idempotent: re-running "up" for
an already-up instance skips running services and starts only what is
missing.

Flags:
  --project <name>   project id, resolved via repo-root dev.config.json or
                      central ~/.config/devdash/projects/<name>.json (required)
  --branch <branch>  task branch; required for worktree-layout projects,
                      omitted for single-layout projects
  --local <svc>      force a service to local mode (repeatable)
  --remote <svc>     force a service to remote mode (repeatable)
  --repo <path>      additional repo root(s) to check for dev.config.json
                      (repeatable)

Example:
  devdash up --project simplx --branch orders-refactor --local core

Exit codes: 0 success, 1 usage/config error, 2 runtime failure (Caddy/port 80).`

// runUp parses `devdash up` flags and executes orchestrator.Up, printing the
// result on success or an error on failure. Exit codes follow
// contracts/cli.md: 1 for usage/config errors, 2 for runtime failures.
func runUp(args []string) {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Println(usageUp)
		return
	}

	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprintln(os.Stderr, usageUp) }
	var project, branch string
	var local, remote, repos stringSlice
	fs.StringVar(&project, "project", "", "project id (required)")
	fs.StringVar(&branch, "branch", "", "branch name (required for worktree-layout projects)")
	fs.Var(&local, "local", "force a service to local mode (repeatable)")
	fs.Var(&remote, "remote", "force a service to remote mode (repeatable)")
	fs.Var(&repos, "repo", "additional repo root(s) to check for dev.config.json (repeatable)")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if project == "" {
		fmt.Fprintln(os.Stderr, "Error: --project is required")
		fmt.Fprintln(os.Stderr, usageUp)
		os.Exit(1)
	}

	// Migrate legacy config location before touching any devdash paths.
	if err := config.MigrateFromLegacy(); err != nil {
		fmt.Fprintf(os.Stderr, "Error migrating config from legacy location: %v\n", err)
		os.Exit(1)
	}

	sessionsDir := config.SessionsDir()
	logsDir := config.LogsDir()
	for _, dir := range []string{sessionsDir, logsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "Error creating directory %s: %v\n", dir, err)
			os.Exit(1)
		}
	}

	pm := process.NewProcessManager(sessionsDir, logsDir)
	proxyClient := proxy.NewCaddyClient()

	opts := orchestrator.UpOptions{
		Project:   project,
		Branch:    branch,
		Local:     local,
		Remote:    remote,
		RepoPaths: repos,
	}

	inst, err := orchestrator.Up(opts, proxyClient, pm)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		if errIsConfig(err) {
			os.Exit(1)
		}
		os.Exit(2)
	}

	orchestrator.PrintUpResult(os.Stdout, inst)
}

// usageLogs is the stable help text for `devdash logs --help` / `devdash help logs`.
const usageLogs = `Usage: devdash logs <instance> [service] [--tail N] [--follow] [--timeout <dur>]

Print a service's output as plain text with ANSI escapes stripped.
<instance> is the slug (or project name for single-layout projects) shown
by "devdash status". Omitting [service] shows all of the instance's
services, each line prefixed "[service]". Requesting logs for a remote
service reports "service is remote (no local log)" and exits 0.

Flags:
  --tail N          trailing line count (default 50)
  --follow          stream new output until --timeout elapses
  --timeout <dur>   follow duration cap, e.g. 30s (default 60s; follow
                    never blocks indefinitely)

Example:
  devdash logs orders-refactor front --tail 100

Exit codes: 0 success, 1 usage error, 2 runtime failure.`

// runLogs parses `devdash logs` flags and executes orchestrator.Logs,
// writing plain-text, ANSI-stripped output to stdout. Exit codes follow
// contracts/cli.md: 1 for usage errors, 2 for runtime failures.
func runLogs(args []string) {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Println(usageLogs)
		return
	}

	// The `flag` package stops parsing at the first non-flag argument, but
	// contracts/cli.md positions <instance> [service] before the flags
	// (`devdash logs <instance> [service] [--tail N] ...`). Pull off up to
	// two leading positional tokens first, then hand the remainder (which
	// starts with the flags) to flag.Parse.
	var positional []string
	rest := args
	for len(positional) < 2 && len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		positional = append(positional, rest[0])
		rest = rest[1:]
	}

	if len(positional) < 1 {
		fmt.Fprintln(os.Stderr, "Error: usage: devdash logs <instance> [service] [--tail N] [--follow] [--timeout <dur>]")
		fmt.Fprintln(os.Stderr, usageLogs)
		os.Exit(1)
	}

	instance := positional[0]
	service := ""
	if len(positional) > 1 {
		service = positional[1]
	}

	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprintln(os.Stderr, usageLogs) }
	var tail int
	var follow bool
	var timeout time.Duration
	fs.IntVar(&tail, "tail", 0, "trailing line count (default 50)")
	fs.BoolVar(&follow, "follow", false, "stream new output until timeout")
	fs.DurationVar(&timeout, "timeout", 0, "follow duration cap (default 60s)")

	if err := fs.Parse(rest); err != nil {
		os.Exit(1)
	}

	opts := orchestrator.LogOptions{
		Tail:    tail,
		Follow:  follow,
		Timeout: timeout,
	}

	if err := orchestrator.Logs(os.Stdout, instance, service, opts); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(2)
	}
}

// usageStatus is the stable help text for `devdash status --help` / `devdash help status`.
const usageStatus = `Usage: devdash status [instance]

List running instances (project + branch) and their services. Omitting
[instance] shows all instances grouped by project/branch; each service
row shows mode, URL, port and pid (local), status, and log path. Remote
services are shown as proxy rows with their upstream target.

Example:
  devdash status orders-refactor

Exit codes: 0 success, 2 runtime failure.`

// runStatus parses `devdash status [instance]` and executes
// orchestrator.Status, writing the human-readable report to stdout. Per
// contracts/cli.md, an omitted instance argument shows all instances
// grouped by project/branch.
func runStatus(args []string) {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Println(usageStatus)
		return
	}

	instance := ""
	if len(args) > 0 {
		instance = args[0]
	}

	// Migrate legacy config location before touching any devdash paths.
	if err := config.MigrateFromLegacy(); err != nil {
		fmt.Fprintf(os.Stderr, "Error migrating config from legacy location: %v\n", err)
		os.Exit(1)
	}

	sessionsDir := config.SessionsDir()
	logsDir := config.LogsDir()
	pm := process.NewProcessManager(sessionsDir, logsDir)

	if err := orchestrator.Status(os.Stdout, instance, pm); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(2)
	}
}

// usageDown is the stable help text for `devdash down --help` / `devdash help down`.
const usageDown = `Usage: devdash down <instance>

Tear an instance down: stop its local processes, remove its Caddy routes
(the "<slug>-*" route group), and delete its registry entry. Remote
upstreams and the shared Caddy daemon are left untouched, and other
instances are unaffected. <instance> is the slug (or project name for
single-layout projects). An unknown or already-down instance is reported
as "not running" and exits 0 (non-destructive).

Example:
  devdash down orders-refactor

Exit codes: 0 success (incl. already-down no-op), 1 usage error, 2 runtime failure.`

// runDown parses `devdash down <instance>` and executes orchestrator.Down,
// stopping the instance's local processes, removing its Caddy routes, and
// deleting its registry entry. Per contracts/cli.md, an unknown/already-down
// instance is a non-destructive no-op reported as "not running" with exit 0.
func runDown(args []string) {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Println(usageDown)
		return
	}

	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Error: usage: devdash down <instance>")
		fmt.Fprintln(os.Stderr, usageDown)
		os.Exit(1)
	}
	instance := args[0]

	// Migrate legacy config location before touching any devdash paths.
	if err := config.MigrateFromLegacy(); err != nil {
		fmt.Fprintf(os.Stderr, "Error migrating config from legacy location: %v\n", err)
		os.Exit(1)
	}

	sessionsDir := config.SessionsDir()
	logsDir := config.LogsDir()
	for _, dir := range []string{sessionsDir, logsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "Error creating directory %s: %v\n", dir, err)
			os.Exit(1)
		}
	}

	pm := process.NewProcessManager(sessionsDir, logsDir)
	proxyClient := proxy.NewCaddyClient()

	found, err := orchestrator.Down(instance, proxyClient, pm)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(2)
	}

	if !found {
		fmt.Printf("instance %s not running\n", instance)
		return
	}

	fmt.Printf("instance %s stopped\n", instance)
}

// runHelp implements `devdash help [sub]`: with no subcommand it prints the
// same top-level usage as `devdash --help`; with a recognized subcommand
// name it prints that subcommand's dedicated usage text.
func runHelp(args []string) {
	if len(args) == 0 {
		printUsage()
		return
	}
	switch args[0] {
	case "up":
		fmt.Println(usageUp)
	case "down":
		fmt.Println(usageDown)
	case "status":
		fmt.Println(usageStatus)
	case "logs":
		fmt.Println(usageLogs)
	default:
		fmt.Fprintf(os.Stderr, "Error: no help topic %q (known: up, down, status, logs)\n", args[0])
		os.Exit(1)
	}
}

// errIsConfig reports whether err represents a usage/config error (exit 1)
// as opposed to a runtime failure (exit 2), per contracts/cli.md.
func errIsConfig(err error) bool {
	return strings.Contains(err.Error(), "resolving project config") ||
		strings.Contains(err.Error(), config.ErrNotOrchestratable.Error())
}

// printUsage displays help information
func printUsage() {
	fmt.Println(`devdash - Dev Process Dashboard & Multi-Repo Orchestrator

Usage:
  devdash              Start the TUI dashboard
  devdash --help       Show this help message
  devdash --version    Show version

Orchestrator subcommands (headless, for scripts and Claude Code):
  up      --project <p> [--branch <b>] [--local <svc>]... [--remote <svc>]...
          Bring an instance (project+branch) up: mixed local dev processes
          and remote upstreams, addressed by stable <slug>-<service> domains.
  down    <instance>
          Tear an instance down: stop local processes, remove its routes
          and registry entry; other instances and the shared proxy untouched.
  status  [instance]
          List running instances grouped by project/branch, or one instance.
  logs    <instance> [service] [--tail N] [--follow] [--timeout <dur>]
          Print a service's ANSI-stripped output; omit [service] for all.
  help    [sub]
          Show this message, or detailed help for one of the above.

Run 'devdash <sub> --help' or 'devdash help <sub>' for full details and
examples of any subcommand.

TUI keyboard shortcuts:
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
  Config file:   ~/.config/devdash/config.json
  Sessions dir:  ~/.config/devdash/sessions/
  Logs dir:      ~/.config/devdash/logs/
  Projects dir:  ~/.config/devdash/projects/   (central per-project config)
  Instances dir: ~/.config/devdash/instances/  (orchestrator registry)

On first run, the settings overlay opens automatically.
Add scan directories pointing to your worktree parent directories.

Processes are spawned in the background and persist after quitting.
Re-running 'devdash' will reconnect to existing processes.

Note: prior installs used ~/.config/local-dev; it is migrated to
~/.config/devdash automatically on first run of any command.`)
}
