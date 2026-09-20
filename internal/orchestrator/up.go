package orchestrator

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/config"
	"github.com/kimaguri/simplx-toolkit/internal/process"
	"github.com/kimaguri/simplx-toolkit/internal/proxy"
)

// UpOptions carries the parsed arguments of `devdash up`.
type UpOptions struct {
	Project   string
	Branch    string
	Local     []string
	Remote    []string
	RepoPaths []string
}

// Up brings up an instance for opts.Project/opts.Branch: it resolves the
// project config, resolves each service's mode (applying --local/--remote
// overrides), locates worktrees, allocates ports, spawns local dev
// processes, registers proxy routes, and persists the instance to the
// registry. It is idempotent: services already running (per pm) are left
// untouched and reported as-is.
func Up(opts UpOptions, proxyClient proxy.ProxyClient, pm *process.ProcessManager) (*Instance, error) {
	cfg, err := config.ResolveProjectConfig(opts.Project, opts.RepoPaths)
	if err != nil {
		return nil, fmt.Errorf("resolving project config for %q: %w", opts.Project, err)
	}

	resolved, warnings := ResolveModes(cfg, opts.Local, opts.Remote)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}

	slug := Slug(opts.Project, opts.Branch, cfg.Layout)
	inst := Instance{
		Project:      opts.Project,
		Branch:       opts.Branch,
		Slug:         slug,
		DomainSuffix: cfg.DomainSuffix,
		CreatedAt:    time.Now().Unix(),
	}

	prior, _ := ReadInstance(slug)

	// First pass: compute each service's domain/URL and whether it's
	// actionable (remote, or local with a resolvable worktree). Domains only
	// depend on slug+service+suffix, so they can be computed before port
	// allocation, which ResolveEnv needs.
	type planned struct {
		resolved     ResolvedService
		worktreePath string
		skip         bool
	}

	plans := make([]planned, 0, len(resolved))
	services := make([]ServiceState, 0, len(resolved))

	for _, rs := range resolved {
		domain := Domain(slug, rs.Service, cfg.DomainSuffix)
		state := ServiceState{
			Service: rs.Service,
			Mode:    rs.Mode,
			Domain:  domain,
			URL:     "https://" + domain,
		}

		p := planned{resolved: rs}

		if rs.Mode == "remote" {
			state.Upstream = rs.Cfg.Remote
			state.Status = "remote"
			services = append(services, state)
			plans = append(plans, p)
			continue
		}

		// local mode
		repoPath := cfg.Repos[rs.Cfg.Repo]
		wt, ok := FindWorktree(repoPath, opts.Branch)
		if !ok {
			fmt.Fprintf(os.Stderr, "warning: skipping service %q: no worktree found for branch %q in repo %q\n", rs.Service, opts.Branch, rs.Cfg.Repo)
			continue
		}
		p.worktreePath = wt
		state.WorktreePath = wt
		services = append(services, state)
		plans = append(plans, p)
	}

	inst.Services = services

	if len(services) == 0 {
		return nil, fmt.Errorf("nothing to launch for instance %s", slug)
	}

	env, err := ResolveEnv(cfg.Env, inst)
	if err != nil {
		return nil, fmt.Errorf("resolving env for instance %s: %w", slug, err)
	}
	envSlice := envMapToSlice(env)

	for i := range inst.Services {
		svc := &inst.Services[i]
		if svc.Status == "remote" {
			continue
		}

		p := plans[i]
		sessionName := "dev-" + slug + "-" + svc.Service

		if existing := pm.Get(sessionName); existing != nil {
			// Already running: keep as-is, don't respawn.
			svc.Status = "running"
			svc.SessionName = sessionName
			svc.PID = existing.Info.PID
			svc.Port = existing.Info.Port
			svc.WorktreePath = p.worktreePath
			svc.LogPath = filepath.Join(config.LogsDir(), sessionName+".log")
			continue
		}

		if prior != nil {
			if priorSvc := findServiceState(prior.Services, svc.Service); priorSvc != nil && priorSvc.Status == "running" {
				if rp := pm.Get(priorSvc.SessionName); rp != nil {
					svc.Status = "running"
					svc.SessionName = priorSvc.SessionName
					svc.PID = rp.Info.PID
					svc.Port = rp.Info.Port
					svc.WorktreePath = p.worktreePath
					svc.LogPath = filepath.Join(config.LogsDir(), sessionName+".log")
					continue
				}
			}
		}

		port, err := AllocFreePort()
		if err != nil {
			return nil, fmt.Errorf("allocating port for service %s: %w", svc.Service, err)
		}

		cmd, args, cmdEnv := config.DevCommand(false, port, pm.PnpmPath(), p.resolved.Cfg.Package, p.resolved.Cfg.Script)

		info := process.SessionInfo{
			Name:     sessionName,
			Port:     port,
			Command:  cmd,
			Args:     args,
			ExtraEnv: append(append([]string{}, envSlice...), cmdEnv...),
			WorkDir:  p.worktreePath,
			Project:  opts.Project,
			WtName:   opts.Branch,
			WtPath:   p.worktreePath,
			Instance: slug,
			Service:  svc.Service,
		}

		rp, err := pm.Start(info)
		if err != nil {
			return nil, fmt.Errorf("starting service %s: %w", svc.Service, err)
		}

		svc.Status = "running"
		svc.SessionName = sessionName
		svc.Port = port
		svc.PID = rp.Info.PID
		svc.WorktreePath = p.worktreePath
		svc.LogPath = filepath.Join(config.LogsDir(), sessionName+".log")
	}

	if err := proxyClient.EnsureRunning(); err != nil {
		return nil, fmt.Errorf("ensuring proxy is running: %w", err)
	}

	for _, svc := range inst.Services {
		var route proxy.Route
		if svc.Status == "remote" {
			route = proxy.BuildRoute(slug, svc.Service, cfg.DomainSuffix, 0, svc.Upstream)
		} else {
			route = proxy.BuildRoute(slug, svc.Service, cfg.DomainSuffix, svc.Port, "")
		}
		if err := proxyClient.AddRoute(route); err != nil {
			return nil, fmt.Errorf("adding route for service %s: %w", svc.Service, err)
		}
	}

	if err := WriteInstance(inst); err != nil {
		return nil, fmt.Errorf("writing instance registry for %s: %w", slug, err)
	}

	return &inst, nil
}

