package devdash

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

func TestReadPTYWritesToLogBuffer(t *testing.T) {
	// Create a pipe to simulate PTY
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	logBuf := process.NewLogBuffer(100)
	vterm := process.NewVTermScreen(24, 80)
	logFile, err := os.CreateTemp("", "test-log-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(logFile.Name())
	defer logFile.Close()

	stop := make(chan struct{})

	go readPTY(r, logFile, vterm, logBuf, stop)

	// Write test data
	w.Write([]byte("hello world\n"))
	w.Close()

	// Give goroutine time to process
	time.Sleep(100 * time.Millisecond)
	close(stop)

	content := logBuf.Content()
	if !strings.Contains(content, "hello world") {
		t.Errorf("LogBuffer should contain 'hello world', got: %q", content)
	}
}
