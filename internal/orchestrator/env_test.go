package orchestrator

import "testing"

func fixtureInstance() Instance {
	return Instance{
		Project:      "simplx",
		Branch:       "orders-refactor",
		Slug:         "orders-refactor",
		DomainSuffix: "simplx.localhost",
		Services: []ServiceState{
			{Service: "front", Mode: "local"},
			{Service: "core", Mode: "remote", Upstream: "https://core-test.sadmin.app"},
			{Service: "platform", Mode: "remote", Upstream: "https://platform-test.sadmin.app"},
		},
	}
}

func TestResolveEnv_FullURL(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{"VITE_SIMPLX_CORE_URL": "{core}"}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	want := "http://orders-refactor-core.simplx.localhost"
	if got["VITE_SIMPLX_CORE_URL"] != want {
		t.Errorf("got %q, want %q", got["VITE_SIMPLX_CORE_URL"], want)
	}
}

func TestResolveEnv_KeepsPathSuffix(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{"VITE_API_URL": "{platform}/api/v1"}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	want := "http://orders-refactor-platform.simplx.localhost/api/v1"
	if got["VITE_API_URL"] != want {
		t.Errorf("got %q, want %q", got["VITE_API_URL"], want)
	}
}

func TestResolveEnv_HostOnlyAlternateScheme(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{"VITE_MAINFRAME_URL": "ws://{platform.host}/api/rivet"}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	want := "ws://orders-refactor-platform.simplx.localhost/api/rivet"
	if got["VITE_MAINFRAME_URL"] != want {
		t.Errorf("got %q, want %q", got["VITE_MAINFRAME_URL"], want)
	}
}

func TestResolveEnv_RemoteModeSiblingStillYieldsLocalDomain(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{"VITE_API_URL": "{platform}/api/v1"}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	// platform is remote-mode in the fixture, but resolution must never leak
	// the upstream URL — always the local proxy domain (transparency guarantee).
	if got["VITE_API_URL"] != "http://orders-refactor-platform.simplx.localhost/api/v1" {
		t.Errorf("remote-mode service leaked upstream or wrong domain: got %q", got["VITE_API_URL"])
	}
	for _, svc := range inst.Services {
		if svc.Service == "platform" && svc.Upstream == "" {
			t.Fatalf("fixture invariant broken: platform must be remote with upstream set")
		}
	}
}

func TestResolveEnv_UnknownPlaceholderReturnsError(t *testing.T) {
	inst := fixtureInstance()
	_, err := ResolveEnv(map[string]string{"VITE_NOPE_URL": "{nope}"}, inst)
	if err == nil {
		t.Fatal("expected error for unknown placeholder {nope}, got nil")
	}
}

func TestResolveEnv_EmptyEnvReturnsEmptyMap(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map, got %v", got)
	}
}

func TestResolveEnv_NoPlaceholdersPassesThrough(t *testing.T) {
	inst := fixtureInstance()
	got, err := ResolveEnv(map[string]string{"PLAIN": "no-placeholders-here"}, inst)
	if err != nil {
		t.Fatalf("ResolveEnv() error = %v", err)
	}
	if got["PLAIN"] != "no-placeholders-here" {
		t.Errorf("got %q, want passthrough", got["PLAIN"])
	}
}
