package event

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const (
	maxFileSize = 10 * 1024 * 1024 // 10MB
	rotateKeep  = 1
	fileName    = "events.jsonl"
)

var (
	mu       sync.Mutex
	storeDir string
)

// Init sets the directory where events.jsonl is stored.
// Must be called before Emit/Recent/ByTask.
func Init(dir string) {
	mu.Lock()
	defer mu.Unlock()
	storeDir = dir
}

func filePath() string {
	return filepath.Join(storeDir, fileName)
}

// Emit appends an event to the JSONL file.
func Emit(evt Event) error {
	mu.Lock()
	defer mu.Unlock()

	if storeDir == "" {
		return nil // silent no-op if not initialized
	}

	os.MkdirAll(storeDir, 0o755)

	rotateIfNeeded()

	f, err := os.OpenFile(filePath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	data, err := json.Marshal(evt)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = f.Write(data)
	return err
}

// Recent returns the last n events from the log.
func Recent(n int) ([]Event, error) {
	mu.Lock()
	defer mu.Unlock()

	all, err := readAll()
	if err != nil {
		return nil, err
	}

	if n <= 0 || n > len(all) {
		n = len(all)
	}
	return all[len(all)-n:], nil
}

// ByTask returns the last n events matching the given taskID.
func ByTask(taskID string, n int) ([]Event, error) {
	mu.Lock()
	defer mu.Unlock()

	all, err := readAll()
	if err != nil {
		return nil, err
	}

	var filtered []Event
	for _, e := range all {
		if e.TaskID == taskID {
			filtered = append(filtered, e)
		}
	}

	if n <= 0 || n > len(filtered) {
		n = len(filtered)
	}
	return filtered[len(filtered)-n:], nil
}

func readAll() ([]Event, error) {
	if storeDir == "" {
		return nil, nil
	}

	f, err := os.Open(filePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var events []Event
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var evt Event
		if err := json.Unmarshal(scanner.Bytes(), &evt); err != nil {
			continue // skip malformed lines
		}
		events = append(events, evt)
	}
	return events, scanner.Err()
}

func rotateIfNeeded() {
	info, err := os.Stat(filePath())
	if err != nil {
		return
	}
	if info.Size() < int64(maxFileSize) {
		return
	}

	rotated := filePath() + ".1"
	os.Remove(rotated)
	os.Rename(filePath(), rotated)
}
