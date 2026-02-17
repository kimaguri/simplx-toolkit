package tui

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/aymanbagabas/go-osc52/v2"
	"github.com/atotto/clipboard"
)

// ClipboardFeedbackMsg carries a feedback message to display after copy
type ClipboardFeedbackMsg struct {
	Message string
}

// ClearClipboardFeedbackMsg signals that the feedback should be cleared
type ClearClipboardFeedbackMsg struct{}

// clipboardFeedbackTimeout returns a command that fires ClearClipboardFeedbackMsg after 2 seconds
func clipboardFeedbackTimeout() tea.Cmd {
	return tea.Tick(2*time.Second, func(_ time.Time) tea.Msg {
		return ClearClipboardFeedbackMsg{}
	})
}

// copyToClipboard copies text to the system clipboard.
// Tries OSC52 escape sequence first (works over SSH), falls back to atotto/clipboard.
func copyToClipboard(text string) error {
	// Try OSC52 first — write escape sequence to stderr so it reaches the terminal
	osc52.New(text).WriteTo(os.Stderr)

	// Also try native clipboard as fallback (works locally, may fail over SSH)
	if err := clipboard.WriteAll(text); err != nil {
		// If OSC52 was written, we consider it a success even if native fails
		return nil
	}

	return nil
}

// copyVisibleLines extracts visible viewport lines and copies them to clipboard.
// Returns the feedback message command batch.
func copyVisibleLines(viewportContent string) tea.Cmd {
	lines := strings.Split(viewportContent, "\n")
	text := strings.Join(lines, "\n")
	lineCount := len(lines)

	if err := copyToClipboard(text); err != nil {
		return func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copy error: %v]", err)}
		}
	}

	return tea.Batch(
		func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copied %d lines]", lineCount)}
		},
		clipboardFeedbackTimeout(),
	)
}

// copySelectedLines copies the given text (from visual selection) to clipboard.
// Returns the feedback message command batch.
func copySelectedLines(text string, lineCount int) tea.Cmd {
	if err := copyToClipboard(text); err != nil {
		return func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copy error: %v]", err)}
		}
	}

	return tea.Batch(
		func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copied %d lines]", lineCount)}
		},
		clipboardFeedbackTimeout(),
	)
}

// copyAllLines copies all log buffer content to clipboard.
// Returns the feedback message command batch.
func copyAllLines(content string) tea.Cmd {
	lines := strings.Split(content, "\n")
	lineCount := len(lines)

	if err := copyToClipboard(content); err != nil {
		return func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copy error: %v]", err)}
		}
	}

	return tea.Batch(
		func() tea.Msg {
			return ClipboardFeedbackMsg{Message: fmt.Sprintf("[Copied all %d lines]", lineCount)}
		},
		clipboardFeedbackTimeout(),
	)
}
