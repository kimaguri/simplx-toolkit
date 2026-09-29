package orchestrator

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/process"
	"github.com/kimaguri/simplx-toolkit/internal/proxy"
)

// downFakeProxy is a ProxyClient test double recording RemoveRoutesByInstance
// calls so tests can assert exactly which instance's routes were touched.
type downFakeProxy struct {
	removedSlugs []string
}

func (f *downFakeProxy) EnsureRunning() error   { return nil }
func (f *downFakeProxy) AddRoute(proxy.Route) error { return nil }
func (f *downFakeProxy) RemoveRoutesByInstance(slug string) error {
	f.removedSlugs = append(f.removedSlugs, slug)
	return nil
}

func newDownTestProcessManager(t *testing.T) *process.ProcessManager {
	t.Helper()
	return process.NewProcessManager(config.SessionsDir(), config.LogsDir())
}

// startFakeSession spawns a harmless long-lived "sleep"-based session under
// name via the real ProcessManager, so Down() can exercise a real Stop().
func startFakeSession(t *testing.T, pm *process.ProcessManager, name string) {
	t.Helper()
	info := process.SessionInfo{
		Name:    name,
		Command: "sleep",
		Args:    []string{"30"},
		WorkDir: t.TempDir(),
	}
	if _, err := pm.Start(info); err != nil {
		t.Fatalf("pm.Start(%q) error = %v", name, err)
	}
}

func TestDown_StopsLocalProcsRemovesRoutesAndDeletesRegistry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	pm := newDownTestProcessManager(t)
	fp := &downFakeProxy{}

	slugA := "orders-refactor"
	slugB := "other-branch"

	sessionA := "dev-" + slugA + "-front"
	sessionB := "dev-" + slugB + "-front"

	startFakeSession(t, pm, sessionA)
	startFakeSession(t, pm, sessionB)

	instA := Instance{
		Project: "simplx",
		Branch:  "orders-refactor",
		Slug:    slugA,
		Services: []ServiceState{
			{Service: "front", Mode: "local", Status: "running", SessionName: sessionA, Port: 5173},
		},
	}
	instB := Instance{
		Project: "simplx",
		Branch:  "other-branch",
		Slug:    slugB,
		Services: []ServiceState{
			{Service: "front", Mode: "local", Status: "running", SessionName: sessionB, Port: 5174},
		},
	}

	if err := WriteInstance(instA); err != nil {
		t.Fatalf("WriteInstance(A) error = %v", err)
	}
	if err := WriteInstance(instB); err != nil {
		t.Fatalf("WriteInstance(B) error = %v", err)
	}

	found, err := Down(slugA, fp, pm)
	if err != nil {
		t.Fatalf("Down() error = %v", err)
	}
	if !found {
		t.Fatalf("expected Down() found=true for existing instance %q", slugA)
	}

	// A's process should be stopped and no longer tracked.
	if rp := pm.Get(sessionA); rp != nil {
		t.Errorf("expected session %q to be stopped, but process manager still tracks it", sessionA)
	}

	// B's process must be untouched.
	if rp := pm.Get(sessionB); rp == nil {
		t.Errorf("expected session %q (other instance) to remain running", sessionB)
	} else {
		_ = pm.Stop(sessionB) // cleanup
	}

	// Routes: RemoveRoutesByInstance called exactly once, for slugA only.
	if len(fp.removedSlugs) != 1 || fp.removedSlugs[0] != slugA {
		t.Errorf("expected RemoveRoutesByInstance called exactly once with %q, got %+v", slugA, fp.removedSlugs)
	}

	// A's registry file must be gone.
	if _, err := ReadInstance(slugA); !os.IsNotExist(err) {
		t.Errorf("expected instance %q registry to be deleted, ReadInstance() error = %v", slugA, err)
	}

	// B's registry file must be untouched.
	if _, err := ReadInstance(slugB); err != nil {
		t.Errorf("expected instance %q registry to remain, ReadInstance() error = %v", slugB, err)
	}
}

