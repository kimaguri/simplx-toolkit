package tui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

// focusPanel tracks which panel is focused
type focusPanel int

const (
	focusList focusPanel = iota
	focusLogs
)

// dashboardModel is the main split-pane dashboard view
type dashboardModel struct {
	processes     []*process.RunningProcess
	selected      int
	focus         focusPanel
	logViewport   viewport.Model
	width         int
	height        int
	ready         bool
	logSubCh      chan string
	logSubName    string
	logBuf        *process.LogBuffer
	autoScroll    bool
	clipboardMsg    string
	tunnelFeedback  string
	search          searchModel
	selection       selectionModel
	isInteractive   bool // interactive mode active (keys → PTY)
}

// newDashboardModel creates a new dashboard
func newDashboardModel() dashboardModel {
	return dashboardModel{
		autoScroll: true,
		search:     newSearchModel(),
	}
}

// Init implements tea.Model
func (m dashboardModel) Init() tea.Cmd {
	return nil
}

// SetProcesses updates the process list
func (m *dashboardModel) SetProcesses(procs []*process.RunningProcess) {
	// Sort by name for stable ordering
	sort.Slice(procs, func(i, j int) bool {
		return procs[i].Info.Name < procs[j].Info.Name
	})
	m.processes = procs

	// Clamp selection
	if m.selected >= len(m.processes) {
		m.selected = len(m.processes) - 1
	}
	if m.selected < 0 {
		m.selected = 0
	}
}

// SelectedProcess returns the currently selected process, or nil
func (m *dashboardModel) SelectedProcess() *process.RunningProcess {
	if m.selected >= 0 && m.selected < len(m.processes) {
		return m.processes[m.selected]
	}
	return nil
}

// SubscribeToSelected subscribes the log viewport to the selected session's buffer
func (m *dashboardModel) SubscribeToSelected() tea.Cmd {
	// Unsubscribe from current
	m.unsubscribeLogs()

	sel := m.SelectedProcess()
	if sel == nil {
		return nil
	}

	m.logBuf = sel.LogBuf
	m.logSubName = sel.Info.Name
	m.logSubCh = sel.LogBuf.Subscribe()

	// Load existing content (with word wrapping)
	if m.ready {
		content := wrapLogContent(sel.LogBuf.Content(), m.logViewport.Width)
		m.logViewport.SetContent(content)
		if m.autoScroll {
			m.logViewport.GotoBottom()
		}
	}

	return waitForLogLine(m.logSubName, m.logSubCh)
}

// unsubscribeLogs cleans up the current log subscription
func (m *dashboardModel) unsubscribeLogs() {
	if m.logSubCh != nil && m.logBuf != nil {
		m.logBuf.Unsubscribe(m.logSubCh)
		m.logSubCh = nil
		m.logSubName = ""
		m.logBuf = nil
	}
}

// Update handles dashboard input
func (m dashboardModel) Update(msg tea.Msg) (dashboardModel, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case ClipboardFeedbackMsg:
		m.clipboardMsg = msg.Message
		return m, nil

	case ClearClipboardFeedbackMsg:
		m.clipboardMsg = ""
		return m, nil

	case tunnelFeedbackMsg:
		m.tunnelFeedback = msg.message
		return m, tunnelFeedbackTimeout()

	case clearTunnelFeedbackMsg:
		m.tunnelFeedback = ""
		return m, nil

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.initViewport()
		return m, nil

	case LogLineMsg:
		if msg.SessionName == m.logSubName && m.ready {
			// Freeze viewport during visual selection
			if m.selection.isActive() {
				if m.logSubCh != nil {
					cmds = append(cmds, waitForLogLine(m.logSubName, m.logSubCh))
				}
				return m, tea.Batch(cmds...)
			}
			if m.isInteractive {
				m.refreshInteractiveViewport()
			} else if m.search.isActive() && m.search.query != "" {
				m.applySearchFilter()
			} else {
				content := wrapLogContent(m.logBuf.Content(), m.logViewport.Width)
				m.logViewport.SetContent(content)
				if m.autoScroll {
					m.logViewport.GotoBottom()
				}
			}
			if m.logSubCh != nil {
				cmds = append(cmds, waitForLogLine(m.logSubName, m.logSubCh))
			}
		}
		return m, tea.Batch(cmds...)

	case tea.KeyMsg:
		switch m.focus {
		case focusList:
			return m.updateList(msg)
		case focusLogs:
			return m.updateLogs(msg)
		}
	}

	return m, nil
}

