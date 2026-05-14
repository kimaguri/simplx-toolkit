package tui

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestShouldExitInteractive(t *testing.T) {
	t0 := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	window := 500 * time.Millisecond
	escKey := tea.KeyMsg{Type: tea.KeyEscape}
	otherKey := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}}
	ctrlBracket := tea.KeyMsg{Type: tea.KeyCtrlCloseBracket}

	tests := []struct {
		name        string
		now         time.Time
		lastEsc     time.Time
		msg         tea.KeyMsg
		wantExit    bool
		wantForward bool
		wantArm     bool // whether newLastEsc == now (first Esc seen)
	}{
		{
			name:        "non-Esc forwards, no arm",
			now:         t0,
			lastEsc:     time.Time{},
			msg:         otherKey,
			wantExit:    false,
			wantForward: true,
			wantArm:     false,
		},
		{
			name:        "first Esc arms timer and forwards",
			now:         t0,
			lastEsc:     time.Time{},
			msg:         escKey,
			wantExit:    false,
			wantForward: true,
			wantArm:     true,
		},
		{
			name:        "second Esc within window exits, no forward",
			now:         t0.Add(200 * time.Millisecond),
			lastEsc:     t0,
			msg:         escKey,
			wantExit:    true,
			wantForward: false,
			wantArm:     false,
		},
		{
			name:        "second Esc after window — re-arms, forwards",
			now:         t0.Add(800 * time.Millisecond),
			lastEsc:     t0,
			msg:         escKey,
			wantExit:    false,
			wantForward: true,
			wantArm:     true,
		},
		{
			name:        "non-Esc after first Esc disarms",
			now:         t0.Add(100 * time.Millisecond),
			lastEsc:     t0,
			msg:         otherKey,
			wantExit:    false,
			wantForward: true,
			wantArm:     false,
		},
		{
			name:        "Ctrl+] no longer exits (compatibility removed)",
			now:         t0,
			lastEsc:     time.Time{},
			msg:         ctrlBracket,
			wantExit:    false,
			wantForward: true,
			wantArm:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			exit, newLast, forward := shouldExitInteractive(tc.now, tc.lastEsc, tc.msg, window)
			if exit != tc.wantExit {
				t.Fatalf("exit: got %v, want %v", exit, tc.wantExit)
			}
			if forward != tc.wantForward {
				t.Fatalf("forward: got %v, want %v", forward, tc.wantForward)
			}
			armed := newLast.Equal(tc.now)
			if armed != tc.wantArm {
				t.Fatalf("arm: got %v (newLast=%v), want %v", armed, newLast, tc.wantArm)
			}
			if tc.wantExit && !newLast.IsZero() {
				t.Fatalf("after exit, newLast must be zero, got %v", newLast)
			}
		})
	}
}