// tmuxSessionExistsForTest is a test-local oracle, independent of
// ProcessManager's own bookkeeping, for whether the real OS-level tmux
// session backing a devdash session name is still alive. Mirrors the
// "maomao-" + SafeName(name) naming in internal/process/tmux.go.
func tmuxSessionExistsForTest(name string) bool {
	err := exec.Command("tmux", "-L", "maomao", "has-session",
		"-t", "maomao-"+process.SafeName(name)).Run()
	return err == nil
}

// TestDown_CrossInvocation_ActuallyKillsRealProcess reproduces the LAB-294
// root cause directly: `up` and `down` are separate CLI invocations, each
// constructing its own ProcessManager. Down() must reconnect to (and
// actually terminate) state persisted by a DIFFERENT, earlier
// ProcessManager instance — not just state it started itself, which is all
// TestDown_StopsLocalProcsRemovesRoutesAndDeletesRegistry above exercises.
func TestDown_CrossInvocation_ActuallyKillsRealProcess(t *testing.T) {
	if !process.IsTmuxAvailable() {
		t.Skip("tmux not available; this test verifies the tmux-backend cross-invocation path")
	}
	t.Setenv("HOME", t.TempDir())

	// "up" invocation: its ProcessManager and everything in-memory about it
	// goes away once this function scope ends, exactly like a real `devdash
	// up` process exiting after spawning a long-lived tmux-backed service.
	pmUp := newDownTestProcessManager(t)
	slug := "cross-invocation"
	sessionName := "dev-" + slug + "-front"
	startFakeSession(t, pmUp, sessionName)

	if !tmuxSessionExistsForTest(sessionName) {
		t.Fatalf("setup: expected tmux session for %q to exist after Start", sessionName)
	}

	inst := Instance{
		Project: "simplx",
		Branch:  slug,
		Slug:    slug,
		Services: []ServiceState{
			{Service: "front", Mode: "local", Status: "running", SessionName: sessionName, Port: 5173},
		},
	}
	if err := WriteInstance(inst); err != nil {
		t.Fatalf("WriteInstance() error = %v", err)
	}

	// "down" invocation: a genuinely SEPARATE ProcessManager, as
	// cmd/devdash/main.go's runDown constructs. Without pm.Reconnect(),
	// pmDown.processes is empty and Down() would silently no-op.
	pmDown := newDownTestProcessManager(t)
	pmDown.Reconnect()
	fp := &downFakeProxy{}

	found, err := Down(slug, fp, pmDown)
	if err != nil {
		t.Fatalf("Down() error = %v", err)
	}
	if !found {
		t.Fatalf("expected found=true")
	}

	deadline := time.Now().Add(5 * time.Second)
	for tmuxSessionExistsForTest(sessionName) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if tmuxSessionExistsForTest(sessionName) {
		t.Errorf("expected tmux session for %q to be killed by Down(), but it still exists — "+
			"Down() must have silently no-op'd instead of actually terminating the reconnected process", sessionName)
	}
}

func TestDown_UnknownInstanceIsNonDestructiveNoop(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	pm := newDownTestProcessManager(t)
	fp := &downFakeProxy{}

	found, err := Down("does-not-exist", fp, pm)
	if err != nil {
		t.Fatalf("Down() error = %v, want nil for unknown instance", err)
	}
	if found {
		t.Errorf("expected found=false for unknown instance, got true")
	}
	if len(fp.removedSlugs) != 0 {
		t.Errorf("expected no RemoveRoutesByInstance calls for unknown instance, got %+v", fp.removedSlugs)
	}
}

func TestDown_UnknownInstanceLeavesOtherInstancesUntouched(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	pm := newDownTestProcessManager(t)
	fp := &downFakeProxy{}

	slugB := "still-here"
	if err := WriteInstance(Instance{Slug: slugB}); err != nil {
		t.Fatalf("WriteInstance(B) error = %v", err)
	}

	found, err := Down("does-not-exist", fp, pm)
	if err != nil {
		t.Fatalf("Down() error = %v", err)
	}
	if found {
		t.Errorf("expected found=false, got true")
	}

	if _, err := ReadInstance(slugB); err != nil {
		t.Errorf("expected untouched instance %q to remain, ReadInstance() error = %v", slugB, err)
	}
}
