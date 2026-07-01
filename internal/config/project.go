package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// ErrNotOrchestratable is returned when no project config can be resolved
// for a given project name / repo paths combination.
var ErrNotOrchestratable = errors.New("project not orchestratable")

// ServiceConfig describes a single service within a ProjectConfig.
type ServiceConfig struct {
	Repo    string `json:"repo,omitempty"`
	Package string `json:"package,omitempty"`
	Script  string `json:"script,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Remote  string `json:"remote,omitempty"`
}

// ProjectConfig is a declarative description of an orchestratable project.
// Loaded from repo-root dev.config.json (wins) or central
// ~/.config/devdash/projects/<name>.json.
type ProjectConfig struct {
	Name         string                   `json:"name"`
	DomainSuffix string                   `json:"domainSuffix"`
	Layout       string                   `json:"layout"`
	Repos        map[string]string        `json:"repos,omitempty"`
	Services     map[string]ServiceConfig `json:"services,omitempty"`
	Env          map[string]string        `json:"env,omitempty"`
}

// LoadProjectConfigFile reads and parses a ProjectConfig from the given path.
func LoadProjectConfigFile(path string) (*ProjectConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// ResolveProjectConfig resolves the ProjectConfig for a project name given a
// list of candidate repo root paths. Resolution order:
//  1. For each repoPath, if <repoPath>/dev.config.json exists, parse and
//     return it (repo-root wins).
//  2. Else if <ProjectsDir()>/<name>.json exists, parse and return it.
//  3. Else return nil, ErrNotOrchestratable.
func ResolveProjectConfig(name string, repoPaths []string) (*ProjectConfig, error) {
	for _, repoPath := range repoPaths {
		candidate := filepath.Join(repoPath, "dev.config.json")
		if _, err := os.Stat(candidate); err == nil {
			return LoadProjectConfigFile(candidate)
		}
	}

	central := filepath.Join(ProjectsDir(), name+".json")
	if _, err := os.Stat(central); err == nil {
		return LoadProjectConfigFile(central)
	}

	return nil, ErrNotOrchestratable
}