// updateList handles key events when the list panel is focused
func (m dashboardModel) updateList(msg tea.KeyMsg) (dashboardModel, tea.Cmd) {
	prevSelected := m.selected

	switch msg.String() {
	case "up", "k":
		if m.selected > 0 {
			m.selected--
		}
	case "down", "j":
		if m.selected < len(m.processes)-1 {
			m.selected++
		}
	case "tab":
		m.focus = focusLogs
		return m, nil
	}

	if m.selected != prevSelected {
		cmd := m.SubscribeToSelected()
		return m, cmd
	}

	return m, nil
}

// updateLogs handles key events when the log panel is focused
func (m dashboardModel) updateLogs(msg tea.KeyMsg) (dashboardModel, tea.Cmd) {
	// When visual selection is active, handle selection keys
	if m.selection.isActive() {
		return m.handleLogsSelectionKey(msg)
	}
	// When search input is active, route keys there first
	if m.search.mode == searchInput {
		return m.updateLogsSearchInput(msg)
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
	case "tab":
		m.focus = focusList
		return m, nil
	case "G":
		m.logViewport.GotoBottom()
		m.autoScroll = true
		return m, nil
	case "g":
		m.logViewport.GotoTop()
		m.autoScroll = false
		return m, nil
	case "c":
		if m.ready {
			return m, copyVisibleLines(m.logViewport.View())
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
		if m.logBuf != nil && m.ready {
			m.search.deactivate()
			content := wrapLogContent(m.logBuf.Content(), m.logViewport.Width)
			m.selection.activate(m.logViewport, content)
			m.selection.applyToViewport(&m.logViewport)
			return m, nil
		}
		return m, nil
	case "i":
		sel := m.SelectedProcess()
		if sel != nil && sel.PtyFile != nil {
			m.isInteractive = true
			m.refreshInteractiveViewport()
			return m, scheduleInteractiveTick()
		}
		return m, nil
	}

	prevOffset := m.logViewport.YOffset
	var cmd tea.Cmd
	m.logViewport, cmd = m.logViewport.Update(msg)

	if m.logViewport.YOffset < prevOffset {
		m.autoScroll = false
	}
	if m.logViewport.AtBottom() {
		m.autoScroll = true
	}

	return m, cmd
}

// updateLogsSearchInput handles key events when the search text input is active
func (m dashboardModel) updateLogsSearchInput(msg tea.KeyMsg) (dashboardModel, tea.Cmd) {
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
	// Update viewport with filtered content
	m.applySearchFilter()
	return m, cmd
}

// handleLogsSelectionKey processes keys during visual selection mode in dashboard
func (m dashboardModel) handleLogsSelectionKey(msg tea.KeyMsg) (dashboardModel, tea.Cmd) {
	// Allow tab to exit selection and switch panel
	if msg.String() == "tab" {
		m.selection.deactivate()
		m.refreshLogViewport()
		m.focus = focusList
		return m, nil
	}

	action := m.selection.handleKey(msg.String(), m.logViewport.Height)
	switch action {
	case selActionMoved:
		m.selection.applyToViewport(&m.logViewport)
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
func (m *dashboardModel) applySearchFilter() {
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
	wrapped := wrapLogContent(content, m.logViewport.Width)
	m.logViewport.SetContent(wrapped)
	m.logViewport.GotoBottom()
}

// refreshLogViewport restores the full (unfiltered) log content in the viewport
func (m *dashboardModel) refreshLogViewport() {
	if m.logBuf == nil || !m.ready {
		return
	}
	content := wrapLogContent(m.logBuf.Content(), m.logViewport.Width)
	m.logViewport.SetContent(content)
	if m.autoScroll {
		m.logViewport.GotoBottom()
	}
}

// refreshInteractiveViewport renders VTerm screen content into the viewport
func (m *dashboardModel) refreshInteractiveViewport() {
	sel := m.SelectedProcess()
	if sel == nil || sel.VTerm == nil {
		return
	}
	content := sel.VTerm.Content()
	m.logViewport.SetContent(content)
	m.logViewport.GotoBottom()
}

// initViewport sets up or resizes the log viewport
func (m *dashboardModel) initViewport() {
	// Cancel selection on resize (frozen content invalid after re-wrap)
	m.selection.deactivate()

	_, rightW := m.panelWidths()
	vpH := m.height - 3 // title + help bar + border
	if vpH < 1 {
		vpH = 1
	}
	vpW := rightW - 2 // borders
	if vpW < 1 {
		vpW = 1
	}

	if !m.ready {
		m.logViewport = viewport.New(vpW, vpH)
		m.ready = true
	} else {
		m.logViewport.Width = vpW
		m.logViewport.Height = vpH
	}
}

// panelWidths calculates left and right panel widths
func (m dashboardModel) panelWidths() (int, int) {
	leftW := m.width / 3
	if leftW < 20 {
		leftW = 20
	}
	rightW := m.width - leftW
	if rightW < 10 {
		rightW = 10
	}
	return leftW, rightW
}

// View renders the split-pane dashboard
func (m dashboardModel) View() string {
	if m.width == 0 || m.height == 0 {
		return "Initializing..."
	}

	leftW, rightW := m.panelWidths()
	helpH := 1
	contentH := m.height - helpH

	// Left panel: session list
	leftPanel := m.renderSessionList(leftW, contentH)

	// Right panel: log preview
	rightPanel := m.renderLogPanel(rightW, contentH)

	// Join panels horizontally
	body := lipgloss.JoinHorizontal(lipgloss.Top, leftPanel, rightPanel)

	// Help bar
	help := m.renderHelpBar()

	return lipgloss.JoinVertical(lipgloss.Left, body, help)
}

// renderSessionList renders the left panel with session list
func (m dashboardModel) renderSessionList(w, h int) string {
	innerW := w - 2
	if innerW < 1 {
		innerW = 1
	}
	innerH := h - 2
	if innerH < 1 {
		innerH = 1
	}

	focused := m.focus == focusList

	var lines []string
	if len(m.processes) == 0 {
		lines = append(lines, dimStyle.Render("No active sessions"))
		lines = append(lines, "")
		lines = append(lines, dimStyle.Render("Press n to launch"))
	} else {
		for i, rp := range m.processes {
			item := m.renderSessionItem(i, rp, innerW)
			// Item may contain multiple lines (e.g. tunnel info)
			for _, l := range strings.Split(item, "\n") {
				lines = append(lines, l)
			}
		}
	}

	// Pad/trim to exact innerH lines
	for len(lines) < innerH {
		lines = append(lines, "")
	}
	if len(lines) > innerH {
		lines = lines[:innerH]
	}

	// Build panel: top border with title + body lines + bottom border
	var b strings.Builder
	b.WriteString(buildTopBorder(" Sessions ", innerW, focused))
	b.WriteByte('\n')
	for _, line := range lines {
		b.WriteString(buildBodyLine(line, innerW, focused))
		b.WriteByte('\n')
	}
	b.WriteString(buildBottomBorder(innerW, focused))

	return b.String()
}

// renderSessionItem renders a single session item in the list
func (m dashboardModel) renderSessionItem(idx int, rp *process.RunningProcess, width int) string {
	isSelected := idx == m.selected

	// Status indicator
	var statusIcon string
	switch rp.Status {
	case process.StatusRunning:
		statusIcon = statusRunning.Render("*")
	case process.StatusStopped:
		statusIcon = statusStopped.Render("-")
	case process.StatusError:
		statusIcon = statusError.Render("!")
	}

	// Cursor
	cursor := "  "
	if isSelected {
		cursor = "> "
	}

	// Name
	name := rp.Info.Name
	nameStyle := normalItemStyle
	if isSelected {
		nameStyle = selectedItemStyle
	}

	// Port and age
	port := portStyle.Render(fmt.Sprintf(":%d", rp.Info.Port))
	age := ageStyle.Render(formatAge(rp.StartedAt))

	line := fmt.Sprintf("%s%s %s  %s  %s",
		cursor,
		statusIcon,
		nameStyle.Render(name),
		port,
		age,
	)

	// Truncate if too wide (ANSI-safe via lipgloss MaxWidth)
	if lipgloss.Width(line) > width {
		line = lipgloss.NewStyle().MaxWidth(width).Render(line)
	}

	// Tunnel info as second line
	if rp.Tunnel != nil {
		var tunnelLine string
		switch rp.Tunnel.Status {
		case process.TunnelStarting:
			tunnelLine = "     " + dimStyle.Render("tunnel: starting...")
		case process.TunnelActive:
			tunnelLine = "     " + tunnelURLStyle.Render("tunnel: "+rp.Tunnel.URL)
		case process.TunnelError:
			tunnelLine = "     " + statusError.Render("tunnel: error")
		}
		if tunnelLine != "" {
			if lipgloss.Width(tunnelLine) > width {
				tunnelLine = lipgloss.NewStyle().MaxWidth(width).Render(tunnelLine)
			}
			line += "\n" + tunnelLine
		}
	}

	return line
}

// renderLogPanel renders the right panel with log viewport
func (m dashboardModel) renderLogPanel(w, h int) string {
	innerW := w - 2
	if innerW < 1 {
		innerW = 1
	}
	innerH := h - 2
	if innerH < 1 {
		innerH = 1
	}

	focused := m.focus == focusLogs

	title := " Logs "
	sel := m.SelectedProcess()
	if sel != nil {
		title = fmt.Sprintf(" Logs: %s ", sel.Info.Name)
	}

	// Reserve 1 line for selection or search bar when active
	barH := 0
	if m.selection.isActive() || m.search.isActive() {
		barH = 1
	}
	logH := innerH - barH

	// Get content lines from viewport or placeholder
	var contentLines []string
	if sel == nil {
		contentLines = []string{dimStyle.Render("Select a session to view logs")}
	} else if m.ready {
		vpContent := m.logViewport.View()
		contentLines = strings.Split(vpContent, "\n")
	} else {
		contentLines = []string{"Loading..."}
	}

	// Pad/trim to exact logH lines
	for len(contentLines) < logH {
		contentLines = append(contentLines, "")
	}
	if len(contentLines) > logH {
		contentLines = contentLines[:logH]
	}

	// Build panel: top border with title + body lines + search bar + bottom border
	var b strings.Builder
	b.WriteString(buildTopBorder(title, innerW, focused))
	b.WriteByte('\n')
	for _, line := range contentLines {
		b.WriteString(buildBodyLine(line, innerW, focused))
		b.WriteByte('\n')
	}
	if m.selection.isActive() {
		selBar := m.selection.renderStatusBar(innerW)
		b.WriteString(buildBodyLine(selBar, innerW, focused))
		b.WriteByte('\n')
	} else if m.search.isActive() {
		searchBar := m.search.renderSearchBar(innerW)
		b.WriteString(buildBodyLine(searchBar, innerW, focused))
		b.WriteByte('\n')
	}
	b.WriteString(buildBottomBorder(innerW, focused))

	return b.String()
}

// renderHelpBar renders the bottom help bar
func (m dashboardModel) renderHelpBar() string {
	keys := []struct{ key, desc string }{
		{"n", "new"},
		{"k", "kill"},
		{"r", "restart"},
		{"t", "tunnel"},
		{"enter", "fullscreen"},
		{"tab", "switch"},
		{"s", "settings"},
		{"q", "quit"},
	}

	// Show copy tunnel URL key when selected process has an active tunnel
	sel := m.SelectedProcess()
	if sel != nil && sel.Tunnel != nil && sel.Tunnel.URL != "" {
		keys = append(keys[:4], append([]struct{ key, desc string }{{"u", "copy url"}}, keys[4:]...)...)
	}

	// Show copy and search keys when log panel is focused
	if m.focus == focusLogs {
		if m.isInteractive {
			keys = []struct{ key, desc string }{
				{"INTERACTIVE", ""},
				{"Ctrl+]", "exit"},
			}
		} else if m.selection.isActive() {
			keys = []struct{ key, desc string }{
				{"j/k", "move"},
				{"G/g", "top/bottom"},
				{"y", "copy"},
				{"esc", "cancel"},
			}
		} else {
			keys = append(keys, struct{ key, desc string }{"c", "copy"})
			keys = append(keys, struct{ key, desc string }{"y", "copy all"})
			keys = append(keys, struct{ key, desc string }{"v", "select"})
			keys = append(keys, struct{ key, desc string }{"/", "search"})
			keys = append(keys, struct{ key, desc string }{"i", "interactive"})
		}
	}

	var parts []string
	for _, k := range keys {
		parts = append(parts, helpKeyStyle.Render(k.key)+":"+helpDescStyle.Render(k.desc))
	}

	// Append clipboard feedback if present
	if m.clipboardMsg != "" {
		parts = append(parts, helpKeyStyle.Render(m.clipboardMsg))
	}

	// Append tunnel feedback if present
	if m.tunnelFeedback != "" {
		parts = append(parts, helpKeyStyle.Render(m.tunnelFeedback))
	}

	bar := strings.Join(parts, "  ")
	return helpStyle.Width(m.width).Render(bar)
}

// buildTopBorder constructs a top border line with an embedded title.
// Uses ANSI-safe rendering (no byte-level string slicing).
func buildTopBorder(title string, innerW int, focused bool) string {
	color := colorGray
	if focused {
		color = colorBlue
	}
	bc := lipgloss.NewStyle().Foreground(color)
	titleStr := titleStyle.Render(title)
	titleW := lipgloss.Width(titleStr)
	fillW := innerW - titleW - 1 // -1 for the dash before title
	if fillW < 0 {
		fillW = 0
	}
	return bc.Render("╭─") + titleStr + bc.Render(strings.Repeat("─", fillW)+"╮")
}

// buildBottomBorder constructs a bottom border line
func buildBottomBorder(innerW int, focused bool) string {
	color := colorGray
	if focused {
		color = colorBlue
	}
	bc := lipgloss.NewStyle().Foreground(color)
	return bc.Render("╰" + strings.Repeat("─", innerW) + "╯")
}

// buildBodyLine wraps a content line with side borders and padding
func buildBodyLine(line string, innerW int, focused bool) string {
	color := colorGray
	if focused {
		color = colorBlue
	}
	bc := lipgloss.NewStyle().Foreground(color)
	pad := innerW - lipgloss.Width(line)
	if pad < 0 {
		pad = 0
	}
	return bc.Render("│") + line + strings.Repeat(" ", pad) + bc.Render("│")
}

// wrapLogContent wraps long lines in log content to fit within maxWidth.
// Uses ANSI-aware word wrapping so escape codes are preserved.
func wrapLogContent(content string, maxWidth int) string {
	if maxWidth <= 0 {
		return content
	}
	return ansi.Wordwrap(content, maxWidth, "")
}

// formatAge formats a duration since a time as a human-readable string
func formatAge(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		h := int(d.Hours())
		m := int(d.Minutes()) % 60
		if m > 0 {
			return fmt.Sprintf("%dh%dm", h, m)
		}
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
