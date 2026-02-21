package tmux

import (
	"os/exec"
	"strings"
	"testing"
)

func hasTmux() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

func TestNewSessionAndKill(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	c, err := NewClient()
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	sessionName := "mxd-test-session"
	_ = c.KillSession(sessionName)

	sess, err := c.NewSession(sessionName)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if sess.Name != sessionName {
		t.Errorf("session name = %q, want %q", sess.Name, sessionName)
	}
	if !c.HasSession(sessionName) {
		t.Error("HasSession returned false, want true")
	}

	panes, err := c.GetSessionPanes(sessionName)
	if err != nil {
		t.Fatalf("GetSessionPanes: %v", err)
	}
	if len(panes) < 1 {
		t.Fatal("expected at least 1 pane")
	}

	newPane, err := c.SplitPane(panes[0], false, "")
	if err != nil {
		t.Fatalf("SplitPane: %v", err)
	}

	err = c.SendKeys(newPane, "echo hello")
	if err != nil {
		t.Fatalf("SendKeys: %v", err)
	}

	content, err := c.CapturePane(newPane)
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	_ = strings.Contains(content, "hello")

	if err := c.KillSession(sessionName); err != nil {
		t.Fatalf("KillSession: %v", err)
	}
	if c.HasSession(sessionName) {
		t.Error("session still exists after kill")
	}
}
