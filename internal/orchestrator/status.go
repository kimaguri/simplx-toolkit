package orchestrator

import (
	"fmt"
	"io"
	"strings"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// Status writes the "devdash status" report to w, per contracts/cli.md and
// FR-029..033: with instanceFilter empty, every registered instance is
// listed, grouped by project/branch; with instanceFilter set, only that
// instance's services are shown. Liveness is reconciled against pm: a
// service the registry marks "running" whose session pm reports dead is
// rendered as stopped, not running.
func Status(w io.Writer, instanceFilter string, pm *process.ProcessManager) error {
	var instances []Instance

	if instanceFilter != "" {
		inst, err := ReadInstance(instanceFilter)
		if err != nil {
			return fmt.Errorf("instance %s not found", instanceFilter)
		}
		instances = []Instance{*inst}
	} else {
		all, err := ListInstances()
		if err != nil {
			return fmt.Errorf("listing instances: %w", err)
		}
		instances = all
	}

	live := func(sessionName string) bool {
		rp := pm.Get(sessionName)
		return rp != nil && rp.Status == process.StatusRunning
	}

	fmt.Fprint(w, RenderStatus(instances, live))
	return nil
}

// RenderStatus is the pure rendering function behind Status: given a set of
// instances and a liveness predicate (keyed by ServiceState.SessionName), it
// produces the full human-readable status report text. Kept free of any
// ProcessManager dependency so it is unit-testable with a fake liveness
// closure (FR-029..031).
func RenderStatus(instances []Instance, live func(sessionName string) bool) string {
	var b strings.Builder

	for _, inst := range instances {
		writeInstanceHeader(&b, inst)
		for _, svc := range inst.Services {
			writeServiceRow(&b, svc, live)
		}
	}

	return b.String()
}

// writeInstanceHeader writes "▾ <Project> / <Branch>" for worktree-layout
// instances (non-empty branch) or "▾ <Project>" alone for single-layout
// instances / instances with no branch.
func writeInstanceHeader(b *strings.Builder, inst Instance) {
	if inst.Branch != "" {
		fmt.Fprintf(b, "▾ %s / %s\n", inst.Project, inst.Branch)
	} else {
		fmt.Fprintf(b, "▾ %s\n", inst.Project)
	}
}

// writeServiceRow writes one service's status line: a proxy row for remote
// services (FR-030), or a local row with port/pid/status/log path for local
// services, reconciling "running" against live() (data-model.md liveness
// reconciliation).
func writeServiceRow(b *strings.Builder, svc ServiceState, live func(sessionName string) bool) {
	if svc.Mode == "remote" {
		fmt.Fprintf(b, "    %-9s  remote  proxy             %s → %s\n", svc.Service, svc.URL, svc.Upstream)
		return
	}

	status := reconcileStatus(svc, live)
	fmt.Fprintf(b, "    %-9s  local   %-7s  :%d  pid %d   %s   %s\n",
		svc.Service, status, svc.Port, svc.PID, svc.URL, svc.LogPath)
}

// reconcileStatus returns svc.Status, downgraded from "running" to
// "stopped" if the registry's intent says running but the live process is
// no longer alive per the live() predicate keyed by SessionName.
func reconcileStatus(svc ServiceState, live func(sessionName string) bool) string {
	if svc.Status != "running" {
		return svc.Status
	}
	if svc.SessionName != "" && !live(svc.SessionName) {
		return "stopped"
	}
	return "running"
}
