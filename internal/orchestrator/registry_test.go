package orchestrator

import (
	"os"
	"testing"
)

func TestWriteReadInstance_RoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	inst := Instance{
		Project:      "simplx",
		Branch:       "orders-refactor",
		Slug:         "orders-refactor",
		DomainSuffix: "simplx.localhost",
		Services: []ServiceState{
			{Service: "front", Mode: "local", Status: "running", Port: 5173, PID: 1234},
		},
		CreatedAt: 1700000000,
	}

	if err := WriteInstance(inst); err != nil {
		t.Fatalf("WriteInstance() error = %v", err)
	}

	got, err := ReadInstance("orders-refactor")
	if err != nil {
		t.Fatalf("ReadInstance() error = %v", err)
	}

	if got.Project != inst.Project || got.Slug != inst.Slug || got.CreatedAt != inst.CreatedAt {
		t.Errorf("round-tripped instance mismatch: got %+v, want %+v", got, inst)
	}
	if len(got.Services) != 1 || got.Services[0].Service != "front" || got.Services[0].PID != 1234 {
		t.Errorf("round-tripped services mismatch: got %+v", got.Services)
	}
}

func TestWriteInstance_MergeKeepsRunningAndAddsNew(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	first := Instance{
		Slug: "orders-refactor",
		Services: []ServiceState{
			{Service: "front", Status: "running", PID: 111},
		},
	}
	if err := WriteInstance(first); err != nil {
		t.Fatalf("WriteInstance() first error = %v", err)
	}

	// Simulate a second `up` call that recomputes state without knowledge of
	// the already-running "front" service's pid, but adds a new "core" service.
	second := Instance{
		Slug: "orders-refactor",
		Services: []ServiceState{
			{Service: "core", Status: "remote"},
		},
	}
	if err := WriteInstance(second); err != nil {
		t.Fatalf("WriteInstance() second error = %v", err)
	}

	got, err := ReadInstance("orders-refactor")
	if err != nil {
		t.Fatalf("ReadInstance() error = %v", err)
	}

	byService := make(map[string]ServiceState, len(got.Services))
	for _, s := range got.Services {
		byService[s.Service] = s
	}

	front, ok := byService["front"]
	if !ok {
		t.Fatalf("expected merged instance to keep running 'front' service, got %+v", got.Services)
	}
	if front.PID != 111 || front.Status != "running" {
		t.Errorf("expected 'front' to be preserved unchanged, got %+v", front)
	}

	if _, ok := byService["core"]; !ok {
		t.Errorf("expected merged instance to add new 'core' service, got %+v", got.Services)
	}
}

func TestListInstances_ReturnsAll(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if err := WriteInstance(Instance{Slug: "one"}); err != nil {
		t.Fatalf("WriteInstance() error = %v", err)
	}
	if err := WriteInstance(Instance{Slug: "two"}); err != nil {
		t.Fatalf("WriteInstance() error = %v", err)
	}

	instances, err := ListInstances()
	if err != nil {
		t.Fatalf("ListInstances() error = %v", err)
	}
	if len(instances) != 2 {
		t.Fatalf("expected 2 instances, got %d: %+v", len(instances), instances)
	}
}

func TestListInstances_EmptyDirReturnsEmptySlice(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	instances, err := ListInstances()
	if err != nil {
		t.Fatalf("ListInstances() error = %v", err)
	}
	if len(instances) != 0 {
		t.Errorf("expected empty slice, got %+v", instances)
	}
}

func TestDeleteInstance_RemovesFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if err := WriteInstance(Instance{Slug: "orders-refactor"}); err != nil {
		t.Fatalf("WriteInstance() error = %v", err)
	}

	if err := DeleteInstance("orders-refactor"); err != nil {
		t.Fatalf("DeleteInstance() error = %v", err)
	}

	if _, err := ReadInstance("orders-refactor"); !os.IsNotExist(err) {
		t.Errorf("expected instance file to be gone, ReadInstance() error = %v", err)
	}
}
