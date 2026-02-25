package process

import (
	"strings"
	"testing"
)

func TestSanitize_CursorForwardToSpaces(t *testing.T) {
	// ESC[1C = cursor forward 1 = should become 1 space
	input := []byte("Hello\x1b[1CWorld")
	got := string(sanitizeForLog(input))
	if got != "Hello World" {
		t.Errorf("CUF 1: got %q, want %q", got, "Hello World")
	}
}

func TestSanitize_CursorForwardMultiple(t *testing.T) {
	// ESC[3C = cursor forward 3 = should become 3 spaces
	input := []byte("A\x1b[3CB")
	got := string(sanitizeForLog(input))
	if got != "A   B" {
		t.Errorf("CUF 3: got %q, want %q", got, "A   B")
	}
}

func TestSanitize_CursorForwardDefault(t *testing.T) {
	// ESC[C = cursor forward with no param = default 1
	input := []byte("X\x1b[CY")
	got := string(sanitizeForLog(input))
	if got != "X Y" {
		t.Errorf("CUF default: got %q, want %q", got, "X Y")
	}
}

func TestSanitize_ClaudeCodeStyle(t *testing.T) {
	// Real Claude Code output: words separated by ESC[1C
	input := []byte("Claude\x1b[1CCode\x1b[1Cv2.1.52")
	got := string(sanitizeForLog(input))
	if got != "Claude Code v2.1.52" {
		t.Errorf("Claude Code style: got %q, want %q", got, "Claude Code v2.1.52")
	}
}

func TestSanitize_MixedSGRAndCUF(t *testing.T) {
	// SGR (color) should be kept, CUF should become spaces
	input := []byte("\x1b[1mBold\x1b[0m\x1b[1Cnormal\x1b[1C\x1b[32mgreen\x1b[0m")
	got := string(sanitizeForLog(input))
	if !strings.Contains(got, "Bold") || !strings.Contains(got, "normal") || !strings.Contains(got, "green") {
		t.Errorf("Missing text content: %q", got)
	}
	// Should have SGR codes
	if !strings.Contains(got, "\x1b[1m") {
		t.Errorf("Missing SGR bold: %q", got)
	}
	if !strings.Contains(got, "\x1b[32m") {
		t.Errorf("Missing SGR green: %q", got)
	}
	// Should have spaces (from CUF)
	if !strings.Contains(got, "Bold\x1b[0m normal") && !strings.Contains(got, "normal \x1b[32m") {
		t.Logf("output: %q", got)
	}
}

func TestSanitize_CursorPositionStripped(t *testing.T) {
	// Cursor positioning (H) should be stripped, not converted to spaces
	input := []byte("\x1b[5;10Hhello world")
	got := string(sanitizeForLog(input))
	if got != "hello world" {
		t.Errorf("CUP: got %q, want %q", got, "hello world")
	}
}

func TestSanitize_ClearScreenStripped(t *testing.T) {
	input := []byte("before\x1b[2Jafter")
	got := string(sanitizeForLog(input))
	if got != "beforeafter" {
		t.Errorf("Clear screen: got %q, want %q", got, "beforeafter")
	}
}

func TestSanitize_SGRPreserved(t *testing.T) {
	input := []byte("\x1b[38;2;215;119;87mcolored text\x1b[39m")
	got := string(sanitizeForLog(input))
	if got != "\x1b[38;2;215;119;87mcolored text\x1b[39m" {
		t.Errorf("SGR: got %q", got)
	}
}

func TestSanitize_CRLF(t *testing.T) {
	input := []byte("line1\r\nline2\r\nline3")
	got := string(sanitizeForLog(input))
	if got != "line1\nline2\nline3" {
		t.Errorf("CRLF: got %q", got)
	}
}

func TestSanitize_StandaloneCR(t *testing.T) {
	input := []byte("old\rnew")
	got := string(sanitizeForLog(input))
	if got != "old\nnew" {
		t.Errorf("Standalone CR: got %q", got)
	}
}

func TestSanitize_OSCStripped(t *testing.T) {
	// OSC for window title
	input := []byte("before\x1b]0;My Title\x07after")
	got := string(sanitizeForLog(input))
	if got != "beforeafter" {
		t.Errorf("OSC: got %q, want %q", got, "beforeafter")
	}
}

func TestSanitize_RealClaudeCodeWelcome(t *testing.T) {
	// Simulated real Claude Code welcome line with CUF
	input := []byte("\x1b[1mWelcome\x1b[1Cback\x1b[1Ckimaguri!\x1b[0m")
	got := string(sanitizeForLog(input))
	if !strings.Contains(got, "Welcome back kimaguri!") {
		t.Errorf("Welcome: got %q, should contain 'Welcome back kimaguri!'", got)
	}
}

func TestSanitize_LargeCUF(t *testing.T) {
	// ESC[52C = 52 spaces (used for right-aligning)
	input := []byte("left\x1b[52Cright")
	got := string(sanitizeForLog(input))
	spaces := strings.Count(got, " ")
	if spaces != 52 {
		t.Errorf("Large CUF: expected 52 spaces, got %d in %q", spaces, got)
	}
}

func TestParseCSIParam(t *testing.T) {
	tests := []struct {
		input []byte
		want  int
	}{
		{[]byte("1"), 1},
		{[]byte("52"), 52},
		{[]byte(""), 0},
		{[]byte("1;2"), 1},
		{[]byte("?25"), 0}, // '?' is not a digit
		{[]byte("100"), 100},
	}
	for _, tc := range tests {
		got := parseCSIParam(tc.input)
		if got != tc.want {
			t.Errorf("parseCSIParam(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}
