package process

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const DefaultSegSize = 10000

// segmentMeta holds metadata for a completed segment file.
type segmentMeta struct {
	ID    int `json:"id"`
	Lines int `json:"lines"`
}

// segIndex is the on-disk JSON metadata for the segmented log.
type segIndex struct {
	SegSize    int           `json:"seg_size"`
	Segments   []segmentMeta `json:"segments"`
	TotalLines int           `json:"total_lines"`
}

// SegmentedLog is an io.Writer that stores sanitized log lines across
// segment files on disk with a hot in-memory buffer. When the hot buffer
// reaches segSize lines, it is flushed to a segment file. Old segments
// can be loaded on demand via ReadRange with an LRU cache.
type SegmentedLog struct {
	mu sync.RWMutex

	dir     string // segment storage directory
	segSize int    // lines per segment (default 10000)

	// Hot buffer (current segment being filled, in memory)
	hot     []string
	partial string // incomplete line accumulator

	// Cold segments (on disk)
	segments   []segmentMeta    // completed segment metadata
	cache      map[int][]string // LRU cache: segment ID → lines
	cacheOrder []int            // access order for LRU eviction
	maxCached  int              // max segments in cache (default 5)

	// Counters
	totalLines int // all segments + hot

	// Subscribers (same pattern as LogBuffer)
	subs []chan string
}

// NewSegmentedLog creates a SegmentedLog backed by the given directory.
// If index.json exists in the directory, it is loaded (reconnection case).
func NewSegmentedLog(dir string, segSize int) *SegmentedLog {
	if segSize <= 0 {
		segSize = DefaultSegSize
	}
	sl := &SegmentedLog{
		dir:       dir,
		segSize:   segSize,
		hot:       make([]string, 0, 256),
		cache:     make(map[int][]string),
		maxCached: 5,
	}
	os.MkdirAll(dir, 0o755)
	sl.loadIndex()
	return sl
}

// Reset clears all segments and hot buffer, removing persisted data.
// Used when starting a fresh process to avoid loading stale scrollback.
func (sl *SegmentedLog) Reset() {
	sl.mu.Lock()
	defer sl.mu.Unlock()
	// Remove segment files and index
	for _, seg := range sl.segments {
		os.Remove(sl.segPath(seg.ID))
	}
	os.Remove(sl.indexPath())
	sl.segments = nil
	sl.hot = make([]string, 0, 256)
	sl.partial = ""
	sl.cache = make(map[int][]string)
	sl.cacheOrder = nil
	sl.totalLines = 0
}

// Write implements io.Writer. Splits input by newlines and appends each line.
func (sl *SegmentedLog) Write(p []byte) (int, error) {
	sl.mu.Lock()
	defer sl.mu.Unlock()

	data := sl.partial + string(p)
	sl.partial = ""

	parts := strings.Split(data, "\n")
	for i := 0; i < len(parts)-1; i++ {
		sl.appendLine(parts[i])
	}

	last := parts[len(parts)-1]
	if last != "" {
		sl.partial = last
	}

	return len(p), nil
}

// Flush writes the partial line buffer (if any) as a complete line.
func (sl *SegmentedLog) Flush() {
	sl.mu.Lock()
	defer sl.mu.Unlock()
	if sl.partial != "" {
		sl.appendLine(sl.partial)
		sl.partial = ""
	}
}

// appendLine adds a line to the hot buffer, flushing to disk if full.
// Notifies subscribers. Must be called with lock held.
func (sl *SegmentedLog) appendLine(line string) {
	sl.hot = append(sl.hot, line)
	sl.totalLines++

	if len(sl.hot) >= sl.segSize {
		sl.flushSegment()
	}

	for _, ch := range sl.subs {
		select {
		case ch <- line:
		default:
		}
	}
}

// flushSegment writes the hot buffer to a segment file on disk.
// Must be called with lock held.
func (sl *SegmentedLog) flushSegment() {
	id := len(sl.segments)
	path := sl.segPath(id)

	f, err := os.Create(path)
	if err != nil {
		return
	}
	for _, line := range sl.hot {
		f.WriteString(line)
		f.WriteString("\n")
	}
	f.Close()

	meta := segmentMeta{ID: id, Lines: len(sl.hot)}
	sl.segments = append(sl.segments, meta)

	// Cache the flushed segment
	sl.addToCache(id, sl.hot)

	sl.hot = make([]string, 0, 256)
	sl.saveIndex()
}

