package process

import (
	"strings"
	"sync"
	"testing"
)

func TestVTermScreen_WriteAndRender(t *testing.T) {
	screen := NewVTermScreen(24, 80)

	// Write ANSI-colored text: red "hello"
	colored := "\x1b[31mhello\x1b[0m world"
	n, err := screen.Write([]byte(colored))
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if n != len(colored) {
		t.Fatalf("Write returned %d, want %d", n, len(colored))
	}

	rendered := screen.Render()
	if !strings.Contains(rendered, "hello") {
		t.Errorf("Render() should contain 'hello', got: %q", rendered)
	}
	if !strings.Contains(rendered, "world") {
		t.Errorf("Render() should contain 'world', got: %q", rendered)
	}
}

func TestVTermScreen_Content(t *testing.T) {
	screen := NewVTermScreen(24, 80)

	// Write ANSI-colored text
	colored := "\x1b[32mgreen text\x1b[0m"
	_, err := screen.Write([]byte(colored))
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	content := screen.Content()

	// Content should contain the text without ANSI codes
	if !strings.Contains(content, "green text") {
		t.Errorf("Content() should contain 'green text', got: %q", content)
	}

	// Content should NOT contain ANSI escape sequences
	if strings.Contains(content, "\x1b[") {
		t.Errorf("Content() should not contain ANSI codes, got: %q", content)
	}
}

func TestVTermScreen_Resize(t *testing.T) {
	screen := NewVTermScreen(24, 80)

	// Write some text first
	_, err := screen.Write([]byte("before resize"))
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	// Resize should not panic
	screen.Resize(40, 120)

	// Write after resize should work
	_, err = screen.Write([]byte("\nafter resize"))
	if err != nil {
		t.Fatalf("Write after resize failed: %v", err)
	}

	content := screen.Content()
	if !strings.Contains(content, "after resize") {
		t.Errorf("Content after resize should contain text, got: %q", content)
	}
}

func TestVTermScreen_ThreadSafety(t *testing.T) {
	screen := NewVTermScreen(24, 80)

	var wg sync.WaitGroup
	iterations := 100

	// Concurrent writers
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				screen.Write([]byte("data "))
			}
		}()
	}

	// Concurrent readers (Render)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				_ = screen.Render()
			}
		}()
	}

	// Concurrent readers (Content)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				_ = screen.Content()
			}
		}()
	}

	// Concurrent resize
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < iterations; j++ {
			screen.Resize(24+j%10, 80+j%20)
		}
	}()

	wg.Wait()
	// If we reach here without panic/race, the test passes
}
