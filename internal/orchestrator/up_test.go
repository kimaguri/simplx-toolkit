package orchestrator

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/proxy"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// fakeProxy is a ProxyClient test double recording every call so tests can
// assert on routing behavior without a real Caddy instance.
type fakeProxy struct {
	ensureRunningCalls int
	ensureRunningErr   error
	addRouteCalls      []proxy.Route
	addRouteErr        error
	removedSlugs       []string
}

func (f *fakeProxy) EnsureRunning() error {
	f.ensureRunningCalls++
	return f.ensureRunningErr
}

func (f *fakeProxy) AddRoute(r proxy.Route) error {
	f.addRouteCalls = append(f.addRouteCalls, r)
	return f.addRouteErr
}

func (f *fakeProxy) RemoveRoutesByInstance(slug string) error {
	f.removedSlugs = append(f.removedSlugs, slug)
	return nil
}

// requireGit skips the test if git is not available on PATH.
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available on PATH")
	}
}

// setupGitRepoWithWorktree creates a bare-ish temp git repo with an initial
// commit on its default branch, then adds a worktree checked out on
// branchName at a sibling directory. Returns the main repo path and the
// worktree path.
func setupGitRepoWithWorktree(t *testing.T, branchName string) (repoPath, worktreePath string) {
	t.Helper()
	requireGit(t)

	base := t.TempDir()
	repoPath = filepath.Join(base, "repo")
	worktreePath = filepath.Join(base, "wt")

	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}

	run := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@test.local",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@test.local",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run(repoPath, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run(repoPath, "add", ".")
	run(repoPath, "commit", "-q", "-m", "init")
	run(repoPath, "worktree", "add", "-q", "-b", branchName, worktreePath)

	return repoPath, worktreePath
}

// fakePnpmOnPath installs a harmless "pnpm" shell script onto PATH (prepended
// for the duration of the test) that just sleeps briefly so ProcessManager.Start
// has a real, long-enough-lived process to track, without needing an actual
// pnpm workspace.
func fakePnpmOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\nsleep 30\n"
	path := filepath.Join(dir, "pnpm")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake pnpm: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// writeCentralProjectConfig writes a ProjectConfig JSON to the central
// projects dir used by config.ResolveProjectConfig.
func writeCentralProjectConfig(t *testing.T, cfg config.ProjectConfig) {
	t.Helper()
	dir := config.ProjectsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects dir: %v", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal project config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, cfg.Name+".json"), data, 0o644); err != nil {
		t.Fatalf("write project config: %v", err)
	}
}

func newTestProcessManager(t *testing.T) *process.ProcessManager {
	t.Helper()
	return process.NewProcessManager(config.SessionsDir(), config.LogsDir())
}

func TestUp_MixedLocalRemote(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fakePnpmOnPath(t)

	repoPath, _ := setupGitRepoWithWorktree(t, "orders-refactor")

	cfg := config.ProjectConfig{
		Name:         "simplx",
		DomainSuffix: "simplx.localhost",
		Layout:       "worktree",
		Repos: map[string]string{
			"apps": repoPath,
		},
		Services: map[string]config.ServiceConfig{
			"front":    {Repo: "apps", Package: "", Script: "dev", Mode: "local"},
			"platform": {Repo: "apps", Package: "", Script: "dev", Mode: "remote", Remote: "https://platform-test.sadmin.app"},
		},
	}
	writeCentralProjectConfig(t, cfg)

	fp := &fakeProxy{}
	pm := newTestProcessManager(t)

	opts := UpOptions{
		Project: "simplx",
		Branch:  "orders-refactor",
	}

	inst, err := Up(opts, fp, pm)
	if err != nil {
		t.Fatalf("Up() error = %v", err)
	}

	if inst.Slug != "orders-refactor" {
		t.Errorf("expected slug orders-refactor, got %q", inst.Slug)
	}

	var front, platform *ServiceState
	for i := range inst.Services {
		switch inst.Services[i].Service {
		case "front":
			front = &inst.Services[i]
		case "platform":
			platform = &inst.Services[i]
		}
	}

	if front == nil {
		t.Fatalf("expected 'front' service in instance, got %+v", inst.Services)
	}
	if front.Status != "running" {
		t.Errorf("expected 'front' status running, got %q", front.Status)
	}
	if front.Port == 0 {
		t.Errorf("expected 'front' to have a non-zero allocated port")
	}
	if front.SessionName == "" {
		t.Errorf("expected 'front' to have a session name")
	}
	rp := pm.Get(front.SessionName)
	if rp == nil {
		t.Fatalf("expected process manager to track session %q", front.SessionName)
	}

	// The persisted session must carry Instance/Service so the TUI (which
	// reads the same session dir via internal/devdash) can group it under an
	// instance header instead of "(ungrouped)" (FR-032, T044).
	if rp.Info.Instance != inst.Slug {
		t.Errorf("expected session Instance = %q, got %q", inst.Slug, rp.Info.Instance)
	}
	if rp.Info.Service != "front" {
		t.Errorf("expected session Service = %q, got %q", "front", rp.Info.Service)
	}

	if platform == nil {
		t.Fatalf("expected 'platform' service in instance, got %+v", inst.Services)
	}
	if platform.Status != "remote" {
		t.Errorf("expected 'platform' status remote, got %q", platform.Status)
	}
	if platform.Upstream != "https://platform-test.sadmin.app" {
		t.Errorf("expected 'platform' upstream to be preserved, got %q", platform.Upstream)
	}

	if fp.ensureRunningCalls != 1 {
		t.Errorf("expected EnsureRunning called once, got %d", fp.ensureRunningCalls)
	}
	if len(fp.addRouteCalls) != 2 {
		t.Errorf("expected 2 AddRoute calls (one per service), got %d: %+v", len(fp.addRouteCalls), fp.addRouteCalls)
	}

	// Registry should have been written.
	persisted, err := ReadInstance(inst.Slug)
	if err != nil {
		t.Fatalf("ReadInstance() error = %v", err)
	}
	if len(persisted.Services) != 2 {
		t.Errorf("expected persisted instance to have 2 services, got %+v", persisted.Services)
	}

	// Cleanup the spawned process so it doesn't leak past the test.
	_ = pm.Stop(front.SessionName)
}

