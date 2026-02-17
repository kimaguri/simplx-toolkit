package process

import (
	"bytes"
	"strings"
	"sync"
)

// DefaultMaxLines is the maximum number of lines kept in the ring buffer
const DefaultMaxLines = 10000

// LogBuffer is a thread-safe ring buffer for log lines.
// It implements io.Writer so it can capture stdout/stderr from a process.
type LogBuffer struct {
	mu       sync.RWMutex
	lines    []string
	maxLines int
	total    int
	subs     []chan string
	partial  string // incomplete line from last Write call
}

// NewLogBuffer creates a new log buffer with the given max line capacity
func NewLogBuffer(maxLines int) *LogBuffer {
	if maxLines <= 0 {
		maxLines = DefaultMaxLines
	}
	return &LogBuffer{
		lines:    make([]string, 0, 256),
		maxLines: maxLines,
	}
}

// Write implements io.Writer. Splits input by newlines and appends each line.
func (lb *LogBuffer) Write(p []byte) (n int, err error) {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	data := lb.partial + string(p)
	lb.partial = ""

	parts := strings.Split(data, "\n")

	// last element is either empty (if data ended with \n) or a partial line
	for i := 0; i < len(parts)-1; i++ {
		lb.appendLine(parts[i])
	}

	// keep the last part as partial (could be empty string if input ended with \n)
	last := parts[len(parts)-1]
	if last != "" {
		lb.partial = last
	}

	return len(p), nil
}

// Flush writes the partial line buffer (if any) as a complete line
func (lb *LogBuffer) Flush() {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	if lb.partial != "" {
		lb.appendLine(lb.partial)
		lb.partial = ""
	}
}

// appendLine adds a line to the buffer and notifies subscribers. Must be called with lock held.
func (lb *LogBuffer) appendLine(line string) {
	if len(lb.lines) >= lb.maxLines {
		copy(lb.lines, lb.lines[1:])
		lb.lines = lb.lines[:lb.maxLines-1]
	}
	lb.lines = append(lb.lines, line)
	lb.total++

	for _, ch := range lb.subs {
		select {
		case ch <- line:
		default:
			// drop if subscriber is slow
		}
	}
}

// Lines returns a copy of all buffered lines, including any partial line
func (lb *LogBuffer) Lines() []string {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	out := make([]string, len(lb.lines))
	copy(out, lb.lines)
	if lb.partial != "" {
		out = append(out, lb.partial)
	}
	return out
}

// Tail returns the last n lines
func (lb *LogBuffer) Tail(n int) []string {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	if n <= 0 {
		return nil
	}
	if n >= len(lb.lines) {
		out := make([]string, len(lb.lines))
		copy(out, lb.lines)
		return out
	}
	out := make([]string, n)
	copy(out, lb.lines[len(lb.lines)-n:])
	return out
}

// Subscribe returns a channel that receives new log lines as they arrive
func (lb *LogBuffer) Subscribe() chan string {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	ch := make(chan string, 256)
	lb.subs = append(lb.subs, ch)
	return ch
}

// Unsubscribe removes a subscription channel.
// The channel is NOT closed here to avoid panic if the process writes after unsubscribe.
// Callers should drain the channel if needed; GC will collect it when no references remain.
func (lb *LogBuffer) Unsubscribe(ch chan string) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	for i, sub := range lb.subs {
		if sub == ch {
			lb.subs = append(lb.subs[:i], lb.subs[i+1:]...)
			return
		}
	}
}

// Content returns all lines joined with newlines, suitable for a viewport.
// Includes the current partial line (text not yet terminated by \n),
// so interactive prompts are visible before the user responds.
func (lb *LogBuffer) Content() string {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	var buf bytes.Buffer
	for i, line := range lb.lines {
		if i > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString(line)
	}
	if lb.partial != "" {
		if buf.Len() > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString(lb.partial)
	}
	return buf.String()
}

// Len returns the number of lines currently in the buffer
func (lb *LogBuffer) Len() int {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	return len(lb.lines)
}