// findServiceState returns a pointer to the ServiceState named service in
// states, or nil if absent.
func findServiceState(states []ServiceState, service string) *ServiceState {
	for i := range states {
		if states[i].Service == service {
			return &states[i]
		}
	}
	return nil
}

// envMapToSlice renders a resolved env map as "NAME=value" entries suitable
// for process.SessionInfo.ExtraEnv, in a stable (sorted) order.
func envMapToSlice(env map[string]string) []string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]string, 0, len(env))
	for _, name := range names {
		out = append(out, name+"="+env[name])
	}
	return out
}

// PrintUpResult renders the result of a successful Up() call to w, per
// contracts/cli.md: a header line, one line per service, and a footer with
// example follow-up commands.
func PrintUpResult(w io.Writer, inst *Instance) {
	fmt.Fprintf(w, "instance %s/%s (slug %s)\n", inst.Project, inst.Branch, inst.Slug)
	for _, svc := range inst.Services {
		if svc.Status == "remote" {
			fmt.Fprintf(w, "  %-9s %-7s %-45s  → %s\n", svc.Service, svc.Mode, svc.URL, svc.Upstream)
		} else {
			fmt.Fprintf(w, "  %-9s %-7s %-45s  %s\n", svc.Service, svc.Mode, svc.URL, svc.LogPath)
		}
	}
	fmt.Fprintf(w, "logs:   devdash logs %s [service] [--tail N]\n", inst.Slug)
	fmt.Fprintf(w, "status: devdash status %s\n", inst.Slug)
}
