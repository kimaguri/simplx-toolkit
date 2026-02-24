package tui

import "github.com/charmbracelet/lipgloss"

var (
	modalStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("14")).
		Padding(1, 2)
)

// RepoOption represents a repo available for addition.
type RepoOption struct {
	Name string
	Path string
	Role string
}
