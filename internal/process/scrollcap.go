package process

import (
	"bytes"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// ScrollCapture detects when lines scroll off the top of VTerm and writes
// them to a SegmentedLog. It works by comparing the VTerm's rendered screen
// content after each PTY read chunk with the previous state.
//
// Scroll detection uses plain-text line matching: if the old screen shifted
// up by N lines matches the new screen, N lines were scrolled off. Those N
// lines (with ANSI codes preserved) are written to the history.
//
// To handle bulk output (e.g., build logs with hundreds of lines), ProcessChunk
// splits large raw data into sub-chunks and feeds them to VTerm incrementally,
// capturing scrolled-off lines after each sub-chunk.
type ScrollCapture struct {
	prevPlain []string       // previous render (plain text, for comparison)
	prevAnsi  []string       // previous render (with ANSI, for storage)
	history   *SegmentedLog
	rows      int            // VTerm rows
}

// NewScrollCapture creates a scroll capture tracker for the given VTerm and history log.
func NewScrollCapture(vtermRows int, history *SegmentedLog) *ScrollCapture {
	return &ScrollCapture{
		history: history,
		rows:    vtermRows,
	}
}

// ProcessChunk writes rawData to VTerm in sub-chunks to maximize scroll capture.
// Large chunks are split on newline boundaries so that scroll detection runs
// frequently enough to capture lines that would otherwise scroll through
// the entire screen within a single readPTY read.
func (sc *ScrollCapture) ProcessChunk(vterm *VTermScreen, rawData []byte) {
	// For small chunks (fewer newlines than half the screen), process at once
	nlCount := bytes.Count(rawData, []byte{'\n'})
	batchThreshold := sc.rows / 2
	if batchThreshold < 4 {
		batchThreshold = 4
	}

	if nlCount <= batchThreshold {
		vterm.Write(rawData)
		sc.afterWrite(vterm, rawData)
		return
	}

	// Split on newlines and process in sub-chunks of ~batchThreshold lines
	pieces := bytes.SplitAfter(rawData, []byte{'\n'})
	batch := make([]byte, 0, 4096)
	batchNL := 0

	for _, piece := range pieces {
		batch = append(batch, piece...)
		if bytes.HasSuffix(piece, []byte{'\n'}) {
			batchNL++
		}
		if batchNL >= batchThreshold {
			vterm.Write(batch)
			sc.afterWrite(vterm, batch)
			batch = batch[:0]
			batchNL = 0
		}
	}
	// Process remainder
	if len(batch) > 0 {
		vterm.Write(batch)
		sc.afterWrite(vterm, batch)
	}
}

// afterWrite detects whether the screen scrolled and captures scrolled-off lines.
func (sc *ScrollCapture) afterWrite(vterm *VTermScreen, rawData []byte) {
	currAnsi := vterm.RenderedLines()
	currPlain := make([]string, len(currAnsi))
	for i, line := range currAnsi {
		currPlain[i] = ansi.Strip(line)
	}

	if sc.prevPlain != nil {
		offset := detectScroll(sc.prevPlain, currPlain)

		if offset == 0 {
			// Check for bulk output: many newlines + significant screen change
			// TUI apps redraw using cursor positioning (no newlines), while
			// bulk text output uses newlines to advance the cursor.
			rawLF := bytes.Count(rawData, []byte{'\n'})
			if rawLF >= sc.rows && countChanged(sc.prevPlain, currPlain) > len(currPlain)*2/3 {
				offset = len(sc.prevPlain)
			}
		}

		for i := 0; i < offset && i < len(sc.prevAnsi); i++ {
			line := sc.prevAnsi[i]
			// Skip empty lines at the top (VTerm padding)
			if strings.TrimSpace(ansi.Strip(line)) == "" && i < offset-1 {
				continue
			}
			sc.history.Write([]byte(line + "\n"))
		}
	}

	sc.prevPlain = currPlain
	sc.prevAnsi = currAnsi
}

// SyncState updates the previous screen state from the current VTerm screen
// without performing any scroll detection or capture. Use this when the process
// is in alternate screen mode — data still flows through VTerm (to keep it in
// sync) but we don't want to capture in-place redraws as scrollback.
func (sc *ScrollCapture) SyncState(vterm *VTermScreen) {
	currAnsi := vterm.RenderedLines()
	currPlain := make([]string, len(currAnsi))
	for i, line := range currAnsi {
		currPlain[i] = ansi.Strip(line)
	}
	sc.prevPlain = currPlain
	sc.prevAnsi = currAnsi
}

// Flush writes the current VTerm screen to history. Call this when the
// process exits so the final screen content is preserved in scrollback.
func (sc *ScrollCapture) Flush(vterm *VTermScreen) {
	lines := vterm.RenderedLines()
	for _, line := range lines {
		if strings.TrimSpace(ansi.Strip(line)) == "" {
			continue
		}
		sc.history.Write([]byte(line + "\n"))
	}
	sc.history.Flush()
}

// detectScroll compares two sets of plain-text screen lines to determine
// how many lines scrolled off the top. It tries shifting the old screen
// by different offsets and counting matching lines.
//
// Returns the detected scroll offset (0 = no scroll detected).
func detectScroll(prev, curr []string) int {
	if len(prev) == 0 || len(curr) == 0 {
		return 0
	}

	maxScroll := len(prev) - 1
	if maxScroll > 12 {
		maxScroll = 12
	}

	bestOffset := 0
	bestMatches := 0
	bestCompared := 0

	for offset := 1; offset <= maxScroll; offset++ {
		matches := 0
		compared := 0
		for i := 0; i+offset < len(prev) && i < len(curr); i++ {
			compared++
			if prev[i+offset] == curr[i] {
				matches++
			}
		}
		if compared > 0 && matches > bestMatches {
			bestMatches = matches
			bestOffset = offset
			bestCompared = compared
		}
	}

	if bestCompared == 0 {
		return 0
	}

	// Require at least 25% of compared lines to match, minimum 1
	threshold := bestCompared / 4
	if threshold < 1 {
		threshold = 1
	}
	if bestMatches >= threshold {
		return bestOffset
	}
	return 0
}

// countChanged counts how many lines differ between prev and curr.
func countChanged(prev, curr []string) int {
	changed := 0
	n := len(prev)
	if len(curr) < n {
		n = len(curr)
	}
	for i := 0; i < n; i++ {
		if prev[i] != curr[i] {
			changed++
		}
	}
	// Lines that only exist in one slice count as changed
	if len(prev) > n {
		changed += len(prev) - n
	}
	if len(curr) > n {
		changed += len(curr) - n
	}
	return changed
}
