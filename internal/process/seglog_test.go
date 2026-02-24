package process

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSegmentedLog_HotBufferOnly(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	sl.Write([]byte("line1\nline2\nline3\n"))

	if sl.Len() != 3 {
		t.Fatalf("expected 3 lines, got %d", sl.Len())
	}

	// No segment files should exist
	matches, _ := filepath.Glob(filepath.Join(dir, "seg-*.log"))
	if len(matches) != 0 {
		t.Fatalf("expected no segment files, got %d", len(matches))
	}

	lines := sl.ReadRange(0, 3)
	if len(lines) != 3 || lines[0] != "line1" || lines[2] != "line3" {
		t.Fatalf("unexpected lines: %v", lines)
	}
}

func TestSegmentedLog_FlushToSegment(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 5)

	// Write 7 lines: first 5 should flush to seg-0000, 2 remain in hot
	for i := 0; i < 7; i++ {
		sl.Write([]byte(fmt.Sprintf("line%d\n", i)))
	}

	if sl.Len() != 7 {
		t.Fatalf("expected 7 total lines, got %d", sl.Len())
	}

	// Check segment file exists
	if _, err := os.Stat(filepath.Join(dir, "seg-0000.log")); err != nil {
		t.Fatalf("segment file should exist: %v", err)
	}

	// Check index.json exists
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err != nil {
		t.Fatalf("index.json should exist: %v", err)
	}

	// Hot should have 2 lines
	hot := sl.Lines()
	if len(hot) != 2 {
		t.Fatalf("expected 2 hot lines, got %d", len(hot))
	}
}

func TestSegmentedLog_TwoSegments(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 5)

	// Write 12 lines: seg-0000 (5), seg-0001 (5), hot (2)
	for i := 0; i < 12; i++ {
		sl.Write([]byte(fmt.Sprintf("line%d\n", i)))
	}

	if sl.Len() != 12 {
		t.Fatalf("expected 12 total lines, got %d", sl.Len())
	}

	matches, _ := filepath.Glob(filepath.Join(dir, "seg-*.log"))
	if len(matches) != 2 {
		t.Fatalf("expected 2 segment files, got %d", len(matches))
	}
}

func TestSegmentedLog_ReadRangeHotOnly(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	sl.Write([]byte("a\nb\nc\nd\ne\n"))

	lines := sl.ReadRange(1, 4)
	if len(lines) != 3 || lines[0] != "b" || lines[2] != "d" {
		t.Fatalf("expected [b c d], got %v", lines)
	}
}

func TestSegmentedLog_ReadRangeSpansColdAndHot(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 5)

	// Write 8 lines: seg-0000 has [0..4], hot has [5,6,7]
	for i := 0; i < 8; i++ {
		sl.Write([]byte(fmt.Sprintf("%d\n", i)))
	}

	// Read range spanning cold and hot: lines 3-7
	lines := sl.ReadRange(3, 8)
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d: %v", len(lines), lines)
	}
	expected := []string{"3", "4", "5", "6", "7"}
	for i, exp := range expected {
		if lines[i] != exp {
			t.Fatalf("line[%d]: expected %q, got %q", i, exp, lines[i])
		}
	}
}

func TestSegmentedLog_ReadRangeColdOnly(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 5)

	// Write 12 lines: seg-0000 [0..4], seg-0001 [5..9], hot [10,11]
	for i := 0; i < 12; i++ {
		sl.Write([]byte(fmt.Sprintf("%d\n", i)))
	}

	// Read fully within seg-0000
	lines := sl.ReadRange(1, 4)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "1" || lines[2] != "3" {
		t.Fatalf("expected [1 2 3], got %v", lines)
	}

	// Read spanning two cold segments
	lines = sl.ReadRange(3, 8)
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "3" || lines[4] != "7" {
		t.Fatalf("expected [3 4 5 6 7], got %v", lines)
	}
}

func TestSegmentedLog_ReadRangeClamp(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	sl.Write([]byte("a\nb\nc\n"))

	// Out of bounds: should clamp
	lines := sl.ReadRange(-5, 100)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines (clamped), got %d", len(lines))
	}

	// Empty range
	lines = sl.ReadRange(5, 3)
	if len(lines) != 0 {
		t.Fatalf("expected empty, got %d", len(lines))
	}
}

