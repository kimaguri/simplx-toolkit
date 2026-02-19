package tui

import (
	"strings"
	"testing"
)

func TestScrollWindow_FitsWithoutScroll(t *testing.T) {
	lines := []string{"a", "b", "c"}
	result := scrollWindow(lines, 1, 10)
	if result != "a\nb\nc" {
		t.Errorf("expected no scroll, got:\n%s", result)
	}
}

func TestScrollWindow_ScrollsDown(t *testing.T) {
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = strings.Repeat("x", i+1)
	}

	result := scrollWindow(lines, 0, 5)
	resultLines := strings.Split(result, "\n")

	// First 5 items + "↓ more" indicator
	if len(resultLines) != 6 {
		t.Fatalf("expected 6 lines (5 items + indicator), got %d:\n%s", len(resultLines), result)
	}
	if !strings.Contains(resultLines[5], "more") {
		t.Errorf("expected '↓ more' indicator, got: %s", resultLines[5])
	}
}

func TestScrollWindow_ScrollsUp(t *testing.T) {
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = strings.Repeat("x", i+1)
	}

	result := scrollWindow(lines, 19, 5)
	resultLines := strings.Split(result, "\n")

	// "↑ more" + last 5 items
	if len(resultLines) != 6 {
		t.Fatalf("expected 6 lines (indicator + 5 items), got %d:\n%s", len(resultLines), result)
	}
	if !strings.Contains(resultLines[0], "more") {
		t.Errorf("expected '↑ more' indicator, got: %s", resultLines[0])
	}
}

func TestScrollWindow_BothIndicators(t *testing.T) {
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = strings.Repeat("x", i+1)
	}

	result := scrollWindow(lines, 10, 5)
	resultLines := strings.Split(result, "\n")

	// "↑ more" + 5 items + "↓ more"
	if len(resultLines) != 7 {
		t.Fatalf("expected 7 lines (2 indicators + 5 items), got %d:\n%s", len(resultLines), result)
	}
	if !strings.Contains(resultLines[0], "↑") {
		t.Errorf("expected top indicator, got: %s", resultLines[0])
	}
	last := resultLines[len(resultLines)-1]
	if !strings.Contains(last, "↓") {
		t.Errorf("expected bottom indicator, got: %s", last)
	}
}

func TestScrollWindow_SelectedAlwaysVisible(t *testing.T) {
	lines := make([]string, 50)
	for i := range lines {
		lines[i] = strings.Repeat("x", i+1)
	}

	for sel := 0; sel < 50; sel++ {
		result := scrollWindow(lines, sel, 8)
		target := lines[sel]
		if !strings.Contains(result, target) {
			t.Errorf("selected item %d not visible in scroll window", sel)
		}
	}
}
