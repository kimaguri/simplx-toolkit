package orchestrator

import (
	"os/exec"
	"path/filepath"
	"sort"
	"testing"

	"github.com/kimaguri/simplx-toolkit/internal/config"
)

func fixtureProjectConfig() *config.ProjectConfig {
	return &config.ProjectConfig{
		Name:         "simplx",
		DomainSuffix: "localhost",
		Repos: map[string]string{
			"front":    "/repo/front",
			"core":     "/repo/core",
			"platform": "/repo/platform",
		},
		Services: map[string]config.ServiceConfig{
			"front":    {Repo: "front", Package: "@repo/host", Script: "dev", Mode: "local"},
			"core":     {Repo: "core", Package: "@repo/core", Script: "dev", Mode: "remote", Remote: "https://core-test.sadmin.app"},
			"platform": {Repo: "platform", Package: "@repo/platform", Script: "dev", Mode: "remote", Remote: "https://platform-test.sadmin.app"},
		},
	}
}

func serviceNames(services []ResolvedService) []string {
	names := make([]string, 0, len(services))
	for _, s := range services {
		names = append(names, s.Service)
	}
	return names
}

func TestResolveModes_DefaultsRespected(t *testing.T) {
	cfg := fixtureProjectConfig()

	resolved, warnings := ResolveModes(cfg, nil, nil)

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}
	if len(resolved) != 3 {
		t.Fatalf("expected 3 resolved services, got %d", len(resolved))
	}

	modeByName := make(map[string]string)
	for _, r := range resolved {
		modeByName[r.Service] = r.Mode
	}

	if modeByName["front"] != "local" {
		t.Errorf("expected front default mode local, got %q", modeByName["front"])
	}
	if modeByName["core"] != "remote" {
		t.Errorf("expected core default mode remote, got %q", modeByName["core"])
	}
	if modeByName["platform"] != "remote" {
		t.Errorf("expected platform default mode remote, got %q", modeByName["platform"])
	}

	// stable order — sorted by service key
	names := serviceNames(resolved)
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	for i := range names {
		if names[i] != sorted[i] {
			t.Errorf("expected stable sorted order, got %v", names)
			break
		}
	}
}

func TestResolveModes_LocalOverrideForcesLocal(t *testing.T) {
	cfg := fixtureProjectConfig()

	resolved, warnings := ResolveModes(cfg, []string{"core"}, nil)

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}

	modeByName := make(map[string]string)
	for _, r := range resolved {
		modeByName[r.Service] = r.Mode
	}

	if modeByName["core"] != "local" {
		t.Errorf("expected core forced to local, got %q", modeByName["core"])
	}
	if modeByName["platform"] != "remote" {
		t.Errorf("expected platform to remain remote, got %q", modeByName["platform"])
	}
}

func TestResolveModes_RemoteOverrideForcesRemote(t *testing.T) {
	cfg := fixtureProjectConfig()

	resolved, warnings := ResolveModes(cfg, nil, []string{"front"})

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}

	modeByName := make(map[string]string)
	for _, r := range resolved {
		modeByName[r.Service] = r.Mode
	}

	if modeByName["front"] != "remote" {
		t.Errorf("expected front forced to remote, got %q", modeByName["front"])
	}
}

func TestResolveModes_BothOverridesApplyInOrder(t *testing.T) {
	cfg := fixtureProjectConfig()

	// localOverrides are applied first, then remoteOverrides — so a service
	// named in both ends up "remote" (remote applied last wins).
	resolved, warnings := ResolveModes(cfg, []string{"core"}, []string{"core"})

	if len(warnings) != 0 {
		t.Fatalf("expected no warnings, got %v", warnings)
	}

	modeByName := make(map[string]string)
	for _, r := range resolved {
		modeByName[r.Service] = r.Mode
	}

	// remoteOverrides applied after localOverrides -> remote wins
	if modeByName["core"] != "remote" {
		t.Errorf("expected core to end up remote (remote applied after local), got %q", modeByName["core"])
	}
}

func TestResolveModes_UnknownOverrideNameWarnsAndIgnored(t *testing.T) {
	cfg := fixtureProjectConfig()

	resolved, warnings := ResolveModes(cfg, []string{"nonexistent-service"}, nil)

	if len(resolved) != 3 {
		t.Fatalf("expected 3 resolved services (unknown ignored), got %d", len(resolved))
	}
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d: %v", len(warnings), warnings)
	}
	found := false
	for _, w := range warnings {
		if w == "nonexistent-service" || (len(w) > 0 && containsSubstring(w, "nonexistent-service")) {
			found = true
		}
	}
	if !found {
		t.Errorf("expected warning to reference unknown service name, got %v", warnings)
	}
}

func containsSubstring(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || (len(substr) > 0 && indexOf(s, substr) >= 0))
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func TestParseWorktreePorcelain(t *testing.T) {
	output := `worktree /repo/front
HEAD abcdef1234567890
branch refs/heads/main

worktree /repo/.worktrees/feat-lab-57-some-feature
HEAD 1234567890abcdef
branch refs/heads/feat/lab-57/some-feature

worktree /repo/.worktrees/detached-wt
HEAD fedcba0987654321
detached
`

	entries := parseWorktreePorcelain(output)

	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d: %+v", len(entries), entries)
	}

	if entries[0].Path != "/repo/front" || entries[0].Branch != "main" {
		t.Errorf("unexpected entry[0]: %+v", entries[0])
	}
	if entries[1].Path != "/repo/.worktrees/feat-lab-57-some-feature" || entries[1].Branch != "feat/lab-57/some-feature" {
		t.Errorf("unexpected entry[1]: %+v", entries[1])
	}
	if entries[2].Path != "/repo/.worktrees/detached-wt" || entries[2].Branch != "" {
		t.Errorf("unexpected entry[2] (detached should have empty branch): %+v", entries[2])
	}
}

func TestFindWorktree_MatchAndMiss(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	repoDir := t.TempDir()
	worktreeParent := t.TempDir()

	runGit := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, out)
		}
	}

	runGit(repoDir, "init", "-q")
	runGit(repoDir, "config", "user.email", "test@example.com")
	runGit(repoDir, "config", "user.name", "Test")
	runGit(repoDir, "commit", "--allow-empty", "-q", "-m", "init")
	runGit(repoDir, "branch", "feature-branch")

	worktreePath := worktreeParent + "/feature-wt"
	runGit(repoDir, "worktree", "add", worktreePath, "feature-branch")

	path, ok := FindWorktree(repoDir, "feature-branch")
	if !ok {
		t.Fatalf("expected to find worktree for feature-branch")
	}
	// Resolve symlinks (e.g. macOS /var -> /private/var) since git reports
	// the fully resolved path while t.TempDir() may return the symlinked form.
	wantPath, err := filepath.EvalSymlinks(worktreePath)
	if err != nil {
		wantPath = worktreePath
	}
	gotPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		gotPath = path
	}
	if gotPath != wantPath {
		t.Errorf("expected path %q, got %q", wantPath, gotPath)
	}

	_, ok = FindWorktree(repoDir, "does-not-exist-branch")
	if ok {
		t.Errorf("expected no match for nonexistent branch")
	}
}
