package orchestrator

import "strings"

// ServiceState is a per-service runtime record inside an Instance.
type ServiceState struct {
	Service      string `json:"service"`
	Mode         string `json:"mode"`
	Domain       string `json:"domain"`
	URL          string `json:"url"`
	Port         int    `json:"port"`
	PID          int    `json:"pid"`
	SessionName  string `json:"sessionName"`
	WorktreePath string `json:"worktreePath"`
	Upstream     string `json:"upstream"`
	Status       string `json:"status"`
	LogPath      string `json:"logPath"`
}

// Instance is a concrete runnable unit derived at `up` time and persisted in
// the registry.
type Instance struct {
	Project      string         `json:"project"`
	Branch       string         `json:"branch"`
	Slug         string         `json:"slug"`
	DomainSuffix string         `json:"domainSuffix"`
	Services     []ServiceState `json:"services"`
	CreatedAt    int64          `json:"createdAt"`
}

// Slug derives the instance id from project/branch per the project layout.
// For layout "single" the slug is derived from the project name; otherwise
// (layout "worktree") it is derived from the branch name.
func Slug(project, branch, layout string) string {
	if layout == "single" {
		return sanitize(project)
	}
	return sanitize(branch)
}

// Domain builds the local proxy domain for a service within an instance.
func Domain(slug, service, suffix string) string {
	return slug + "-" + service + "." + suffix
}

// sanitize lowercases s, replaces '/' and '_' with '-', drops any character
// not in [a-z0-9-], collapses repeated '-', and trims leading/trailing '-'.
func sanitize(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, "_", "-")

	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	cleaned := b.String()

	var collapsed strings.Builder
	prevDash := false
	for _, r := range cleaned {
		if r == '-' {
			if prevDash {
				continue
			}
			prevDash = true
		} else {
			prevDash = false
		}
		collapsed.WriteRune(r)
	}

	return strings.Trim(collapsed.String(), "-")
}