func TestSegmentedLog_LRUCacheEviction(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 3)
	sl.maxCached = 2 // only cache 2 segments

	// Write 12 lines: 4 segments of 3 lines each
	for i := 0; i < 12; i++ {
		sl.Write([]byte(fmt.Sprintf("%d\n", i)))
	}

	// After writing, the last segment flushed (seg-0003) and seg-0002 should be cached
	// Read from seg-0000 — forces disk load and cache addition
	lines := sl.ReadRange(0, 3)
	if len(lines) != 3 || lines[0] != "0" {
		t.Fatalf("expected [0 1 2], got %v", lines)
	}

	// Cache should now have 2 entries (evicted oldest)
	sl.mu.Lock()
	if len(sl.cache) > 2 {
		t.Fatalf("cache should have at most 2 entries, got %d", len(sl.cache))
	}
	sl.mu.Unlock()

	// Read from seg-0001 — forces another load, evicts oldest
	lines = sl.ReadRange(3, 6)
	if len(lines) != 3 || lines[0] != "3" {
		t.Fatalf("expected [3 4 5], got %v", lines)
	}

	sl.mu.Lock()
	if len(sl.cache) > 2 {
		t.Fatalf("cache should still have at most 2 entries, got %d", len(sl.cache))
	}
	sl.mu.Unlock()
}

func TestSegmentedLog_Reconnect(t *testing.T) {
	dir := t.TempDir()

	// First session: write some lines
	sl1 := NewSegmentedLog(dir, 5)
	for i := 0; i < 8; i++ {
		sl1.Write([]byte(fmt.Sprintf("%d\n", i)))
	}
	// Flush any partial
	sl1.Flush()

	// Second session: create from same dir — should load index
	sl2 := NewSegmentedLog(dir, 5)

	// The cold segment (5 lines) should be loaded from index
	// Hot buffer from first session is lost (not persisted)
	if sl2.Len() != 5 {
		t.Fatalf("expected 5 lines from index, got %d", sl2.Len())
	}

	// Can read the cold segment
	lines := sl2.ReadRange(0, 5)
	if len(lines) != 5 || lines[0] != "0" || lines[4] != "4" {
		t.Fatalf("expected [0 1 2 3 4], got %v", lines)
	}

	// New writes continue from where index left off
	sl2.Write([]byte("new1\nnew2\n"))
	if sl2.Len() != 7 {
		t.Fatalf("expected 7 lines after new writes, got %d", sl2.Len())
	}

	lines = sl2.ReadRange(5, 7)
	if len(lines) != 2 || lines[0] != "new1" {
		t.Fatalf("expected [new1 new2], got %v", lines)
	}
}

func TestSegmentedLog_FlushPartial(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	// Write without trailing newline
	sl.Write([]byte("partial"))
	if sl.Len() != 0 {
		t.Fatalf("partial line should not count as a line, got %d", sl.Len())
	}

	// Flush should promote partial to a line
	sl.Flush()
	if sl.Len() != 1 {
		t.Fatalf("expected 1 line after flush, got %d", sl.Len())
	}

	lines := sl.ReadRange(0, 1)
	if len(lines) != 1 || lines[0] != "partial" {
		t.Fatalf("expected [partial], got %v", lines)
	}
}

func TestSegmentedLog_SubscribeReceivesLines(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	ch := sl.Subscribe()

	sl.Write([]byte("hello\nworld\n"))

	// Should receive both lines
	select {
	case line := <-ch:
		if line != "hello" {
			t.Fatalf("expected 'hello', got %q", line)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for first line")
	}

	select {
	case line := <-ch:
		if line != "world" {
			t.Fatalf("expected 'world', got %q", line)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for second line")
	}

	sl.Unsubscribe(ch)
}

func TestSegmentedLog_Content(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	sl.Write([]byte("line1\nline2\npartial"))

	content := sl.Content()
	if !strings.Contains(content, "line1") || !strings.Contains(content, "partial") {
		t.Fatalf("Content should include hot lines and partial, got: %q", content)
	}
}

func TestSegmentedLog_SafeName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple", "simple"},
		{"task:repo", "task_repo"},
		{"path/to/thing", "path_to_thing"},
		{"has space", "has_space"},
	}
	for _, tt := range tests {
		got := SafeName(tt.input)
		if got != tt.expected {
			t.Errorf("SafeName(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestSegmentedLog_Lines(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	sl.Write([]byte("a\nb\npartial"))

	lines := sl.Lines()
	// Should have 2 complete lines + 1 partial
	if len(lines) != 3 || lines[0] != "a" || lines[1] != "b" || lines[2] != "partial" {
		t.Fatalf("expected [a b partial], got %v", lines)
	}
}

func TestSegmentedLog_WriteReturnsByteCount(t *testing.T) {
	dir := t.TempDir()
	sl := NewSegmentedLog(dir, 100)

	data := []byte("hello\nworld\n")
	n, err := sl.Write(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != len(data) {
		t.Fatalf("expected %d bytes written, got %d", len(data), n)
	}
}
