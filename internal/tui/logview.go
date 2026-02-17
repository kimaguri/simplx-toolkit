package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// LogLineMsg delivers a new log line from a subscription
type LogLineMsg struct {
	SessionName string
	Line        string
}

// logViewModel is a fullscreen log viewer for a single session
type logViewModel struct {
	sessionName   string
	port          int
	rp            *process.RunningProcess // reference to process (for PTY/VTerm access)
	viewport      viewport.Model
	logBuf        *process.LogBuffer
	subCh         chan string
	autoScroll    bool
	width         int
	height        int
	ready         bool
	clipboardMsg  string
	search        searchModel
	selection     selectionModel
	isInteractive bool // interactive mode active (keys → PTY)
}

// newLogViewModel creates a new fullscreen log viewer
func newLogViewModel(rp *process.RunningProcess) logViewModel {
	return logViewModel{
		sessionName: rp.Info.Name,
		port:        rp.Info.Port,
		rp:          rp,
		logBuf:      rp.LogBuf,
		autoScroll:  true,
		search:      newSearchModel(),
	}
}

// Init subscribes to the log buffer channel
func (m logViewModel) Init() tea.Cmd {
	return nil
}

// Subscribe starts listening to the log buffer and returns the initial cmd
func (m *logViewModel) Subscribe() tea.Cmd {
	if m.logBuf == nil {
		return nil
	}
	m.subCh = m.logBuf.Subscribe()
	return waitForLogLine(m.sessionName, m.subCh)
}

// Unsubscribe stops listening to the log buffer
func (m *logViewModel) Unsubscribe() {
	if m.subCh != nil && m.logBuf != nil {
		m.logBuf.Unsubscribe(m.subCh)
		m.subCh = nil
	}
}

// waitForLogLine returns a Cmd that blocks on the channel for the next log line
func waitForLogLine(sessionName string, ch <-chan string) tea.Cmd {
	return func() tea.Msg {
		line, ok := <-ch
		if !ok {
			return nil
		}
		return LogLineMsg{SessionName: sessionName, Line: line}
	}
}

// Update handles input and log updates
func (m logViewModel) Update(msg tea.Msg) (logViewModel, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case ClipboardFeedbackMsg:
		m.clipboardMsg = msg.Message
		return m, nil

	case ClearClipboardFeedbackMsg:
		m.clipboardMsg = ""
		return m, nil

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		headerH := 1 // title bar
		footerH := 1 // help
		vpHeight := m.height - headerH - footerH
		if vpHeight < 1 {
			vpHeight = 1
		}
		if !m.ready {
			m.viewport = viewport.New(m.width, vpHeight)
			content := ansi.Wordwrap(m.logBuf.Content(), m.width, "")
			m.viewport.SetContent(content)
			if m.autoScroll {
				m.viewport.GotoBottom()
			}
			m.ready = true
		} else {
			m.viewport.Width = m.width
			m.viewport.Height = vpHeight
		}
		return m, nil

	case LogLineMsg:
		if msg.SessionName != m.sessionName {
			return m, nil
		}
		// Freeze viewport during visual selection — buffer new lines but don't shift content
		if m.selection.isActive() {
			if m.subCh != nil {
				cmds = append(cmds, waitForLogLine(m.sessionName, m.subCh))
			}
			return m, tea.Batch(cmds...)
		}
		if m.isInteractive {
			m.refreshInteractiveViewport()
		} else if m.search.isActive() && m.search.query != "" {
			m.applySearchFilter()
		} else {
			// Update viewport with full content from buffer (word-wrapped)
			content := ansi.Wordwrap(m.logBuf.Content(), m.viewport.Width, "")
			m.viewport.SetContent(content)
			if m.autoScroll {
				m.viewport.GotoBottom()
			}
		}
		// Re-subscribe for the next line
		if m.subCh != nil {
			cmds = append(cmds, waitForLogLine(m.sessionName, m.subCh))
		}
		return m, tea.Batch(cmds...)

	case tea.KeyMsg:
		// When visual selection is active, handle selection keys
		if m.selection.isActive() {
			return m.handleSelectionKey(msg)
		}
		// When search input is active, route keys there
		if m.search.mode == searchInput {
			return m.updateSearchInput(msg)
		}

		// When in navigate mode, handle n/N/Esc
		if m.search.mode == searchNavigate {
			switch msg.String() {
			case "esc":
				m.search.deactivate()
				m.refreshLogViewport()
				return m, nil
			case "n":
				if m.search.currentMatch < m.search.matchCount {
					m.search.currentMatch++
				}
				return m, nil
			case "N":
				if m.search.currentMatch > 1 {
					m.search.currentMatch--
				}
				return m, nil
			case "/":
				cmd := m.search.activate()
				return m, cmd
			}
		}

		switch msg.String() {
		case "G":
			m.viewport.GotoBottom()
			m.autoScroll = true
			return m, nil
		case "g":
			m.viewport.GotoTop()
			m.autoScroll = false
			return m, nil
		case "c":
			if m.ready {
				return m, copyVisibleLines(m.viewport.View())
			}
			return m, nil
		case "y":
			if m.logBuf != nil {
				return m, copyAllLines(m.logBuf.Content())
			}
			return m, nil
		case "/":
			cmd := m.search.activate()
			return m, cmd
		case "v":
			if m.logBuf != nil {
				m.search.deactivate()
				content := ansi.Wordwrap(m.logBuf.Content(), m.viewport.Width, "")
				m.selection.activate(m.viewport, content)
				m.selection.applyToViewport(&m.viewport)
			}
			return m, nil
		case "i":
			if m.rp != nil && m.rp.PtyFile != nil {
				m.isInteractive = true
				m.refreshInteractiveViewport()
				return m, scheduleInteractiveTick()
			}
			return m, nil
		}

		// Pass key to viewport for scrolling
		prevOffset := m.viewport.YOffset
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}

		// If user scrolled up, disable auto-scroll
		if m.viewport.YOffset < prevOffset {
			m.autoScroll = false
		}
		// If user scrolled to bottom, re-enable auto-scroll
		if m.viewport.AtBottom() {
			m.autoScroll = true
		}
		return m, tea.Batch(cmds...)
	}

	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	if cmd != nil {
		cmds = append(cmds, cmd)
	}
	return m, tea.Batch(cmds...)
}

