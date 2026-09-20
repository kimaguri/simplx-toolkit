package orchestrator

import (
	"fmt"
	"strings"
)

// ResolveEnv resolves `{svc}` and `{svc.host}` placeholder templates against
// the services present in inst, always producing the LOCAL proxy domain for
// every service — including services running in remote mode — so that
// sibling services are transparently reachable via the same local proxy
// regardless of where they actually execute. Returns an error if a template
// references a service not present in inst.Services.
func ResolveEnv(env map[string]string, inst Instance) (map[string]string, error) {
	hostByService := make(map[string]string, len(inst.Services))
	for _, svc := range inst.Services {
		hostByService[svc.Service] = Domain(inst.Slug, svc.Service, inst.DomainSuffix)
	}

	resolved := make(map[string]string, len(env))
	for name, template := range env {
		value, err := resolveTemplate(template, hostByService)
		if err != nil {
			return nil, fmt.Errorf("env %s: %w", name, err)
		}
		resolved[name] = value
	}

	return resolved, nil
}

// resolveTemplate replaces every `{svc}` and `{svc.host}` placeholder in
// template using hostByService, the resolved local proxy host per service.
func resolveTemplate(template string, hostByService map[string]string) (string, error) {
	var b strings.Builder
	i := 0
	for i < len(template) {
		if template[i] != '{' {
			b.WriteByte(template[i])
			i++
			continue
		}

		end := strings.IndexByte(template[i:], '}')
		if end == -1 {
			return "", fmt.Errorf("unterminated placeholder in template %q", template)
		}
		end += i

		placeholder := template[i+1 : end]
		svc, isHost := strings.CutSuffix(placeholder, ".host")

		host, ok := hostByService[svc]
		if !ok {
			return "", fmt.Errorf("unknown service %q in placeholder {%s}", svc, placeholder)
		}

		if isHost {
			b.WriteString(host)
		} else {
			b.WriteString("https://" + host)
		}

		i = end + 1
	}

	return b.String(), nil
}
