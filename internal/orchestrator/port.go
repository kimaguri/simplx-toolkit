package orchestrator

import "net"

// AllocFreePort asks the OS for a free loopback TCP port by binding to
// port 0, reading back the assigned port, and closing the listener.
func AllocFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()

	addr, ok := l.Addr().(*net.TCPAddr)
	if !ok {
		return 0, err
	}

	return addr.Port, nil
}
