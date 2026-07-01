package orchestrator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/kimaguri/simplx-toolkit/internal/config"
)

// instancePath returns the on-disk path for the instance registry file of
// the given slug: <InstancesDir()>/<slug>.json.
func instancePath(slug string) string {
	return filepath.Join(config.InstancesDir(), slug+".json")
}

// WriteInstance persists inst to the registry. If a registry file already
// exists for inst.Slug, the write is an idempotent merge: any existing
// service already in "running" status is kept as-is, and any service present
// in inst but missing from the existing file is added — existing running
// services are never clobbered by a stale/incoming write.
func WriteInstance(inst Instance) error {
	dir := config.InstancesDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	existing, err := ReadInstance(inst.Slug)
	if err == nil && existing != nil {
		inst = mergeInstance(*existing, inst)
	}

	data, err := json.MarshalIndent(inst, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(instancePath(inst.Slug), data, 0o644)
}

// mergeInstance merges incoming into existing: existing services already
// "running" are kept unchanged; services present in incoming but missing
// from existing are appended.
func mergeInstance(existing, incoming Instance) Instance {
	merged := incoming
	byService := make(map[string]int, len(merged.Services))
	for i, svc := range merged.Services {
		byService[svc.Service] = i
	}

	result := make([]ServiceState, len(merged.Services))
	copy(result, merged.Services)

	for _, existingSvc := range existing.Services {
		if existingSvc.Status != "running" {
			continue
		}
		if i, ok := byService[existingSvc.Service]; ok {
			result[i] = existingSvc
		} else {
			result = append(result, existingSvc)
		}
	}

	merged.Services = result
	return merged
}

// ReadInstance loads a single instance by slug from the registry.
func ReadInstance(slug string) (*Instance, error) {
	data, err := os.ReadFile(instancePath(slug))
	if err != nil {
		return nil, err
	}

	var inst Instance
	if err := json.Unmarshal(data, &inst); err != nil {
		return nil, err
	}

	return &inst, nil
}

// ListInstances reads every *.json file in the instances registry directory
// and returns the parsed instances.
func ListInstances() ([]Instance, error) {
	dir := config.InstancesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Instance{}, nil
		}
		return nil, err
	}

	instances := make([]Instance, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		slug := strings.TrimSuffix(entry.Name(), ".json")
		inst, err := ReadInstance(slug)
		if err != nil {
			return nil, err
		}
		instances = append(instances, *inst)
	}

	return instances, nil
}

// DeleteInstance removes the registry file for slug.
func DeleteInstance(slug string) error {
	return os.Remove(instancePath(slug))
}
