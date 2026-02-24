package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const (
	phaseReview = 0
	phaseApply  = 1
	phaseDone   = 2
)

// WizardCheck represents a single environment check.
type WizardCheck struct {
	Label   string       // "Global config"
	Detail  string       // "~/.config/maomao/config.toml"
	OK      bool         // passed?
	Fixable bool         // can auto-fix?
	Fix     func() error // closure to apply fix (nil if not fixable)
}

// WizardDoneMsg signals the wizard phase is complete.
type WizardDoneMsg struct {
	Applied bool
}

type wizardModel struct {
	checks   []WizardCheck
	phase    int // phaseReview, phaseApply, phaseDone
	fixIndex int
	fixErr   error
	applied  bool
	width    int
	height   int
}

type fixDoneMsg struct {
	index int
	err   error
}

func newWizardModel(checks []WizardCheck) wizardModel {
	return wizardModel{
		checks: checks,
		phase:  phaseReview,
	}
}

func (w wizardModel) Update(msg tea.Msg) (wizardModel, tea.Cmd) {
	switch msg := msg.(type) {
	case fixDoneMsg:
		if msg.err != nil {
			w.fixErr = msg.err
		} else {
			w.checks[msg.index].OK = true
		}
		w.fixIndex = msg.index + 1
		if cmd := w.runNextFix(); cmd != nil {
			return w, cmd
		}
		w.phase = phaseDone
		w.applied = true
		return w, nil

	case tea.KeyMsg:
		switch w.phase {
		case phaseReview:
			switch msg.String() {
			case "enter":
				w.phase = phaseApply
				if cmd := w.runNextFix(); cmd != nil {
					return w, cmd
				}
				w.phase = phaseDone
				w.applied = true
				return w, nil
			case "q", "esc", "ctrl+c":
				return w, func() tea.Msg { return WizardDoneMsg{Applied: false} }
			}
		case phaseDone:
			return w, func() tea.Msg { return WizardDoneMsg{Applied: w.applied} }
		}
	}
	return w, nil
}

func (w wizardModel) runNextFix() tea.Cmd {
	for i := w.fixIndex; i < len(w.checks); i++ {
		c := w.checks[i]
		if !c.OK && c.Fixable && c.Fix != nil {
			idx := i
			fix := c.Fix
			return func() tea.Msg {
				err := fix()
				return fixDoneMsg{index: idx, err: err}
			}
		}
	}
	return nil
}

func (w wizardModel) View() string {
	okSt := lipgloss.NewStyle().Foreground(catGreen).Bold(true)
	failSt := lipgloss.NewStyle().Foreground(catRed).Bold(true)
	headSt := lipgloss.NewStyle().Bold(true).Foreground(catWhite)
	fixSt := lipgloss.NewStyle().Foreground(catYellow)
	labelSt := lipgloss.NewStyle().Foreground(catWhite)
	detailSt := lipgloss.NewStyle().Foreground(catGray)
	helpKey := lipgloss.NewStyle().Foreground(catBlue).Bold(true)
	helpDesc := lipgloss.NewStyle().Foreground(catDimWhite)

	header := headSt.Render("maomao — environment check")

	var lines []string
	for _, c := range w.checks {
		var mark, label, detail string
		label = labelSt.Render(c.Label)
		if c.OK {
			mark = okSt.Render("✓")
			if w.phase >= phaseDone && c.Fixable {
				detail = okSt.Render("created")
			} else {
				detail = detailSt.Render(c.Detail)
			}
		} else {
			mark = failSt.Render("✗")
			detail = detailSt.Render(c.Detail)
		}
		lines = append(lines, fmt.Sprintf("  %s %-16s %s", mark, label, detail))
		if !c.OK && c.Fixable && w.phase == phaseReview {
			lines = append(lines, fmt.Sprintf("    %s", fixSt.Render("→ will create")))
		}
	}

	var footer string
	switch w.phase {
	case phaseReview:
		footer = helpKey.Render("[enter]") + helpDesc.Render(" apply fixes  ") +
			helpKey.Render("[q]") + helpDesc.Render(" skip")
	case phaseApply:
		footer = fixSt.Render("applying fixes...")
	case phaseDone:
		if w.fixErr != nil {
			footer = failSt.Render(fmt.Sprintf("error: %v", w.fixErr)) + "\n" +
				helpKey.Render("[any key]") + helpDesc.Render(" continue")
		} else {
			footer = okSt.Render("all fixes applied") + "\n" +
				helpKey.Render("[any key]") + helpDesc.Render(" continue")
		}
	}

	body := strings.Join(lines, "\n")
	content := fmt.Sprintf("%s\n\n%s\n\n%s", header, body, footer)

	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(catBlue).
		Background(catModalBg).
		Padding(1, 3).
		Render(content)
}

// WizardApp is a standalone tea.Model wrapper around wizardModel for use
// outside of HomeApp (e.g. when running the wizard before workspace).
type WizardApp struct {
	wizard wizardModel
	width  int
	height int
}

// NewWizardApp creates a standalone wizard tea.Model.
func NewWizardApp(checks []WizardCheck) *WizardApp {
	return &WizardApp{wizard: newWizardModel(checks)}
}

func (w *WizardApp) Init() tea.Cmd { return nil }

func (w *WizardApp) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w.width = msg.Width
		w.height = msg.Height
		w.wizard.width = msg.Width
		w.wizard.height = msg.Height
	case WizardDoneMsg:
		return w, tea.Quit
	}
	var cmd tea.Cmd
	w.wizard, cmd = w.wizard.Update(msg)
	return w, cmd
}

func (w *WizardApp) View() string {
	return lipgloss.NewStyle().
		Width(w.width).Height(w.height).
		Align(lipgloss.Center, lipgloss.Center).
		Render(w.wizard.View())
}
