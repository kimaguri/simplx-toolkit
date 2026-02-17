package tui

import "github.com/charmbracelet/lipgloss"

// Color palette
var (
	colorGreen   = lipgloss.Color("#00FF00")
	colorRed     = lipgloss.Color("#FF4444")
	colorYellow  = lipgloss.Color("#FFAA00")
	colorBlue    = lipgloss.Color("#5599FF")
	colorGray    = lipgloss.Color("#666666")
	colorWhite   = lipgloss.Color("#FFFFFF")
	colorDimWhite = lipgloss.Color("#AAAAAA")
	colorBg      = lipgloss.Color("#1A1A2E")
	colorModalBg = lipgloss.Color("#16213E")
)

// Border styles
var (
	focusedBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBlue)

	unfocusedBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorGray)
)

// Status indicator styles
var (
	statusRunning = lipgloss.NewStyle().
			Foreground(colorGreen).
			Bold(true)

	statusStopped = lipgloss.NewStyle().
			Foreground(colorYellow)

	statusError = lipgloss.NewStyle().
			Foreground(colorRed).
			Bold(true)
)

// Title bar style
var titleStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(colorWhite).
	Background(colorBlue).
	Padding(0, 1)

// Help bar style
var helpStyle = lipgloss.NewStyle().
	Foreground(colorDimWhite).
	Background(lipgloss.Color("#0E1525")).
	Padding(0, 1)

// Help key style
var helpKeyStyle = lipgloss.NewStyle().
	Foreground(colorBlue).
	Bold(true)

// Help description style
var helpDescStyle = lipgloss.NewStyle().
	Foreground(colorDimWhite)

// Modal overlay style
var modalStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(colorBlue).
	Background(colorModalBg).
	Padding(1, 2)

// Modal title style
var modalTitleStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(colorWhite)

// Button styles
var (
	activeButtonStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(colorWhite).
				Background(colorBlue).
				Padding(0, 2)

	inactiveButtonStyle = lipgloss.NewStyle().
				Foreground(colorDimWhite).
				Background(colorGray).
				Padding(0, 2)
)

// List item styles
var (
	selectedItemStyle = lipgloss.NewStyle().
				Foreground(colorWhite).
				Bold(true)

	normalItemStyle = lipgloss.NewStyle().
			Foreground(colorDimWhite)
)

// Dim text
var dimStyle = lipgloss.NewStyle().
	Foreground(colorGray)

// Port style
var portStyle = lipgloss.NewStyle().
	Foreground(colorYellow)

// Age style
var ageStyle = lipgloss.NewStyle().
	Foreground(colorGray)

// Section header style
var sectionStyle = lipgloss.NewStyle().
	Foreground(colorBlue).
	Bold(true)

// Selection highlight style — selected lines background
var selectionHighlightStyle = lipgloss.NewStyle().
	Background(lipgloss.Color("#1E3A5F")).Foreground(colorWhite)

// Selection cursor style — current cursor line (brighter)
var selectionCursorStyle = lipgloss.NewStyle().
	Background(lipgloss.Color("#2E5A8F")).Foreground(colorWhite).Bold(true)

// Selection status bar style
var selectionBarStyle = lipgloss.NewStyle().
	Background(lipgloss.Color("#1E3A5F")).Foreground(colorWhite).
	Bold(true).Padding(0, 1)

// Search highlight style — yellow background, black foreground for matched text
var searchHighlightStyle = lipgloss.NewStyle().
	Background(colorYellow).
	Foreground(lipgloss.Color("#000000")).
	Bold(true)

// Search bar style — background strip for the search input area
var searchBarStyle = lipgloss.NewStyle().
	Background(lipgloss.Color("#0E1525")).
	Padding(0, 1)

// Search match count style — dim text showing match count
var searchCountStyle = lipgloss.NewStyle().
	Foreground(colorGray)

// Search prompt style — styled "/" prompt
var searchPromptStyle = lipgloss.NewStyle().
	Foreground(colorYellow).
	Bold(true)
