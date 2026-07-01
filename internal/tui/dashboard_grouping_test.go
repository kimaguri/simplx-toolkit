package tui

import (
	"strings"
	"testing"

	"github.com/kimaguri/simplx-toolkit/internal/devdash"
)

// TestSessionInstanceReturnsTaggedValue proves the FR-032 grouping seam:
// once a devdash.SessionInfo carries Instance/Service (as written by
// `devdash up` via internal/process, then loaded back through
// devdash.LoadAllSessions from the same config.SessionsDir()),
// sessionInstance/sessionService must surface those real values instead of
// always returning "" (T044).
func TestSessionInstanceReturnsTaggedValue(t *testing.T) {
	rp := &devdash.RunningProcess{
		Info: devdash.SessionInfo{
			Name:     "dev-orders-refactor-front",
			Instance: "orders-refactor",
			Service:  "front",
		},
	}

	if got := sessionInstance(rp); got != "orders-refactor" {
		t.Errorf("sessionInstance() = %q, want %q", got, "orders-refactor")
	}
	if got := sessionService(rp); got != "front" {
		t.Errorf("sessionService() = %q, want %q", got, "front")
	}
}

// TestSessionInstanceEmptyForUntaggedSession proves legacy/ungrouped
// sessions (no Instance set — e.g. sessions started before the orchestrator
// tagged them, or launched outside `devdash up`) still fall back to "",
// preserving the "(ungrouped)" header (backward compatibility).
func TestSessionInstanceEmptyForUntaggedSession(t *testing.T) {
	rp := &devdash.RunningProcess{
		Info: devdash.SessionInfo{Name: "dev-plain"},
	}

	if got := sessionInstance(rp); got != "" {
		t.Errorf("sessionInstance() = %q, want empty", got)
	}
	if got := sessionService(rp); got != "" {
		t.Errorf("sessionService() = %q, want empty", got)
	}
}

// TestSessionInstanceNilProcess proves the accessors are nil-safe.
func TestSessionInstanceNilProcess(t *testing.T) {
	if got := sessionInstance(nil); got != "" {
		t.Errorf("sessionInstance(nil) = %q, want empty", got)
	}
	if got := sessionService(nil); got != "" {
		t.Errorf("sessionService(nil) = %q, want empty", got)
	}
}

// TestGroupHeaderForUsesInstanceSlug proves groupHeaderFor renders the real
// instance slug as the header instead of the ungrouped fallback when
// Instance is set.
func TestGroupHeaderForUsesInstanceSlug(t *testing.T) {
	tagged := &devdash.RunningProcess{
		Info: devdash.SessionInfo{Name: "dev-orders-refactor-front", Instance: "orders-refactor"},
	}
	untagged := &devdash.RunningProcess{
		Info: devdash.SessionInfo{Name: "dev-plain"},
	}

	if got := groupHeaderFor(tagged); got != "orders-refactor" {
		t.Errorf("groupHeaderFor(tagged) = %q, want %q", got, "orders-refactor")
	}
	if got := groupHeaderFor(untagged); got != ungroupedHeader {
		t.Errorf("groupHeaderFor(untagged) = %q, want %q", got, ungroupedHeader)
	}
}

// TestRenderSessionListGroupsByInstanceHeader is an end-to-end render test:
// a dashboardModel holding one instance-tagged session and one untagged
// session must render the tagged session under its instance-slug header
// (NOT "(ungrouped)"), proving the TUI's grouping (FR-032) is no longer
// inert.
func TestRenderSessionListGroupsByInstanceHeader(t *testing.T) {
	m := newDashboardModel()
	tagged := &devdash.RunningProcess{
		Info:   devdash.SessionInfo{Name: "dev-orders-refactor-front", Instance: "orders-refactor", Service: "front"},
		Status: devdash.StatusRunning,
	}
	untagged := &devdash.RunningProcess{
		Info:   devdash.SessionInfo{Name: "dev-plain"},
		Status: devdash.StatusRunning,
	}
	m.SetProcesses([]*devdash.RunningProcess{tagged, untagged})

	out := m.renderSessionList(80, 20)

	if !strings.Contains(out, "orders-refactor") {
		t.Errorf("renderSessionList output missing instance header %q:\n%s", "orders-refactor", out)
	}
	if !strings.Contains(out, ungroupedHeader) {
		t.Errorf("renderSessionList output missing ungrouped fallback header for untagged session:\n%s", out)
	}
}
