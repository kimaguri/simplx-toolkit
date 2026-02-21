package agent

import (
	"testing"

	"github.com/kimaguri/simplx-toolkit/internal/mxd/config"
)

func TestDetectAvailable(t *testing.T) {
	// "which echo" should succeed on any unix
	conf := config.AgentConf{
		Name:    "test-agent",
		Command: "echo",
		Detect:  "which echo",
	}
	if !Detect(conf) {
		t.Error("Detect returned false for 'which echo'")
	}
}

func TestDetectUnavailable(t *testing.T) {
	conf := config.AgentConf{
		Name:    "fake",
		Command: "nonexistent-binary-xyz",
		Detect:  "which nonexistent-binary-xyz",
	}
	if Detect(conf) {
		t.Error("Detect returned true for nonexistent binary")
	}
}

func TestAvailable(t *testing.T) {
	cfg := &config.GlobalConfig{
		Agents: map[string]config.AgentConf{
			"real": {Name: "real", Command: "echo", Detect: "which echo"},
			"fake": {Name: "fake", Command: "nope", Detect: "which nonexistent-xyz"},
		},
	}
	available := Available(cfg)
	found := false
	for _, a := range available {
		if a.Name == "real" {
			found = true
		}
		if a.Name == "fake" {
			t.Error("fake agent should not be available")
		}
	}
	if !found {
		t.Error("real agent not found in Available()")
	}
}

func TestBuildCommand(t *testing.T) {
	conf := config.AgentConf{
		Command: "claude",
		Args:    []string{"--dangerously-skip-permissions"},
	}
	got := BuildCommand(conf, "fix helpd-58: test task")
	want := `claude --dangerously-skip-permissions "fix helpd-58: test task"`
	if got != want {
		t.Errorf("BuildCommand = %q, want %q", got, want)
	}
}
