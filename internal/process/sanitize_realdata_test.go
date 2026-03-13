package process

import (
	"os"
	"strings"
	"testing"
)

// TestSanitize_RealClaudeCodeLog runs the sanitizer on an actual Claude Code
// PTY log file and verifies basic output quality.
// Note: cursor-up handling truncates overwritten content, so the output
// represents the final screen state, not the full session history.
func TestSanitize_RealClaudeCodeLog(t *testing.T) {
	logPath := os.ExpandEnv("${HOME}/.config/maomao/logs/toolkit:simplx-toolkit.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Skipf("no real log file found: %v", err)
	}

	t.Logf("raw log size: %d bytes", len(data))

	sanitized := sanitizeForLog(data)
	output := string(sanitized)
	lines := strings.Split(output, "\n")

	t.Logf("sanitized output: %d lines", len(lines))

	// Check that CUF still produces spaces (no "ClaudeCode" without space)
	if strings.Contains(output, "ClaudeCode") {
		t.Error("Found 'ClaudeCode' without space — CUF not converted")
	}
	if strings.Contains(output, "Welcomeback") {
		t.Error("Found 'Welcomeback' without space")
	}

	// Print first 30 non-empty lines for inspection
	printed := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > 0 && printed < 30 {
			t.Logf("  %q", trimmed)
			printed++
		}
	}
}
