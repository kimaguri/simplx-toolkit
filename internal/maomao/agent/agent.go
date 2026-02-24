package agent

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/kimaguri/simplx-toolkit/internal/maomao/config"
)

// Detect checks if the agent binary is available on the system
// by running the detect command from config.
func Detect(conf config.AgentConf) bool {
	if conf.Detect == "" {
		return false
	}
	cmd := exec.Command("sh", "-c", conf.Detect)
	return cmd.Run() == nil
}

// Available returns all agents from global config that pass Detect.
func Available(cfg *config.GlobalConfig) []config.AgentConf {
	var result []config.AgentConf
	for _, ac := range cfg.Agents {
		if Detect(ac) {
			result = append(result, ac)
		}
	}
	return result
}

// BuildCommand constructs the full command string to launch an agent with a task prompt.
// The working directory is set via cmd.Dir at the process level, not via CLI flags.
func BuildCommand(conf config.AgentConf, prompt string) string {
	parts := []string{conf.Command}
	parts = append(parts, conf.Args...)
	parts = append(parts, fmt.Sprintf("%q", prompt))
	return strings.Join(parts, " ")
}
