package devdash

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kimaguri/simplx-toolkit/internal/process"
)

func TestTailFileWritesToLogBuffer(t *testing.T) {
	// Create a temp log file simulating child process output
	logFile, err := os.CreateTemp("", "test-log-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(logFile.Name())

	logBuf := process.NewLogBuffer(100)
	stop := make(chan struct{})

	// Start tailing (same as Start() does now)
	go tailFile(logFile.Name(), logBuf, 0, stop)

	// Simulate child process writing to log file
	logFile.Write([]byte("hello world\n"))
	logFile.Sync()

	// Give tailFile time to poll and read
	time.Sleep(300 * time.Millisecond)
	close(stop)

	content := logBuf.Content()
	if !strings.Contains(content, "hello world") {
		t.Errorf("LogBuffer should contain 'hello world', got: %q", content)
	}
}
