package process

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

// TestSanitizedScrollbackPreservesSpaces verifies that sanitized PTY output
// written to SegmentedLog preserves spaces between words.
func TestSanitizedScrollbackPreservesSpaces(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sw := sanitizingWriter{w: sl}

	// Simulate PTY output with \r\n line endings
	for i := 0; i < 20; i++ {
		line := fmt.Sprintf("line %d: hello world this is a test with spaces\r\n", i)
		sw.Write([]byte(line))
	}

	sbLen := sl.Len()
	t.Logf("scrollback length: %d", sbLen)

	if sbLen != 20 {
		t.Errorf("expected 20 lines, got %d", sbLen)
	}

	lines := sl.ReadRange(0, sbLen)
	for i, line := range lines {
		if !strings.Contains(line, " ") {
			t.Errorf("scrollback[%d] has NO SPACES: %q", i, line)
		}
		if strings.Contains(line, "helloworld") {
			t.Errorf("scrollback[%d] has concatenated words: %q", i, line)
		}
	}
}

// TestSanitizedScrollbackBulkOutput simulates fast bulk output (like a CI build).
func TestSanitizedScrollbackBulkOutput(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sw := sanitizingWriter{w: sl}

	// Generate 100 lines in a single write (like piped output)
	var buf strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&buf, "output line %d: the quick brown fox jumps over the lazy dog\r\n", i)
	}
	sw.Write([]byte(buf.String()))

	sbLen := sl.Len()
	t.Logf("scrollback length: %d (expected 100)", sbLen)

	if sbLen != 100 {
		t.Errorf("expected 100 lines, got %d", sbLen)
	}

	lines := sl.ReadRange(0, sbLen)
	spaceless := 0
	for i, line := range lines {
		if !strings.Contains(line, " ") && len(line) > 10 {
			spaceless++
			if spaceless <= 5 {
				t.Logf("NO SPACES in scrollback[%d]: %q", i, line)
			}
		}
	}
	if spaceless > 0 {
		t.Errorf("%d out of %d scrollback lines have no spaces", spaceless, len(lines))
	}
}

// TestSanitizedScrollbackWithANSI verifies that ANSI colors are preserved
// while cursor movement is stripped.
func TestSanitizedScrollbackWithANSI(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sw := sanitizingWriter{w: sl}

	// Write ANSI-colored lines
	for i := 0; i < 10; i++ {
		line := fmt.Sprintf("\x1b[1;32mLine %d:\x1b[0m normal text with \x1b[34mblue words\x1b[0m and spaces\r\n", i)
		sw.Write([]byte(line))
	}

	sbLen := sl.Len()
	if sbLen != 10 {
		t.Errorf("expected 10 lines, got %d", sbLen)
	}

	lines := sl.ReadRange(0, sbLen)
	for i, line := range lines {
		// Should have ANSI codes
		if !strings.Contains(line, "\x1b[") {
			t.Errorf("scrollback[%d] missing ANSI codes: %q", i, line)
		}
		// Plain text should have spaces
		plain := ansi.Strip(line)
		if !strings.Contains(plain, " ") {
			t.Errorf("scrollback[%d] missing spaces: %q", i, plain)
		}
	}
}

// TestSanitizedScrollbackStripsCursorMovement verifies that cursor positioning
// sequences are removed from scrollback while text content is preserved.
func TestSanitizedScrollbackStripsCursorMovement(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	sw := sanitizingWriter{w: sl}

	// Simulate cursor movement + text (like TUI status updates)
	sw.Write([]byte("\x1b[1;1Hstatus: running\r\n"))
	sw.Write([]byte("\x1b[2;1Hprogress: 50 percent\r\n"))
	sw.Write([]byte("\x1b[2Jscreen cleared\r\n"))          // clear screen — stripped
	sw.Write([]byte("plain line with spaces\r\n"))

	lines := sl.ReadRange(0, sl.Len())
	t.Logf("lines: %v", lines)

	// All lines should have spaces preserved
	for i, line := range lines {
		if !strings.Contains(line, " ") && len(line) > 5 {
			t.Errorf("line[%d] missing spaces: %q", i, line)
		}
	}

	// Should NOT contain cursor positioning sequences
	all := strings.Join(lines, "\n")
	if strings.Contains(all, "\x1b[1;1H") {
		t.Error("cursor positioning was not stripped")
	}
	if strings.Contains(all, "\x1b[2J") {
		t.Error("screen clear was not stripped")
	}

	// Should contain color codes (SGR)
	sw.Write([]byte("\x1b[32mgreen text\x1b[0m\r\n"))
	lines = sl.ReadRange(sl.Len()-1, sl.Len())
	if len(lines) > 0 && !strings.Contains(lines[0], "\x1b[32m") {
		t.Error("SGR color codes were stripped (should be preserved)")
	}
}

// TestVTermRenderHasSpaces is a basic test — confirm VTerm Render() has spaces.
func TestVTermRenderHasSpaces(t *testing.T) {
	vt := NewVTermScreen(5, 40)
	vt.Write([]byte("hello world\r\n"))
	vt.Write([]byte("foo bar baz\r\n"))

	raw := vt.Render()
	plain := ansi.Strip(raw)
	t.Logf("VTerm plain output: %q", plain)

	if !strings.Contains(plain, "hello world") {
		t.Errorf("VTerm render missing spaces: %q", plain)
	}
	if !strings.Contains(plain, "foo bar baz") {
		t.Errorf("VTerm render missing spaces in line 2: %q", plain)
	}
}
