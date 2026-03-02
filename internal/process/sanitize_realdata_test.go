package process

import (
	"os"
	"strings"
	"testing"
)

// TestSanitize_RealClaudeCodeLog runs the sanitizer on an actual Claude Code
// PTY log file and verifies that spaces are preserved.
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

	// Look for known content from the Claude Code session
	fullText := output

	// Check that "Claude Code" has a space (not "ClaudeCode")
	if strings.Contains(fullText, "ClaudeCode") {
		t.Error("Found 'ClaudeCode' without space — CUF not converted")
	}
	if !strings.Contains(fullText, "Claude Code") {
		t.Error("'Claude Code' not found in sanitized output")
	}

	// Check "Welcome back" has spaces
	if strings.Contains(fullText, "Welcomeback") {
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
