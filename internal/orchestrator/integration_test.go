package orchestrator

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// TestIntegration_FullLifecycle exercises up -> status -> logs -> down
// end-to-end against a hermetic project (fake proxy client, a fake "pnpm"
// on PATH that just sleeps, and a real temp git repo/worktree), per
// quickstart.md Scenarios A-F (no real Caddy / port 80). T040.
func TestIntegration_FullLifecycle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fakePnpmOnPath(t)

	branch := "orders-refactor"
	repoPath, _ := setupGitRepoWithWorktree(t, branch)

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
	pm := process.NewProcessManager(config.SessionsDir(), config.LogsDir())

	opts := UpOptions{
		Project: "simplx",
		Branch:  branch,
	}

	var inst *Instance

	t.Run("A_B_up_mixed_local_remote", func(t *testing.T) {
		var err error
		inst, err = Up(opts, fp, pm)
		if err != nil {
			t.Fatalf("Up() error = %v", err)
		}

		if inst.Slug != branch {
			t.Errorf("expected slug %q, got %q", branch, inst.Slug)
		}

		local := findService(t, inst, "front")
		if local.Status != "running" {
			t.Errorf("expected 'front' status running, got %q", local.Status)
		}
		if local.SessionName == "" {
			t.Fatalf("expected 'front' to have a session name")
		}
		rp := pm.Get(local.SessionName)
		if rp == nil {
			t.Fatalf("expected process manager to track session %q", local.SessionName)
		}
		// PID is only populated on the PTY fallback backend (0 is valid when
		// the tmux backend is used, per process.ProcessManager.Start); assert
		// liveness via the process manager itself instead of PID directly.
		if rp.Status != process.StatusRunning {
			t.Errorf("expected 'front' tracked process to be running, got status %v", rp.Status)
		}

		remote := findService(t, inst, "platform")
		if remote.Status != "remote" {
			t.Errorf("expected 'platform' status remote, got %q", remote.Status)
		}
		if remote.Upstream != "https://platform-test.sadmin.app" {
			t.Errorf("expected 'platform' upstream preserved, got %q", remote.Upstream)
		}

		if len(fp.addRouteCalls) != 2 {
			t.Errorf("expected 2 AddRoute calls (one per service), got %d: %+v", len(fp.addRouteCalls), fp.addRouteCalls)
		}
		if fp.ensureRunningCalls != 1 {
			t.Errorf("expected EnsureRunning called once, got %d", fp.ensureRunningCalls)
		}

		persisted, err := ReadInstance(inst.Slug)
		if err != nil {
			t.Fatalf("ReadInstance() error = %v", err)
		}
		if len(persisted.Services) != 2 {
			t.Errorf("expected persisted instance to have 2 services, got %+v", persisted.Services)
		}
	})

	t.Run("C_up_again_is_idempotent", func(t *testing.T) {
		local := findService(t, inst, "front")
		firstPID := local.PID
		firstSession := local.SessionName

		// give the process a moment to settle before re-invoking Up.
		waitUntil(t, 2*time.Second, func() bool {
			return pm.Get(firstSession) != nil
		})

		second, err := Up(opts, fp, pm)
		if err != nil {
			t.Fatalf("second Up() error = %v", err)
		}

		secondLocal := findService(t, second, "front")
		if secondLocal.PID != firstPID {
			t.Errorf("expected idempotent second Up() to keep the same pid %d, got %d", firstPID, secondLocal.PID)
		}
		if secondLocal.SessionName != firstSession {
			t.Errorf("expected idempotent second Up() to keep the same session %q, got %q", firstSession, secondLocal.SessionName)
		}

		running := 0
		for _, rp := range pm.List() {
			if rp.Info.Name == firstSession {
				running++
			}
		}
		if running != 1 {
			t.Errorf("expected exactly 1 tracked process for session %q, found %d", firstSession, running)
		}

		inst = second
	})

	t.Run("E_status_reports_instance_and_rows", func(t *testing.T) {
		var buf bytes.Buffer
		if err := Status(&buf, inst.Slug, pm); err != nil {
			t.Fatalf("Status() error = %v", err)
		}
		out := buf.String()

		if !strings.Contains(out, "simplx / "+branch) {
			t.Errorf("expected status output to contain instance header, got:\n%s", out)
		}
		if !strings.Contains(out, "front") || !strings.Contains(out, "running") {
			t.Errorf("expected status output to contain local 'front' running row, got:\n%s", out)
		}
		if !strings.Contains(out, "platform") || !strings.Contains(out, "proxy") {
			t.Errorf("expected status output to contain remote 'platform' proxy row, got:\n%s", out)
		}
	})

	t.Run("D_logs_tail_is_ansi_free", func(t *testing.T) {
		local := findService(t, inst, "front")
		if local.LogPath == "" {
			t.Fatalf("expected 'front' service to have a log path")
		}

		if err := os.MkdirAll(filepath.Dir(local.LogPath), 0o755); err != nil {
			t.Fatalf("mkdir log dir: %v", err)
		}

		content := "line1\n\x1b[31mline2-colored\x1b[0m\nline3\n"
		if err := os.WriteFile(local.LogPath, []byte(content), 0o644); err != nil {
			t.Fatalf("write log file: %v", err)
		}

		var buf bytes.Buffer
		if err := Logs(&buf, inst.Slug, "front", LogOptions{Tail: 10}); err != nil {
			t.Fatalf("Logs() error = %v", err)
		}
		out := buf.String()

		if strings.Contains(out, "\x1b") {
			t.Errorf("expected logs output to be ANSI-free, got: %q", out)
		}
		if !strings.Contains(out, "line1") || !strings.Contains(out, "line2-colored") || !strings.Contains(out, "line3") {
			t.Errorf("expected tailed content to contain all written lines, got: %q", out)
		}
	})

	t.Run("F_down_stops_local_removes_routes_deletes_registry", func(t *testing.T) {
		// Bring up a second, independent instance so we can assert it survives
		// downing the first.
		branch2 := "other-branch"
		_, _ = setupGitRepoWithWorktree2(t, repoPath, branch2)

		fp2 := &fakeProxy{}
		opts2 := UpOptions{Project: "simplx", Branch: branch2}
		inst2, err := Up(opts2, fp2, pm)
		if err != nil {
			t.Fatalf("Up() for second instance error = %v", err)
		}

		local := findService(t, inst, "front")
		sessionName := local.SessionName

		found, err := Down(inst.Slug, fp, pm)
		if err != nil {
			t.Fatalf("Down() error = %v", err)
		}
		if !found {
			t.Fatalf("expected Down() found=true for existing instance %q", inst.Slug)
		}

		if rp := pm.Get(sessionName); rp != nil {
			t.Errorf("expected session %q to be stopped, but process manager still tracks it", sessionName)
		}

		removed := false
		for _, s := range fp.removedSlugs {
			if s == inst.Slug {
				removed = true
			}
		}
		if !removed {
			t.Errorf("expected RemoveRoutesByInstance called with %q, got %+v", inst.Slug, fp.removedSlugs)
		}

		if _, err := ReadInstance(inst.Slug); !os.IsNotExist(err) {
			t.Errorf("expected instance %q registry to be deleted, ReadInstance() error = %v", inst.Slug, err)
		}

		// The other instance must remain untouched.
		if _, err := ReadInstance(inst2.Slug); err != nil {
			t.Errorf("expected instance %q registry to remain untouched, ReadInstance() error = %v", inst2.Slug, err)
		}
		inst2Local := findService(t, inst2, "front")
		if rp := pm.Get(inst2Local.SessionName); rp == nil {
			t.Errorf("expected instance %q's process to remain running", inst2.Slug)
		} else {
			_ = pm.Stop(inst2Local.SessionName) // cleanup
		}
	})
}

// findService returns a pointer to the named service in inst.Services,
// failing the test if absent.
func findService(t *testing.T, inst *Instance, service string) *ServiceState {
	t.Helper()
	for i := range inst.Services {
		if inst.Services[i].Service == service {
			return &inst.Services[i]
		}
	}
	t.Fatalf("expected service %q in instance, got %+v", service, inst.Services)
	return nil
}

// waitUntil polls cond until it returns true or timeout elapses, failing the
// test on timeout. Used instead of a fixed sleep to keep the test fast and
// non-flaky.
func waitUntil(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !cond() {
		t.Fatalf("condition not met within %s", timeout)
	}
}

// setupGitRepoWithWorktree2 adds a second worktree (for branchName) onto an
// already-initialized repo (as created by setupGitRepoWithWorktree), so a
// second independent instance can be brought up against the same repo.
func setupGitRepoWithWorktree2(t *testing.T, repoPath, branchName string) (repoPath2, worktreePath string) {
	t.Helper()
	requireGit(t)

	worktreePath = filepath.Join(filepath.Dir(repoPath), "wt2")

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

	run(repoPath, "worktree", "add", "-q", "-b", branchName, worktreePath)

	return repoPath, worktreePath
}
