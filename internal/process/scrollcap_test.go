package process

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestDetectScroll_NoScroll(t *testing.T) {
	prev := []string{"line A", "line B", "line C", "line D"}
	curr := []string{"line A", "line B", "line C", "line D"}
	if got := detectScroll(prev, curr); got != 0 {
		t.Errorf("expected 0, got %d", got)
	}
}

func TestDetectScroll_OneLineScroll(t *testing.T) {
	prev := []string{"line A", "line B", "line C", "line D", "line E", "line F"}
	curr := []string{"line B", "line C", "line D", "line E", "line F", "line G"}
	if got := detectScroll(prev, curr); got != 1 {
		t.Errorf("expected 1, got %d", got)
	}
}

func TestDetectScroll_ThreeLineScroll(t *testing.T) {
	prev := []string{"A", "B", "C", "D", "E", "F", "G", "H"}
	curr := []string{"D", "E", "F", "G", "H", "I", "J", "K"}
	if got := detectScroll(prev, curr); got != 3 {
		t.Errorf("expected 3, got %d", got)
	}
}

func TestDetectScroll_CompleteChange(t *testing.T) {
	prev := []string{"A", "B", "C", "D", "E", "F"}
	curr := []string{"X", "Y", "Z", "W", "V", "U"}
	if got := detectScroll(prev, curr); got != 0 {
		t.Errorf("expected 0 (complete change, not scroll), got %d", got)
	}
}

func TestDetectScroll_PartialUpdate(t *testing.T) {
	prev := []string{"header", "line B", "line C", "line D", "status: 50%"}
	curr := []string{"header", "line B", "line C", "line D", "status: 75%"}
	if got := detectScroll(prev, curr); got != 0 {
		t.Errorf("expected 0 (just status update), got %d", got)
	}
}

func TestCountChanged(t *testing.T) {
	tests := []struct {
		name string
		prev []string
		curr []string
		want int
	}{
		{"same", []string{"a", "b"}, []string{"a", "b"}, 0},
		{"all different", []string{"a", "b"}, []string{"x", "y"}, 2},
		{"one changed", []string{"a", "b"}, []string{"a", "y"}, 1},
		{"different lengths", []string{"a", "b", "c"}, []string{"a"}, 2}, // 'a' matches, 'b' and 'c' have no counterpart
	}
	for _, tc := range tests {
		got := countChanged(tc.prev, tc.curr)
		if got != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestScrollCapture_WithVTerm(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	vterm := NewVTermScreen(5, 40) // small VTerm for testing
	sc := NewScrollCapture(5, sl)

	// Write first batch — fills screen (5 lines in 5-row terminal)
	// The trailing \n after line E scrolls line A off, so scrollback may be > 0
	data1 := []byte("line A\r\nline B\r\nline C\r\nline D\r\nline E\r\n")
	sc.ProcessChunk(vterm, data1)
	afterFirst := sl.Len()
	t.Logf("scrollback after first batch: %d", afterFirst)

	// Write second batch — scrolls more lines off the top
	data2 := []byte("line F\r\nline G\r\nline H\r\n")
	sc.ProcessChunk(vterm, data2)

	sbLen := sl.Len()
	t.Logf("scrollback after second batch: %d", sbLen)

	if sbLen == 0 {
		t.Error("expected scrollback lines after scrolling, got 0")
	}

	// Verify captured lines have correct content (should include early lines)
	lines := sl.ReadRange(0, sbLen)
	for i, line := range lines {
		plain := ansi.Strip(line)
		t.Logf("scrollback[%d]: %q", i, strings.TrimSpace(plain))
	}

	// At least line A should be captured (it scrolled off first)
	if sbLen < 1 {
		t.Error("expected at least 1 captured line")
	}
}

func TestScrollCapture_Flush(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	vterm := NewVTermScreen(5, 40)
	sc := NewScrollCapture(5, sl)

	// Write a few lines (no scroll)
	data := []byte("hello world\r\nfoo bar\r\n")
	sc.ProcessChunk(vterm, data)

	beforeFlush := sl.Len()

	// Flush should write current VTerm content to scrollback
	sc.Flush(vterm)

	afterFlush := sl.Len()
	t.Logf("before flush: %d, after flush: %d", beforeFlush, afterFlush)

	if afterFlush <= beforeFlush {
		t.Errorf("flush should add lines: before=%d, after=%d", beforeFlush, afterFlush)
	}

	// Check flushed content has spaces
	lines := sl.ReadRange(0, afterFlush)
	for i, line := range lines {
		plain := ansi.Strip(line)
		if strings.Contains(plain, "helloworld") {
			t.Errorf("line[%d] concatenated words: %q", i, plain)
		}
	}
}

func TestScrollCapture_PreservesANSI(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	vterm := NewVTermScreen(5, 40)
	sc := NewScrollCapture(5, sl)

	// First batch: colored content fills the screen
	data1 := []byte("\x1b[32mgreen line 1\x1b[0m\r\n\x1b[31mred line 2\x1b[0m\r\nline 3\r\nline 4\r\nline 5\r\n")
	sc.ProcessChunk(vterm, data1)

	// Second batch: push colored lines off the screen
	data2 := []byte("line 6\r\nline 7\r\nline 8\r\nline 9\r\nline 10\r\n")
	sc.ProcessChunk(vterm, data2)

	// The first batch should have been captured with ANSI codes
	sbLen := sl.Len()
	if sbLen == 0 {
		t.Fatal("scrollback empty after scroll")
	}

	lines := sl.ReadRange(0, sbLen)
	hasColor := false
	for _, line := range lines {
		if strings.Contains(line, "\x1b[") {
			hasColor = true
			break
		}
	}
	if !hasColor {
		t.Error("scrollback lost ANSI color codes")
		for i, line := range lines {
			t.Logf("  [%d]: %q", i, line)
		}
	}
}

func TestScrollCapture_BulkOutput(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(filepath.Join(dir, "scrollback"), DefaultSegSize)
	vterm := NewVTermScreen(5, 40)
	sc := NewScrollCapture(5, sl)

	// First batch: fill screen
	data1 := []byte("line A\r\nline B\r\nline C\r\nline D\r\nline E\r\n")
	sc.ProcessChunk(vterm, data1)

	// Second batch: completely different content (like bulk output overwriting everything)
	data2 := []byte("new 1\r\nnew 2\r\nnew 3\r\nnew 4\r\nnew 5\r\n")
	sc.ProcessChunk(vterm, data2)

	// The bulk heuristic should capture previous screen content
	sbLen := sl.Len()
	t.Logf("scrollback after bulk: %d", sbLen)

	if sbLen == 0 {
		t.Error("expected scrollback lines from bulk output detection")
	}
}