func TestUp_MissingWorktreeSkippedAndWarned(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fakePnpmOnPath(t)

	// A repo with NO worktree for the requested branch.
	repoPath, _ := setupGitRepoWithWorktree(t, "some-other-branch")

	cfg := config.ProjectConfig{
		Name:         "simplx",
		DomainSuffix: "simplx.localhost",
		Layout:       "worktree",
		Repos: map[string]string{
			"apps": repoPath,
		},
		Services: map[string]config.ServiceConfig{
			"front":    {Repo: "apps", Package: "", Script: "dev", Mode: "local"},
			"platform": {Repo: "apps", Package: "", Script: "dev", Mode: "remote", Remote: "https://platform-test.sadmin.app"},
		},
	}
	writeCentralProjectConfig(t, cfg)

	fp := &fakeProxy{}
	pm := newTestProcessManager(t)

	opts := UpOptions{
		Project: "simplx",
		Branch:  "orders-refactor", // no worktree exists for this branch
	}

	inst, err := Up(opts, fp, pm)
	if err != nil {
		t.Fatalf("Up() error = %v (expected 'platform' remote service to keep this launchable)", err)
	}

	for _, svc := range inst.Services {
		if svc.Service == "front" {
			t.Errorf("expected 'front' to be skipped (missing worktree), got %+v", svc)
		}
	}

	found := false
	for _, svc := range inst.Services {
		if svc.Service == "platform" && svc.Status == "remote" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected 'platform' remote service to still be brought up, got %+v", inst.Services)
	}
}

func TestUp_NoActionableServicesReturnsError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fakePnpmOnPath(t)

	// A repo with NO worktree for the requested branch, and only local services.
	repoPath, _ := setupGitRepoWithWorktree(t, "some-other-branch")

	cfg := config.ProjectConfig{
		Name:         "simplx",
		DomainSuffix: "simplx.localhost",
		Layout:       "worktree",
		Repos: map[string]string{
			"apps": repoPath,
		},
		Services: map[string]config.ServiceConfig{
			"front": {Repo: "apps", Package: "", Script: "dev", Mode: "local"},
		},
	}
	writeCentralProjectConfig(t, cfg)

	fp := &fakeProxy{}
	pm := newTestProcessManager(t)

	opts := UpOptions{
		Project: "simplx",
		Branch:  "orders-refactor",
	}

	_, err := Up(opts, fp, pm)
	if err == nil {
		t.Fatalf("expected error when nothing is launchable, got nil")
	}
}

func TestUp_IdempotentSecondCallDoesNotDuplicate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fakePnpmOnPath(t)

	repoPath, _ := setupGitRepoWithWorktree(t, "orders-refactor")

	cfg := config.ProjectConfig{
		Name:         "simplx",
		DomainSuffix: "simplx.localhost",
		Layout:       "worktree",
		Repos: map[string]string{
			"apps": repoPath,
		},
		Services: map[string]config.ServiceConfig{
			"front": {Repo: "apps", Package: "", Script: "dev", Mode: "local"},
		},
	}
	writeCentralProjectConfig(t, cfg)

	fp := &fakeProxy{}
	pm := newTestProcessManager(t)

	opts := UpOptions{
		Project: "simplx",
		Branch:  "orders-refactor",
	}

	first, err := Up(opts, fp, pm)
	if err != nil {
		t.Fatalf("first Up() error = %v", err)
	}

	var firstFront *ServiceState
	for i := range first.Services {
		if first.Services[i].Service == "front" {
			firstFront = &first.Services[i]
		}
	}
	if firstFront == nil {
		t.Fatalf("expected 'front' service after first Up(), got %+v", first.Services)
	}
	firstPID := firstFront.PID

	// give the process a moment to actually be running/registered
	time.Sleep(50 * time.Millisecond)

	second, err := Up(opts, fp, pm)
	if err != nil {
		t.Fatalf("second Up() error = %v", err)
	}

	var secondFront *ServiceState
	for i := range second.Services {
		if second.Services[i].Service == "front" {
			secondFront = &second.Services[i]
		}
	}
	if secondFront == nil {
		t.Fatalf("expected 'front' service after second Up(), got %+v", second.Services)
	}

	if secondFront.PID != firstPID {
		t.Errorf("expected idempotent second Up() to keep the same pid %d, got %d", firstPID, secondFront.PID)
	}

	running := 0
	for _, rp := range pm.List() {
		if rp.Info.Name == firstFront.SessionName {
			running++
		}
	}
	if running != 1 {
		t.Errorf("expected exactly 1 tracked process for session %q, found %d", firstFront.SessionName, running)
	}

	_ = pm.Stop(firstFront.SessionName)
}
