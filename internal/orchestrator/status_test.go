package orchestrator

import (
	"strings"
	"testing"
)

// fixtureInstances returns two instances: one worktree-layout instance with
// a running local "front" service and a "remote" proxy "core" service, and
// one single-layout instance with a single local service whose pid the fake
// liveness closure reports as dead (to exercise reconciliation).
func fixtureInstances() []Instance {
	return []Instance{
		{
			Project:      "simplx",
			Branch:       "orders-refactor",
			Slug:         "orders-refactor",
			DomainSuffix: "simplx.localhost",
			Services: []ServiceState{
				{
					Service:     "front",
					Mode:        "local",
					Domain:      "orders-refactor-front.simplx.localhost",
					URL:         "http://orders-refactor-front.simplx.localhost",
					Port:        53412,
					PID:         4123,
					SessionName: "dev-orders-refactor-front",
					Status:      "running",
					LogPath:     "/logs/dev-orders-refactor-front.log",
				},
				{
					Service:  "core",
					Mode:     "remote",
					Domain:   "orders-refactor-core.simplx.localhost",
					URL:      "http://orders-refactor-core.simplx.localhost",
					Upstream: "https://core-test.sadmin.app",
					Status:   "remote",
				},
			},
		},
		{
			Project:      "toolapp",
			Branch:       "",
			Slug:         "toolapp",
			DomainSuffix: "toolapp.localhost",
			Services: []ServiceState{
				{
					Service:     "app",
					Mode:        "local",
					Domain:      "toolapp-app.toolapp.localhost",
					URL:         "http://toolapp-app.toolapp.localhost",
					Port:        61000,
					PID:         9999,
					SessionName: "dev-toolapp-app",
					Status:      "running",
					LogPath:     "/logs/dev-toolapp-app.log",
				},
			},
		},
	}
}

// TestRenderStatus_GroupingHeaders verifies instances are grouped under
// "▾ <Project> / <Branch>" headers (worktree layout) or "▾ <Project>" alone
// (single layout / empty branch), per FR-029.
func TestRenderStatus_GroupingHeaders(t *testing.T) {
	live := func(sessionName string) bool { return true }
	out := RenderStatus(fixtureInstances(), live)

	if !containsLine(out, "▾ simplx / orders-refactor") {
		t.Errorf("missing worktree-layout header, got:\n%s", out)
	}
	if !containsLine(out, "▾ toolapp") {
		t.Errorf("missing single-layout header, got:\n%s", out)
	}
}

// TestRenderStatus_LocalRowShowsPortPidStatus verifies a local service row
// includes port, pid, and status (FR-029).
func TestRenderStatus_LocalRowShowsPortPidStatus(t *testing.T) {
	live := func(sessionName string) bool { return true }
	out := RenderStatus(fixtureInstances(), live)

	mustContain(t, out, ":53412")
	mustContain(t, out, "pid 4123")
	mustContain(t, out, "running")
	mustContain(t, out, "http://orders-refactor-front.simplx.localhost")
	mustContain(t, out, "/logs/dev-orders-refactor-front.log")
}

// TestRenderStatus_RemoteRowShowsProxyAndUpstream verifies remote services
// render as proxy rows distinguishable from local rows and showing the
// upstream target (FR-030).
func TestRenderStatus_RemoteRowShowsProxyAndUpstream(t *testing.T) {
	live := func(sessionName string) bool { return true }
	out := RenderStatus(fixtureInstances(), live)

	mustContain(t, out, "remote")
	mustContain(t, out, "proxy")
	mustContain(t, out, "http://orders-refactor-core.simplx.localhost")
	mustContain(t, out, "→ https://core-test.sadmin.app")
}

// TestRenderStatus_DeadPidReconciledToStopped verifies that a service the
// registry marks "running" but whose session the liveness closure reports
// dead is rendered as stopped/error, not running (data-model.md liveness
// reconciliation).
func TestRenderStatus_DeadPidReconciledToStopped(t *testing.T) {
	live := func(sessionName string) bool {
		// Report the toolapp session as dead; front stays alive.
		return sessionName != "dev-toolapp-app"
	}
	out := RenderStatus(fixtureInstances(), live)

	toolappSection := sectionFor(out, "▾ toolapp")
	if containsLine(toolappSection, "toolapp") && strings.Contains(toolappSection, "running") {
		t.Errorf("expected toolapp service to be reconciled away from running, got:\n%s", toolappSection)
	}
	if !stringsContainsAny(toolappSection, []string{"stopped", "error"}) {
		t.Errorf("expected toolapp service reconciled to stopped/error, got:\n%s", toolappSection)
	}

	// front (still alive) must remain "running".
	frontSection := sectionFor(out, "▾ simplx / orders-refactor")
	mustContain(t, frontSection, "running")
}

// TestRenderStatus_InstanceFilterNarrows verifies that when only one
// instance is passed (as Status() does after applying instanceFilter), only
// that instance's services are rendered (FR-031).
func TestRenderStatus_InstanceFilterNarrows(t *testing.T) {
	live := func(sessionName string) bool { return true }
	all := fixtureInstances()

	var only []Instance
	for _, inst := range all {
		if inst.Slug == "toolapp" {
			only = append(only, inst)
		}
	}

	out := RenderStatus(only, live)
	if containsLine(out, "▾ simplx / orders-refactor") {
		t.Errorf("filtered output should not contain the other instance, got:\n%s", out)
	}
	mustContain(t, out, "▾ toolapp")
}

// TestRenderStatus_EmptyInstances verifies an empty instance slice renders
// without panicking and without any group header.
func TestRenderStatus_EmptyInstances(t *testing.T) {
	live := func(sessionName string) bool { return true }
	out := RenderStatus(nil, live)
	if containsLine(out, "▾") {
		t.Errorf("expected no group headers for empty instances, got:\n%s", out)
	}
}

// --- test helpers ---

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected output to contain %q, got:\n%s", needle, haystack)
	}
}

func stringsContainsAny(haystack string, needles []string) bool {
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}

// containsLine reports whether out contains want as a substring — used
// loosely for header checks.
func containsLine(out, want string) bool {
	return strings.Contains(out, want)
}

// sectionFor returns the substring of out starting at the given header line
// through the next header line (or end of string), for scoped assertions.
func sectionFor(out, header string) string {
	start := strings.Index(out, header)
	if start < 0 {
		return ""
	}
	rest := out[start+len(header):]
	// find the next "▾ " after this header
	nextIdx := strings.Index(rest, "▾ ")
	if nextIdx < 0 {
		return out[start:]
	}
	return out[start : start+len(header)+nextIdx]
}