// updateSearchInput handles key events when the search text input is active
func (m logViewModel) updateSearchInput(msg tea.KeyMsg) (logViewModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.search.deactivate()
		m.refreshLogViewport()
		return m, nil
	case "enter":
		m.search.enterNavigateMode()
		return m, nil
	}

	cmd := m.search.update(msg)
	m.applySearchFilter()
	return m, cmd
}

// handleSelectionKey processes keys during visual selection mode
func (m logViewModel) handleSelectionKey(msg tea.KeyMsg) (logViewModel, tea.Cmd) {
	action := m.selection.handleKey(msg.String(), m.viewport.Height)
	switch action {
	case selActionMoved:
		m.selection.applyToViewport(&m.viewport)
		return m, nil
	case selActionCopy:
		text := m.selection.selectedText()
		count := m.selection.selectedLineCount()
		m.selection.deactivate()
		m.refreshLogViewport()
		return m, copySelectedLines(text, count)
	case selActionCancel:
		m.selection.deactivate()
		m.refreshLogViewport()
		return m, nil
	}
	return m, nil
}

// applySearchFilter filters log content by the current search query
func (m *logViewModel) applySearchFilter() {
	if m.logBuf == nil || !m.ready {
		return
	}

	if m.search.query == "" {
		m.refreshLogViewport()
		return
	}

	lines := m.logBuf.Lines()
	filtered, matchCount := filterAndHighlight(lines, m.search.query)
	m.search.matchCount = matchCount

	content := strings.Join(filtered, "\n")
	wrapped := ansi.Wordwrap(content, m.viewport.Width, "")
	m.viewport.SetContent(wrapped)
	m.viewport.GotoBottom()
}

// refreshLogViewport restores the full (unfiltered) log content in the viewport
func (m *logViewModel) refreshLogViewport() {
	if m.logBuf == nil || !m.ready {
		return
	}
	content := ansi.Wordwrap(m.logBuf.Content(), m.viewport.Width, "")
	m.viewport.SetContent(content)
	if m.autoScroll {
		m.viewport.GotoBottom()
	}
}

// refreshInteractiveViewport renders VTerm screen content into the viewport
func (m *logViewModel) refreshInteractiveViewport() {
	if m.rp == nil || m.rp.VTerm == nil {
		return
	}
	content := m.rp.VTerm.Content()
	m.viewport.SetContent(content)
	m.viewport.GotoBottom()
}

// View renders the fullscreen log viewer
func (m logViewModel) View() string {
	if !m.ready {
		return "Loading..."
	}

	// Title bar
	titleText := fmt.Sprintf(" %s (:%d)", m.sessionName, m.port)
	scrollInfo := fmt.Sprintf("scroll: %d/%d ", m.viewport.YOffset+m.viewport.Height, m.viewport.TotalLineCount())
	helpText := " q:back  G:bottom  g:top  c:copy  y:copy all  v:select  /:search  i:interactive "
	if m.isInteractive {
		helpText = " INTERACTIVE  Ctrl+]:exit "
	}

	// Append clipboard feedback to help text if present
	feedbackText := ""
	if m.clipboardMsg != "" {
		feedbackText = " " + m.clipboardMsg
	}

	titleWidth := lipgloss.Width(titleText)
	scrollWidth := lipgloss.Width(scrollInfo)
	helpWidth := lipgloss.Width(helpText)
	feedbackWidth := lipgloss.Width(feedbackText)
	padding := m.width - titleWidth - scrollWidth - helpWidth - feedbackWidth
	if padding < 0 {
		padding = 0
	}

	header := titleStyle.Render(titleText) +
		lipgloss.NewStyle().Foreground(colorGray).Render(fmt.Sprintf("%*s", padding, "")) +
		dimStyle.Render(scrollInfo) +
		helpKeyStyle.Render(helpText) +
		helpKeyStyle.Render(feedbackText)

	// Truncate header to terminal width (ANSI-safe via lipgloss MaxWidth)
	if lipgloss.Width(header) > m.width {
		header = lipgloss.NewStyle().MaxWidth(m.width).Render(header)
	}

	// Build view parts
	parts := []string{header, m.viewport.View()}

	// Add selection or search bar at the bottom when active
	if m.selection.isActive() {
		parts = append(parts, m.selection.renderStatusBar(m.width))
	} else if m.search.isActive() {
		parts = append(parts, m.search.renderSearchBar(m.width))
	}

	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

// SetSize updates dimensions and cancels selection (frozen content invalid after re-wrap)
func (m *logViewModel) SetSize(w, h int) {
	if w != m.width {
		m.selection.deactivate()
	}
	m.width = w
	m.height = h
	headerH := 1
	footerH := 1
	vpHeight := h - headerH - footerH
	if vpHeight < 1 {
		vpHeight = 1
	}
	m.viewport.Width = w
	m.viewport.Height = vpHeight
}
