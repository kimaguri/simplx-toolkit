package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Project represents a runnable dev project within a worktree
type Project struct {
	Name           string   // directory name (or worktree name for root projects)
	Path           string   // absolute path to project dir
	IsEncore       bool     // true if Encore project (encore.app detected)
	Port           int      // suggested port (from config overrides, 0 = use default)
	PkgName        string   // package.json "name" field (for pnpm --filter)
	WorkspaceRoot  string   // path to workspace root (non-empty if this is a workspace package)
	Scripts        []string // all script names from package.json (sorted: dev/start first)
	PackageManager string   // auto-detected: "pnpm"|"npm"|"yarn"|"bun"
	DetectedPort   int      // port found in config files (webpack/vite), 0 = not detected
	PortFixed      bool     // true if port is hardcoded (not reading PORT env)
}

// skipDirs contains directory names to skip during scanning
var skipDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	".motia":       true,
	"dist":         true,
	"build":        true,
	".next":        true,
	".turbo":       true,
	".cache":       true,
	"coverage":     true,
	"__pycache__":  true,
	".vscode":      true,
	".idea":        true,
}

// DetectProjects finds runnable projects within a worktree by scanning for:
//   - package.json with a "dev" script (Node.js projects)
//   - encore.app file (Encore projects)
//
// Monorepo roots with turbo/lerna orchestrators are skipped — only leaf projects are returned.
// Scans up to 2 levels deep, skipping known non-project directories.
func DetectProjects(wt Worktree) []Project {
	var projects []Project
	seen := make(map[string]bool)

	// Detect if this is a pnpm workspace
	wsRoot := ""
	if isPnpmWorkspace(wt.Path) {
		wsRoot = wt.Path
	}

	// Check root for Encore project
	if isEncoreProject(wt.Path) {
		projects = append(projects, Project{
			Name:     filepath.Base(wt.Path),
			Path:     wt.Path,
			IsEncore: true,
		})
		seen[wt.Path] = true
	}

	// Check root for Node project (skip monorepo orchestrators like turbo/lerna)
	if !seen[wt.Path] {
		scripts := getScripts(wt.Path)
		if len(scripts) > 0 && !hasOnlyOrchestratorScripts(scripts, wt.Path) {
			pm := detectPackageManager(wt.Path)
			port, fixed := detectConfigPort(wt.Path)
			projects = append(projects, Project{
				Name:           filepath.Base(wt.Path),
				Path:           wt.Path,
				PkgName:        getPkgName(wt.Path),
				Scripts:        scripts,
				PackageManager: pm,
				DetectedPort:   port,
				PortFixed:      fixed,
			})
			seen[wt.Path] = true
		}
	}

	// Scan 1-2 levels deep
	scanLevel(wt.Path, wsRoot, &projects, seen, 1, 2)

	return projects
}

// scanLevel recursively scans for projects up to maxDepth
func scanLevel(dir, wsRoot string, projects *[]Project, seen map[string]bool, depth, maxDepth int) {
	if depth > maxDepth {
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if skipDirs[name] || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
			continue
		}

		childPath := filepath.Join(dir, name)
		if seen[childPath] {
			continue
		}

		scripts := getScripts(childPath)
		if len(scripts) > 0 {
			seen[childPath] = true
			pm := detectPackageManager(childPath)
			port, fixed := detectConfigPort(childPath)
			proj := Project{
				Name:           name,
				Path:           childPath,
				PkgName:        getPkgName(childPath),
				Scripts:        scripts,
				PackageManager: pm,
				DetectedPort:   port,
				PortFixed:      fixed,
			}
			if wsRoot != "" && childPath != wsRoot {
				proj.WorkspaceRoot = wsRoot
			}
			*projects = append(*projects, proj)
			continue // don't scan inside a detected project
		}

		// Recurse into subdirectory
		scanLevel(childPath, wsRoot, projects, seen, depth+1, maxDepth)
	}
}

// isPnpmWorkspace checks if the directory has pnpm-workspace.yaml
func isPnpmWorkspace(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml"))
	return err == nil
}

