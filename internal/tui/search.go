package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// searchMode tracks the current state of the search feature
type searchMode int

const (
	searchOff      searchMode = iota // search not active
	searchInput                      // user is typing in the search bar
	searchNavigate                   // search bar closed, navigating matches with n/N
)

// searchModel manages search state including text input, filtering and match navigation
type searchModel struct {
	input        textinput.Model
	mode         searchMode
	query        string
	matchCount   int
	currentMatch int
}

// newSearchModel creates a new search model with a configured text input
func newSearchModel() searchModel {
	ti := textinput.New()
	ti.Placeholder = "search..."
	ti.Prompt = "/"
	ti.CharLimit = 256
	ti.PromptStyle = searchPromptStyle
	ti.TextStyle = lipgloss.NewStyle().Foreground(colorWhite)
	return searchModel{
		input: ti,
		mode:  searchOff,
	}
}

// activate opens the search bar and focuses the text input
func (s *searchModel) activate() tea.Cmd {
	s.mode = searchInput
	s.input.SetValue(s.query)
	s.input.Focus()
	return s.input.Focus()
}

// deactivate closes search and clears the query
func (s *searchModel) deactivate() {
	s.mode = searchOff
	s.query = ""
	s.matchCount = 0
	s.currentMatch = 0
	s.input.SetValue("")
	s.input.Blur()
}

// enterNavigateMode keeps the filter active but closes the text input
func (s *searchModel) enterNavigateMode() {
	if s.query == "" {
		s.deactivate()
		return
	}
	s.mode = searchNavigate
	s.input.Blur()
	if s.matchCount > 0 {
		s.currentMatch = 1
	}
}

// isActive returns true if search is in input or navigate mode
func (s *searchModel) isActive() bool {
	return s.mode != searchOff
}

// filterAndHighlight filters lines that contain the query (case-insensitive)
// and highlights matching text. Returns filtered lines and total match count.
func filterAndHighlight(lines []string, query string) ([]string, int) {
	if query == "" {
		return lines, 0
	}

	lowerQuery := strings.ToLower(query)
	var filtered []string
	matchCount := 0

	for _, line := range lines {
		if strings.Contains(strings.ToLower(line), lowerQuery) {
			highlighted := highlightMatches(line, query)
			filtered = append(filtered, highlighted)
			matchCount += strings.Count(strings.ToLower(line), lowerQuery)
		}
	}

	return filtered, matchCount
}

// highlightMatches wraps each occurrence of query in the line with a highlight style.
// Uses case-insensitive matching but preserves the original case in output.
func highlightMatches(line string, query string) string {
	if query == "" {
		return line
	}

	lowerLine := strings.ToLower(line)
	lowerQuery := strings.ToLower(query)
	queryLen := len(lowerQuery)

	var result strings.Builder
	lastIdx := 0

	for {
		idx := strings.Index(lowerLine[lastIdx:], lowerQuery)
		if idx == -1 {
			result.WriteString(line[lastIdx:])
			break
		}

		absIdx := lastIdx + idx
		result.WriteString(line[lastIdx:absIdx])
		matchText := line[absIdx : absIdx+queryLen]
		result.WriteString(searchHighlightStyle.Render(matchText))
		lastIdx = absIdx + queryLen
	}

	return result.String()
}

// renderSearchBar renders the search input bar with match count
func (s *searchModel) renderSearchBar(width int) string {
	var bar string

	switch s.mode {
	case searchInput:
		s.input.Width = width - 20
		if s.input.Width < 10 {
			s.input.Width = 10
		}
		inputView := s.input.View()
		countText := ""
		if s.query != "" {
			countText = searchCountStyle.Render(fmt.Sprintf(" %d matches", s.matchCount))
		}
		bar = inputView + countText

	case searchNavigate:
		queryDisplay := searchPromptStyle.Render("/") +
			lipgloss.NewStyle().Foreground(colorWhite).Render(s.query)
		countText := ""
		if s.matchCount > 0 {
			countText = searchCountStyle.Render(
				fmt.Sprintf(" [%d/%d]", s.currentMatch, s.matchCount))
		} else {
			countText = searchCountStyle.Render(" [no matches]")
		}
		navHint := searchCountStyle.Render("  n:next N:prev esc:close")
		bar = queryDisplay + countText + navHint
	}

	return searchBarStyle.Width(width).Render(bar)
}

// update handles key events for the search model when in input mode.
// Returns the updated model and any commands.
func (s *searchModel) update(msg tea.KeyMsg) tea.Cmd {
	if s.mode != searchInput {
		return nil
	}

	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	s.query = s.input.Value()

	return cmd
}
