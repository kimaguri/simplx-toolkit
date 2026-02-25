package tui

import "github.com/charmbracelet/lipgloss"

// --- Base palette (original cat* colors) ---

var (
	catGreen    = lipgloss.Color("#00FF00")
	catRed      = lipgloss.Color("#FF4444")
	catYellow   = lipgloss.Color("#FFAA00")
	catBlue     = lipgloss.Color("#5599FF")
	catGray     = lipgloss.Color("#666666")
	catWhite    = lipgloss.Color("#FFFFFF")
	catDimWhite = lipgloss.Color("#AAAAAA")
	catBg       = lipgloss.Color("#1A1A2E")
	catModalBg  = lipgloss.Color("#16213E")
)

// --- Tokyo Night theme colors (used across sidebar, termpane, diffview) ---

var (
	tnCyan       = lipgloss.Color("#7dcfff") // headers, focused borders
	tnBlue       = lipgloss.Color("#7aa2f7") // selection highlights
	tnPurple     = lipgloss.Color("#bb9af7") // review status, hunks
	tnGreen      = lipgloss.Color("#9ece6a") // done status, diff additions
	tnRed        = lipgloss.Color("#f7768e") // diff deletions
	tnOrange     = lipgloss.Color("#e0af68") // interactive indicator
	tnOrangeBold = lipgloss.Color("#ff9e64") // pane accent orange
	tnFg         = lipgloss.Color("#c0caf5") // primary foreground
	tnFgDark     = lipgloss.Color("#565f89") // unfocused/muted text
	tnBgDark     = lipgloss.Color("#3b4261") // unfocused borders
	tnBgSelected = lipgloss.Color("#1E2D4A") // selected item background
)

// --- Pane border color palette ---

var paneColorPalette = []lipgloss.Color{
	tnBlue,       // #7aa2f7
	tnGreen,      // #9ece6a
	tnPurple,     // #bb9af7
	tnRed,        // #f7768e
	tnOrangeBold, // #ff9e64
	tnCyan,       // #7dcfff
	tnOrange,     // #e0af68
}
