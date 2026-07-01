package orchestrator

import (
	"net"
	"strconv"
	"testing"
)

func TestAllocFreePort_ReturnsPositivePort(t *testing.T) {
	port, err := AllocFreePort()
	if err != nil {
		t.Fatalf("AllocFreePort() error = %v", err)
	}
	if port <= 0 {
		t.Errorf("AllocFreePort() = %d, want > 0", port)
	}
}

func TestAllocFreePort_UsuallyDistinctAcrossCalls(t *testing.T) {
	p1, err := AllocFreePort()
	if err != nil {
		t.Fatalf("AllocFreePort() error = %v", err)
	}
	p2, err := AllocFreePort()
	if err != nil {
		t.Fatalf("AllocFreePort() error = %v", err)
	}
	if p1 == p2 {
		t.Logf("warning: two consecutive AllocFreePort() calls returned the same port %d (rare but possible)", p1)
	}
}

func TestAllocFreePort_IsBindable(t *testing.T) {
	port, err := AllocFreePort()
	if err != nil {
		t.Fatalf("AllocFreePort() error = %v", err)
	}

	l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("expected port %d to be bindable, got error: %v", port, err)
	}
	defer l.Close()
}
