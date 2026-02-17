package config

import "fmt"

// DevCommand returns the command, args, and extra env to run a project's dev server.
// For Encore projects (encore.app detected), uses `encore run --port`.
// For workspace packages (pkgName non-empty), uses `{pm} --filter <name> run {script}`.
// For standalone projects, uses `{pm} run {script}` with PORT env variable.
func DevCommand(isEncore bool, port int, pmBinary string, pkgName string, script string) (cmd string, args []string, env []string) {
	portStr := fmt.Sprintf("%d", port)

	if isEncore {
		return "encore", []string{"run", "--port", portStr}, nil
	}

	if script == "" {
		script = "dev"
	}

	if pkgName != "" {
		return pmBinary, []string{"--filter", pkgName, "run", script}, []string{fmt.Sprintf("PORT=%s", portStr)}
	}

	return pmBinary, []string{"run", script}, []string{fmt.Sprintf("PORT=%s", portStr)}
}

// SessionName generates a session name from worktree and project names
func SessionName(wtName, projectName string) string {
	return "dev-" + sanitize(wtName) + "-" + sanitize(projectName)
}

// sanitize replaces path separators and spaces for use in session names
func sanitize(s string) string {
	result := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '/' || c == '\\' || c == ' ' {
			result[i] = '-'
		} else {
			result[i] = c
		}
	}
	return string(result)
}
