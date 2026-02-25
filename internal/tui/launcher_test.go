package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/kimaguri/simplx-toolkit/internal/discovery"
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

// --- Launcher model tests ---

func TestLauncher_MoveSelection_StepRepo(t *testing.T) {
	m := launcherModel{
		step: stepRepo,
		mainRepos: []discovery.Worktree{
			{Name: "repo1"},
			{Name: "repo2"},
			{Name: "repo3"},
		},
		repoIndex: 0,
	}

	m.moveSelection(1)
	if m.repoIndex != 1 {
		t.Errorf("expected repoIndex=1, got %d", m.repoIndex)
	}

	m.moveSelection(1)
	if m.repoIndex != 2 {
		t.Errorf("expected repoIndex=2, got %d", m.repoIndex)
	}

	// Should clamp at upper bound
	m.moveSelection(1)
	if m.repoIndex != 2 {
		t.Errorf("expected repoIndex=2 (clamped), got %d", m.repoIndex)
	}

	// Move back up
	m.moveSelection(-1)
	if m.repoIndex != 1 {
		t.Errorf("expected repoIndex=1 after moving up, got %d", m.repoIndex)
	}

	// Clamp at lower bound
	m.repoIndex = 0
	m.moveSelection(-1)
	if m.repoIndex != 0 {
		t.Errorf("expected repoIndex=0 (clamped), got %d", m.repoIndex)
	}
}

func TestLauncher_MoveSelection_StepDirectory(t *testing.T) {
	m := launcherModel{
		step: stepDirectory,
		directories: []discovery.Worktree{
			{Name: "main-dir", IsWorktree: false},
			{Name: "wt1", IsWorktree: true},
			{Name: "wt2", IsWorktree: true},
		},
		dirIndex: 0,
	}

	m.moveSelection(1)
	if m.dirIndex != 1 {
		t.Errorf("expected dirIndex=1, got %d", m.dirIndex)
	}

	m.moveSelection(1)
	if m.dirIndex != 2 {
		t.Errorf("expected dirIndex=2, got %d", m.dirIndex)
	}

	// Clamp at upper bound
	m.moveSelection(1)
	if m.dirIndex != 2 {
		t.Errorf("expected dirIndex=2 (clamped), got %d", m.dirIndex)
	}

	// Clamp at lower bound
	m.dirIndex = 0
	m.moveSelection(-1)
	if m.dirIndex != 0 {
		t.Errorf("expected dirIndex=0 (clamped), got %d", m.dirIndex)
	}
}

func TestLauncher_MoveSelection_StepModule(t *testing.T) {
	m := launcherModel{
		step: stepModule,
		projects: []discovery.Project{
			{Name: "proj-a"},
			{Name: "proj-b"},
		},
		projIndex: 0,
	}

	m.moveSelection(1)
	if m.projIndex != 1 {
		t.Errorf("expected projIndex=1, got %d", m.projIndex)
	}

	// Clamp at upper bound
	m.moveSelection(1)
	if m.projIndex != 1 {
		t.Errorf("expected projIndex=1 (clamped), got %d", m.projIndex)
	}
}

func TestLauncher_MoveSelection_StepScript(t *testing.T) {
	m := launcherModel{
		step: stepScript,
		scripts: []string{"dev", "start", "build"},
		scriptIndex: 0,
	}

	m.moveSelection(1)
	if m.scriptIndex != 1 {
		t.Errorf("expected scriptIndex=1, got %d", m.scriptIndex)
	}

	m.moveSelection(1)
	if m.scriptIndex != 2 {
		t.Errorf("expected scriptIndex=2, got %d", m.scriptIndex)
	}

	// Clamp
	m.moveSelection(1)
	if m.scriptIndex != 2 {
		t.Errorf("expected scriptIndex=2 (clamped), got %d", m.scriptIndex)
	}
}

func TestLauncher_SelectedWorktree_FromDirectories(t *testing.T) {
	m := launcherModel{
		directories: []discovery.Worktree{
			{Name: "main-dir", Branch: "main"},
			{Name: "wt-feature", Branch: "feat/test"},
		},
		dirIndex: 1,
	}

	wt := m.selectedWorktree()
	if wt.Name != "wt-feature" {
		t.Errorf("expected Name=wt-feature, got %s", wt.Name)
	}
	if wt.Branch != "feat/test" {
		t.Errorf("expected Branch=feat/test, got %s", wt.Branch)
	}
}

func TestLauncher_SelectedWorktree_FirstDirectory(t *testing.T) {
	m := launcherModel{
		directories: []discovery.Worktree{
			{Name: "main-dir", Branch: "main"},
			{Name: "wt1", Branch: "feat/a"},
		},
		dirIndex: 0,
	}

	wt := m.selectedWorktree()
	if wt.Name != "main-dir" {
		t.Errorf("expected Name=main-dir, got %s", wt.Name)
	}
	if wt.Branch != "main" {
		t.Errorf("expected Branch=main, got %s", wt.Branch)
	}
}

func TestLauncher_SelectedWorktree_FallbackToMainRepos(t *testing.T) {
	m := launcherModel{
		directories: nil, // empty directories
		mainRepos: []discovery.Worktree{
			{Name: "fallback-repo", Branch: "main"},
		},
		repoIndex: 0,
	}

	wt := m.selectedWorktree()
	if wt.Name != "fallback-repo" {
		t.Errorf("expected Name=fallback-repo, got %s", wt.Name)
	}
}

