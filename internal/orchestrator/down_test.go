package orchestrator

import (
	"os"
	"testing"

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
