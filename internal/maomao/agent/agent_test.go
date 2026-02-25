package agent

import (
	"testing"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/config"
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
	got := BuildCommand(conf, "fix helpd-58: test task", false)
	want := `claude --dangerously-skip-permissions "fix helpd-58: test task"`
	if got != want {
		t.Errorf("BuildCommand = %q, want %q", got, want)
	}
}

func TestBuildCommandNoArgs(t *testing.T) {
	conf := config.AgentConf{
		Command: "claude",
	}
	got := BuildCommand(conf, "fix/HELPD-58/auth", false)
	want := `claude "fix/HELPD-58/auth"`
	if got != want {
		t.Errorf("BuildCommand = %q, want %q", got, want)
	}
}

func TestBuildCommandResume(t *testing.T) {
	conf := config.AgentConf{
		Command:    "claude",
		Args:       []string{"--dangerously-skip-permissions"},
		ResumeFlag: "--resume",
	}
	got := BuildCommand(conf, "fix helpd-58: test task", true)
	want := `claude --dangerously-skip-permissions --resume "fix helpd-58: test task"`
	if got != want {
		t.Errorf("BuildCommand with resume = %q, want %q", got, want)
	}
}

func TestBuildCommandResumeNoFlag(t *testing.T) {
	conf := config.AgentConf{
		Command: "claude",
		Args:    []string{"--dangerously-skip-permissions"},
	}
	// resume=true but ResumeFlag is empty — should not add anything
	got := BuildCommand(conf, "fix helpd-58: test task", true)
	want := `claude --dangerously-skip-permissions "fix helpd-58: test task"`
	if got != want {
		t.Errorf("BuildCommand resume with empty flag = %q, want %q", got, want)
	}
}
