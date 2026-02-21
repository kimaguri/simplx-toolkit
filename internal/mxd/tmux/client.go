package tmux

import (
	"fmt"
	"strconv"

	"github.com/GianlucaP106/gotmux/gotmux"
)

// Client wraps gotmux with all operations mxd needs.
type Client struct {
	tmux *gotmux.Tmux
}

// NewClient creates a tmux client.
func NewClient() (*Client, error) {
	t, err := gotmux.DefaultTmux()
	if err != nil {
		return nil, fmt.Errorf("init tmux: %w", err)
	}
	return &Client{tmux: t}, nil
}

// NewSession creates a tmux session.
func (c *Client) NewSession(name string) (*gotmux.Session, error) {
	s, err := c.tmux.NewSession(&gotmux.SessionOptions{
		Name: name,
	})
	if err != nil {
		return nil, fmt.Errorf("create session %q: %w", name, err)
	}
	return s, nil
}

// KillSession destroys a tmux session by name.
// Returns nil if the session does not exist.
func (c *Client) KillSession(name string) error {
	s, err := c.tmux.GetSessionByName(name)
	if err != nil {
		// Session not found is not an error for kill operation
		return nil
	}
	if s == nil {
		return nil
	}
	return s.Kill()
}

// SplitPane splits a pane. vertical=false means side-by-side (horizontal split).
func (c *Client) SplitPane(pane *gotmux.Pane, vertical bool, startDir string) (*gotmux.Pane, error) {
	dir := gotmux.PaneSplitDirectionHorizontal
	if vertical {
		dir = gotmux.PaneSplitDirectionVertical
	}
	err := pane.SplitWindow(&gotmux.SplitWindowOptions{
		SplitDirection: dir,
		StartDirectory: startDir,
	})
	if err != nil {
		return nil, fmt.Errorf("split pane: %w", err)
	}
	// After split, fetch the updated pane to get the new sibling
	newPane, err := c.tmux.GetPaneById(pane.Id)
	if err != nil {
		return nil, fmt.Errorf("get pane after split: %w", err)
	}
	return newPane, nil
}

// SendKeys sends keystrokes to a pane.
func (c *Client) SendKeys(pane *gotmux.Pane, keys string) error {
	return pane.SendKeys(keys)
}

// CapturePane reads the visible content of a pane.
func (c *Client) CapturePane(pane *gotmux.Pane) (string, error) {
	return pane.Capture()
}

// KillPane destroys a single pane.
func (c *Client) KillPane(pane *gotmux.Pane) error {
	return pane.Kill()
}

// ResizePane sets the width and height of a pane via Command() escape hatch.
func (c *Client) ResizePane(pane *gotmux.Pane, width, height int) error {
	id := pane.Id
	if width > 0 {
		_, err := c.tmux.Command("resize-pane", "-t", id, "-x", strconv.Itoa(width))
		if err != nil {
			return fmt.Errorf("resize width: %w", err)
		}
	}
	if height > 0 {
		_, err := c.tmux.Command("resize-pane", "-t", id, "-y", strconv.Itoa(height))
		if err != nil {
			return fmt.Errorf("resize height: %w", err)
		}
	}
	return nil
}

// HasSession checks if a tmux session with the given name exists.
func (c *Client) HasSession(name string) bool {
	return c.tmux.HasSession(name)
}

// GetSessionPanes returns all panes in a session's first window.
func (c *Client) GetSessionPanes(name string) ([]*gotmux.Pane, error) {
	s, err := c.tmux.GetSessionByName(name)
	if err != nil {
		return nil, fmt.Errorf("session %q not found: %w", name, err)
	}
	windows, err := s.ListWindows()
	if err != nil {
		return nil, err
	}
	if len(windows) == 0 {
		return nil, nil
	}
	return windows[0].ListPanes()
}
