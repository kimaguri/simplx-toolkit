package orchestrator

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/kimaguri/simplx-toolkit/internal/process"
	"github.com/kimaguri/simplx-toolkit/internal/proxy"
)

// Down tears down the instance identified by slug: it stops every local
// service's process (via pm.Stop), removes the instance's Caddy routes
// (proxyClient.RemoveRoutesByInstance), and deletes the registry entry.
// Remote upstreams, the shared Caddy daemon, and other instances are left
// untouched.
//
// If no registry entry exists for slug, Down is a non-destructive no-op:
// it returns (false, nil) so callers can report "instance <slug> not
// running" and exit 0, per contracts/cli.md.
func Down(slug string, proxyClient proxy.ProxyClient, pm *process.ProcessManager) (bool, error) {
	inst, err := ReadInstance(slug)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("reading instance %q: %w", slug, err)
	}

	var stopErrs []error
	for _, svc := range inst.Services {
		if svc.Mode == "remote" || svc.SessionName == "" {
			continue
		}
		if err := pm.Stop(svc.SessionName); err != nil {
			// "process not found" means it's already stopped (e.g. exited on
			// its own, or devdash restarted since); that's non-fatal for a
			// teardown request. Collect any other, real error.
			if !strings.Contains(err.Error(), "not found") {
				stopErrs = append(stopErrs, fmt.Errorf("stopping service %q (%s): %w", svc.Service, svc.SessionName, err))
			}
		}
	}
	if len(stopErrs) > 0 {
		return true, errors.Join(stopErrs...)
	}

	if err := proxyClient.RemoveRoutesByInstance(slug); err != nil {
		return true, fmt.Errorf("removing routes for instance %q: %w", slug, err)
	}

	if err := DeleteInstance(slug); err != nil {
		return true, fmt.Errorf("deleting instance registry for %q: %w", slug, err)
	}

	return true, nil
}