// ReadRange returns lines in the range [start, end). Thread-safe.
// Loads cold segments from disk/cache as needed.
func (sl *SegmentedLog) ReadRange(start, end int) []string {
	sl.mu.Lock()
	defer sl.mu.Unlock()

	if start < 0 {
		start = 0
	}
	if end > sl.totalLines {
		end = sl.totalLines
	}
	if start >= end {
		return nil
	}

	coldLines := 0
	for _, seg := range sl.segments {
		coldLines += seg.Lines
	}

	var result []string

	// Read from cold segments
	if start < coldLines {
		offset := 0
		for _, seg := range sl.segments {
			segStart := offset
			segEnd := offset + seg.Lines

			rStart := max(start, segStart)
			rEnd := min(end, segEnd)
			if rStart < rEnd {
				lines := sl.loadSegment(seg.ID)
				localStart := rStart - segStart
				localEnd := rEnd - segStart
				if localEnd > len(lines) {
					localEnd = len(lines)
				}
				if localStart < localEnd {
					result = append(result, lines[localStart:localEnd]...)
				}
			}
			offset += seg.Lines
		}
	}

	// Read from hot buffer
	hotStart := coldLines
	if end > hotStart {
		hStart := max(start, hotStart) - hotStart
		hEnd := end - hotStart
		if hEnd > len(sl.hot) {
			hEnd = len(sl.hot)
		}
		if hStart < hEnd {
			result = append(result, sl.hot[hStart:hEnd]...)
		}
	}

	return result
}

// Len returns total line count (cold segments + hot buffer).
func (sl *SegmentedLog) Len() int {
	sl.mu.RLock()
	defer sl.mu.RUnlock()
	return sl.totalLines
}

// Lines returns a copy of the hot buffer lines (including partial).
func (sl *SegmentedLog) Lines() []string {
	sl.mu.RLock()
	defer sl.mu.RUnlock()
	out := make([]string, len(sl.hot))
	copy(out, sl.hot)
	if sl.partial != "" {
		out = append(out, sl.partial)
	}
	return out
}

// Content returns the hot buffer joined with newlines.
// Includes the current partial line so interactive prompts are visible.
func (sl *SegmentedLog) Content() string {
	sl.mu.RLock()
	defer sl.mu.RUnlock()
	var b strings.Builder
	for i, line := range sl.hot {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	if sl.partial != "" {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(sl.partial)
	}
	return b.String()
}

// Subscribe returns a channel that receives new log lines as they arrive.
func (sl *SegmentedLog) Subscribe() chan string {
	sl.mu.Lock()
	defer sl.mu.Unlock()
	ch := make(chan string, 256)
	sl.subs = append(sl.subs, ch)
	return ch
}

// Unsubscribe removes a subscription channel.
func (sl *SegmentedLog) Unsubscribe(ch chan string) {
	sl.mu.Lock()
	defer sl.mu.Unlock()
	for i, sub := range sl.subs {
		if sub == ch {
			sl.subs = append(sl.subs[:i], sl.subs[i+1:]...)
			return
		}
	}
}

// loadSegment reads segment lines from cache or disk.
// Must be called with full lock held (not RLock) so cache can be updated.
func (sl *SegmentedLog) loadSegment(id int) []string {
	if lines, ok := sl.cache[id]; ok {
		// Move to end of access order (most recently used)
		sl.touchCache(id)
		return lines
	}

	// Read from disk
	path := sl.segPath(id)
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}

	sl.addToCache(id, lines)
	return lines
}

// addToCache adds segment lines to the LRU cache, evicting oldest if needed.
// Must be called with lock held.
func (sl *SegmentedLog) addToCache(id int, lines []string) {
	copied := make([]string, len(lines))
	copy(copied, lines)
	sl.cache[id] = copied
	sl.touchCache(id)

	// Evict oldest if over capacity
	for len(sl.cacheOrder) > sl.maxCached {
		evict := sl.cacheOrder[0]
		sl.cacheOrder = sl.cacheOrder[1:]
		delete(sl.cache, evict)
	}
}

// touchCache moves a segment ID to the end of the access order (most recently used).
func (sl *SegmentedLog) touchCache(id int) {
	newOrder := make([]int, 0, len(sl.cacheOrder)+1)
	for _, oid := range sl.cacheOrder {
		if oid != id {
			newOrder = append(newOrder, oid)
		}
	}
	newOrder = append(newOrder, id)
	sl.cacheOrder = newOrder
}

func (sl *SegmentedLog) segPath(id int) string {
	return filepath.Join(sl.dir, fmt.Sprintf("seg-%04d.log", id))
}

func (sl *SegmentedLog) indexPath() string {
	return filepath.Join(sl.dir, "index.json")
}

// saveIndex persists segment metadata to index.json. Must be called with lock held.
func (sl *SegmentedLog) saveIndex() {
	idx := segIndex{
		SegSize:    sl.segSize,
		Segments:   sl.segments,
		TotalLines: sl.totalLines,
	}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return
	}
	os.WriteFile(sl.indexPath(), data, 0o644)
}

// loadIndex restores segment metadata from index.json if it exists.
func (sl *SegmentedLog) loadIndex() {
	data, err := os.ReadFile(sl.indexPath())
	if err != nil {
		return
	}
	var idx segIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		return
	}
	sl.segments = idx.Segments
	sl.totalLines = idx.TotalLines
}

// SafeName sanitizes a process name for use as a directory name.
func SafeName(name string) string {
	safe := strings.ReplaceAll(name, "/", "_")
	safe = strings.ReplaceAll(safe, ":", "_")
	safe = strings.ReplaceAll(safe, " ", "_")
	return safe
}