// getPkgName reads the "name" field from package.json
func getPkgName(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	return pkg.Name
}

// isEncoreProject checks if a directory contains encore.app
func isEncoreProject(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "encore.app"))
	return err == nil
}

// priorityScripts are shown first in the script list
var priorityScripts = []string{"dev", "start", "serve", "watch"}

// getScripts reads all script names from package.json, sorted with dev/start first
func getScripts(dir string) []string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil || len(pkg.Scripts) == 0 {
		return nil
	}

	var priority, rest []string
	seen := make(map[string]bool)
	for _, name := range priorityScripts {
		if _, ok := pkg.Scripts[name]; ok {
			priority = append(priority, name)
			seen[name] = true
		}
	}
	for name := range pkg.Scripts {
		if !seen[name] {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	return append(priority, rest...)
}

// hasOnlyOrchestratorScripts returns true if all priority dev scripts (dev/start/serve/watch)
// are orchestrators (turbo/lerna/nx). Non-priority scripts like lint/test/build are ignored
// since the launcher is for running dev servers, not arbitrary scripts.
func hasOnlyOrchestratorScripts(scripts []string, dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return false
	}
	// Only check priority scripts — these are what users actually launch
	hasPriority := false
	for _, name := range priorityScripts {
		cmd, ok := pkg.Scripts[name]
		if !ok {
			continue
		}
		hasPriority = true
		if !isOrchestratorScript(cmd) {
			return false
		}
	}
	// If no priority scripts exist at all, treat as orchestrator-only (skip)
	return hasPriority
}

// detectPackageManager walks up from dir looking for lock files
func detectPackageManager(dir string) string {
	lockFiles := []struct {
		file string
		pm   string
	}{
		{"pnpm-lock.yaml", "pnpm"},
		{"yarn.lock", "yarn"},
		{"package-lock.json", "npm"},
		{"bun.lockb", "bun"},
	}

	current := dir
	for {
		for _, lf := range lockFiles {
			if _, err := os.Stat(filepath.Join(current, lf.file)); err == nil {
				return lf.pm
			}
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return "npm"
}

// devConfigFiles are checked for hardcoded port values
var devConfigFiles = []string{
	"webpack.dev.ts", "webpack.dev.js",
	"webpack.config.ts", "webpack.config.js",
	"vite.config.ts", "vite.config.js",
	"next.config.ts", "next.config.js", "next.config.mjs",
}

// portLiteralRe matches `port: 8080` or `port: 3000,` etc.
var portLiteralRe = regexp.MustCompile(`(?m)port:\s*(\d{2,5})\b`)

// portEnvRe matches patterns like `process.env.PORT` near a port assignment
var portEnvRe = regexp.MustCompile(`(?m)port:.*process\.env\.PORT`)

// detectConfigPort scans dev config files for a port value.
// Returns (port, fixed): port is the detected number, fixed is true if hardcoded.
func detectConfigPort(dir string) (int, bool) {
	for _, name := range devConfigFiles {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		content := string(data)

		matches := portLiteralRe.FindStringSubmatch(content)
		if len(matches) < 2 {
			continue
		}
		port, err := strconv.Atoi(matches[1])
		if err != nil || port < 1 || port > 65535 {
			continue
		}

		// Check if port is configurable via process.env.PORT
		if portEnvRe.MatchString(content) {
			return port, false // port detected but overridable
		}
		return port, true // hardcoded
	}
	return 0, false
}

// isOrchestratorScript returns true if the dev script is a monorepo orchestrator
// (turbo, lerna, nx) that runs all sub-projects rather than a single app
func isOrchestratorScript(script string) bool {
	s := strings.TrimSpace(script)
	for _, prefix := range []string{"turbo ", "turbo\t", "lerna ", "nx "} {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	// Also match exact command names (e.g., "turbo dev" without "run")
	for _, cmd := range []string{"turbo", "lerna", "nx"} {
		if s == cmd {
			return true
		}
	}
	return false
}
