package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writePackageJSON creates a package.json with given scripts
func writePackageJSON(t *testing.T, dir string, name string, scripts map[string]string) {
	t.Helper()
	pkg := map[string]any{"name": name, "scripts": scripts}
	data, _ := json.Marshal(pkg)
	if err := os.WriteFile(filepath.Join(dir, "package.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
}

// writePackageJSONWithWorkspaces creates a package.json with scripts and workspaces field
func writePackageJSONWithWorkspaces(t *testing.T, dir string, name string, scripts map[string]string, workspaces []string) {
	t.Helper()
	pkg := map[string]any{"name": name, "scripts": scripts, "workspaces": workspaces}
	data, _ := json.Marshal(pkg)
	if err := os.WriteFile(filepath.Join(dir, "package.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
}

// TestDetectProjects_EncoreNoSubprojects verifies that an Encore project
// does not expose subdirectories as separate launchable projects.
func TestDetectProjects_EncoreNoSubprojects(t *testing.T) {
	root := t.TempDir()

	// Create encore.app at root
	os.WriteFile(filepath.Join(root, "encore.app"), []byte("{}"), 0644)

	// Create a subdir with its own package.json + dev script (like mainframe)
	sub := filepath.Join(root, "mainframe")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "mainframe", map[string]string{"dev": "tsx watch src/server.ts"})

	wt := Worktree{Name: "platform", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 project (Encore root only), got %d: %v", len(projects), projectNames(projects))
	}
	if !projects[0].IsEncore {
		t.Error("expected root project to be Encore")
	}
}

// TestDetectProjects_EncoreHasScripts verifies that Encore projects
// populate scripts from root package.json.
func TestDetectProjects_EncoreHasScripts(t *testing.T) {
	root := t.TempDir()

	os.WriteFile(filepath.Join(root, "encore.app"), []byte("{}"), 0644)
	writePackageJSON(t, root, "my-platform", map[string]string{
		"dev":     "encore run",
		"dev:all": "concurrently encore mainframe",
		"build":   "encore build",
	})

	wt := Worktree{Name: "platform", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	if projects[0].Name != "my-platform" {
		t.Errorf("expected name 'my-platform', got '%s'", projects[0].Name)
	}
	if len(projects[0].Scripts) == 0 {
		t.Error("expected scripts to be populated for Encore project")
	}
}

// TestDetectProjects_PnpmWorkspace verifies pnpm workspace scanning.
func TestDetectProjects_PnpmWorkspace(t *testing.T) {
	root := t.TempDir()

	os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte("packages:\n  - apps/*\n"), 0644)
	writePackageJSON(t, root, "monorepo", map[string]string{"dev": "turbo dev"})

	sub := filepath.Join(root, "app")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "app", map[string]string{"dev": "vite"})

	wt := Worktree{Name: "monorepo", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 leaf project, got %d: %v", len(projects), projectNames(projects))
	}
	if projects[0].Name != "app" {
		t.Errorf("expected project 'app', got '%s'", projects[0].Name)
	}
	if projects[0].WorkspaceRoot != root {
		t.Errorf("expected WorkspaceRoot=%s, got '%s'", root, projects[0].WorkspaceRoot)
	}
}

// TestDetectProjects_YarnWorkspace verifies yarn/npm workspace scanning
// via package.json "workspaces" field.
func TestDetectProjects_YarnWorkspace(t *testing.T) {
	root := t.TempDir()

	writePackageJSONWithWorkspaces(t, root, "yarn-mono",
		map[string]string{"dev": "turbo dev"},
		[]string{"packages/*"},
	)

	sub := filepath.Join(root, "web")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "web", map[string]string{"dev": "next dev"})

	wt := Worktree{Name: "yarn-mono", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 leaf project, got %d: %v", len(projects), projectNames(projects))
	}
	if projects[0].Name != "web" {
		t.Errorf("expected project 'web', got '%s'", projects[0].Name)
	}
}

// TestDetectProjects_NxMonorepo verifies nx.json is detected as workspace.
func TestDetectProjects_NxMonorepo(t *testing.T) {
	root := t.TempDir()

	os.WriteFile(filepath.Join(root, "nx.json"), []byte("{}"), 0644)
	writePackageJSON(t, root, "nx-mono", map[string]string{"dev": "nx serve"})

	sub := filepath.Join(root, "api")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "api", map[string]string{"dev": "nest start --watch"})

	wt := Worktree{Name: "nx-mono", Path: root}
	projects := DetectProjects(wt)

	// Root has orchestrator script "nx serve" → skipped; subdirs scanned
	if len(projects) != 1 {
		t.Fatalf("expected 1 leaf project, got %d: %v", len(projects), projectNames(projects))
	}
	if projects[0].Name != "api" {
		t.Errorf("expected project 'api', got '%s'", projects[0].Name)
	}
}

// TestDetectProjects_LernaMonorepo verifies lerna.json is detected as workspace.
func TestDetectProjects_LernaMonorepo(t *testing.T) {
	root := t.TempDir()

	os.WriteFile(filepath.Join(root, "lerna.json"), []byte("{}"), 0644)
	writePackageJSON(t, root, "lerna-mono", map[string]string{"dev": "lerna run dev"})

	sub := filepath.Join(root, "frontend")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "frontend", map[string]string{"dev": "react-scripts start"})

	wt := Worktree{Name: "lerna-mono", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 leaf project, got %d: %v", len(projects), projectNames(projects))
	}
	if projects[0].Name != "frontend" {
		t.Errorf("expected project 'frontend', got '%s'", projects[0].Name)
	}
}

// TestDetectProjects_StandaloneNodeProject verifies that a non-monorepo
// Node project with dev scripts does not scan subdirectories.
func TestDetectProjects_StandaloneNodeProject(t *testing.T) {
	root := t.TempDir()

	writePackageJSON(t, root, "my-app", map[string]string{"dev": "vite", "build": "vite build"})

	sub := filepath.Join(root, "tools")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "tools", map[string]string{"dev": "tsx watch"})

	wt := Worktree{Name: "my-app", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 project (root only), got %d: %v", len(projects), projectNames(projects))
	}
	expectedName := filepath.Base(root)
	if projects[0].Name != expectedName {
		t.Errorf("expected project '%s', got '%s'", expectedName, projects[0].Name)
	}
}

// TestDetectProjects_NoRootScansSubdirs verifies that when no root project
// is detected, subdirectories are still scanned.
func TestDetectProjects_NoRootScansSubdirs(t *testing.T) {
	root := t.TempDir()

	sub := filepath.Join(root, "backend")
	os.MkdirAll(sub, 0755)
	writePackageJSON(t, sub, "backend", map[string]string{"dev": "nodemon"})

	wt := Worktree{Name: "umbrella", Path: root}
	projects := DetectProjects(wt)

	if len(projects) != 1 {
		t.Fatalf("expected 1 project from subdir scan, got %d: %v", len(projects), projectNames(projects))
	}
	if projects[0].Name != "backend" {
		t.Errorf("expected project 'backend', got '%s'", projects[0].Name)
	}
}

// projectNames extracts names for error messages
func projectNames(projects []Project) []string {
	names := make([]string, len(projects))
	for i, p := range projects {
		names[i] = p.Name
	}
	return names
}