func TestLauncher_SelectedWorktree_EmptyModel(t *testing.T) {
	m := launcherModel{}

	wt := m.selectedWorktree()
	if wt.Name != "" {
		t.Errorf("expected empty Worktree, got Name=%s", wt.Name)
	}
}

func TestLauncher_EscFromModule_SkipsDirectoryWhenAutoSkipped(t *testing.T) {
	// When directories has only 1 entry (main dir), directory step was auto-skipped.
	// Pressing Esc from stepModule should go back to stepRepo, not stepDirectory.
	m := launcherModel{
		step: stepModule,
		directories: []discovery.Worktree{
			{Name: "only-main"},
		},
	}

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if updated.step != stepRepo {
		t.Errorf("expected stepRepo after Esc from auto-skipped module, got step=%d", updated.step)
	}
}

func TestLauncher_EscFromModule_GoesToDirectoryWhenNotSkipped(t *testing.T) {
	// When directories has >1 entry, directory step was NOT auto-skipped.
	// Pressing Esc from stepModule should go back to stepDirectory.
	m := launcherModel{
		step: stepModule,
		directories: []discovery.Worktree{
			{Name: "main-dir"},
			{Name: "wt1"},
		},
	}

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if updated.step != stepDirectory {
		t.Errorf("expected stepDirectory after Esc from module with worktrees, got step=%d", updated.step)
	}
}

func TestLauncher_EscFromRepo_EmitsCancelMsg(t *testing.T) {
	// Pressing Esc at stepRepo should emit cancelLauncherMsg
	m := launcherModel{
		step: stepRepo,
	}

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if cmd == nil {
		t.Fatal("expected non-nil cmd for cancel")
	}

	msg := cmd()
	if _, ok := msg.(cancelLauncherMsg); !ok {
		t.Errorf("expected cancelLauncherMsg, got %T", msg)
	}
}

func TestLauncher_EscFromScript_GoesToModule(t *testing.T) {
	m := launcherModel{
		step: stepScript,
	}

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if updated.step != stepModule {
		t.Errorf("expected stepModule after Esc from script, got step=%d", updated.step)
	}
}

func TestLauncher_EscFromPort_SkipsScriptForEncoreNoScripts(t *testing.T) {
	// When project is Encore with no scripts, Esc from Port should skip Script
	// and go directly to Module.
	m := launcherModel{
		step:      stepPort,
		projIndex: 0,
		projects: []discovery.Project{
			{Name: "encore-proj", IsEncore: true, Scripts: nil},
		},
	}

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if updated.step != stepModule {
		t.Errorf("expected stepModule after Esc from port (Encore no scripts), got step=%d", updated.step)
	}
}

func TestLauncher_EscFromPort_GoesToScript_NormalProject(t *testing.T) {
	// Normal project with scripts: Esc from Port goes to Script
	m := launcherModel{
		step:      stepPort,
		projIndex: 0,
		projects: []discovery.Project{
			{Name: "node-proj", Scripts: []string{"dev", "start"}},
		},
	}

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if updated.step != stepScript {
		t.Errorf("expected stepScript after Esc from port, got step=%d", updated.step)
	}
}

func TestLauncher_StepIndicator_SkipsDirectoryWhenAutoSkipped(t *testing.T) {
	// When directories <= 1, the step indicator should NOT contain "Directory"
	m := launcherModel{
		step: stepModule,
		directories: []discovery.Worktree{
			{Name: "only-main"},
		},
	}

	indicator := m.renderStepIndicator()
	if strings.Contains(indicator, "Directory") {
		t.Errorf("step indicator should not contain 'Directory' when auto-skipped, got: %s", indicator)
	}
}

func TestLauncher_StepIndicator_ShowsDirectoryWhenPresent(t *testing.T) {
	// When directories > 1, the step indicator should contain "Directory"
	m := launcherModel{
		step: stepDirectory,
		directories: []discovery.Worktree{
			{Name: "main-dir"},
			{Name: "wt1"},
		},
	}

	indicator := m.renderStepIndicator()
	if !strings.Contains(indicator, "Directory") {
		t.Errorf("step indicator should contain 'Directory' when worktrees present, got: %s", indicator)
	}
}

func TestLauncher_UpDownKeys_Navigate(t *testing.T) {
	m := launcherModel{
		step: stepRepo,
		mainRepos: []discovery.Worktree{
			{Name: "repo1"},
			{Name: "repo2"},
			{Name: "repo3"},
		},
		repoIndex: 0,
	}

	// "j" key moves down
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if updated.repoIndex != 1 {
		t.Errorf("expected repoIndex=1 after 'j', got %d", updated.repoIndex)
	}

	// "k" key moves up
	updated, _ = updated.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if updated.repoIndex != 0 {
		t.Errorf("expected repoIndex=0 after 'k', got %d", updated.repoIndex)
	}

	// "down" arrow key
	updated, _ = updated.Update(tea.KeyMsg{Type: tea.KeyDown})
	if updated.repoIndex != 1 {
		t.Errorf("expected repoIndex=1 after down arrow, got %d", updated.repoIndex)
	}

	// "up" arrow key
	updated, _ = updated.Update(tea.KeyMsg{Type: tea.KeyUp})
	if updated.repoIndex != 0 {
		t.Errorf("expected repoIndex=0 after up arrow, got %d", updated.repoIndex)
	}
}
