package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeCaddyAdmin is a minimal in-memory stand-in for Caddy's admin API,
// covering only what AddRoute needs: PATCH /id/<id> (replace if present,
// 404 otherwise) and POST .../routes (append/create, 400 on duplicate @id —
// matching real Caddy's @id-uniqueness enforcement, which is the LAB-294 bug
// this test guards against). See research.md Finding 4.
type fakeCaddyAdmin struct {
	mu     sync.Mutex
	routes map[string]json.RawMessage // keyed by "@id"

	patchCalls int
	postCalls  int
}

func newFakeCaddyAdmin() *fakeCaddyAdmin {
	return &fakeCaddyAdmin{routes: make(map[string]json.RawMessage)}
}

func (f *fakeCaddyAdmin) server() *httptest.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/id/", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Path[len("/id/"):]
		f.mu.Lock()
		defer f.mu.Unlock()

		switch r.Method {
		case http.MethodPatch:
			f.patchCalls++
			if _, exists := f.routes[id]; !exists {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			body, _ := io.ReadAll(r.Body)
			f.routes[id] = body
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/config/apps/http/servers/srv0/routes", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()

		switch r.Method {
		case http.MethodPost:
			f.postCalls++
			body, _ := io.ReadAll(r.Body)
			var parsed struct {
				ID string `json:"@id"`
			}
			_ = json.Unmarshal(body, &parsed)
			if parsed.ID != "" {
				if _, exists := f.routes[parsed.ID]; exists {
					// Real Caddy rejects a duplicate @id on append with 400
					// — this is the exact LAB-294 failure mode.
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				f.routes[parsed.ID] = body
			}
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("[]"))
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/config/", func(w http.ResponseWriter, r *http.Request) {
		// EnsureRunning's ping()/ensureBaseConfig() probes — not under test
		// here, just keep them happy if anything hits them.
		w.WriteHeader(http.StatusOK)
	})

	return httptest.NewServer(mux)
}

// newTestCaddyClient returns a real CaddyClient (exercising the actual
// AddRoute implementation under test, not a reimplementation) pointed at a
// fake admin server via the baseURL test seam.
func newTestCaddyClient(srv *httptest.Server) *CaddyClient {
	return &CaddyClient{httpClient: srv.Client(), baseURL: srv.URL}
}

func TestAddRoute_FirstCall_CreatesViaPost(t *testing.T) {
	admin := newFakeCaddyAdmin()
	srv := admin.server()
	defer srv.Close()

	c := newTestCaddyClient(srv)
	route := BuildRoute("orders-refactor", "front", "simplx.localhost", 5173, "")

	if err := c.AddRoute(route); err != nil {
		t.Fatalf("AddRoute() error = %v", err)
	}

	admin.mu.Lock()
	defer admin.mu.Unlock()
	if admin.postCalls != 1 {
		t.Errorf("expected 1 POST (create), got %d", admin.postCalls)
	}
	if admin.patchCalls != 1 {
		t.Errorf("expected 1 PATCH attempt (404, tried first), got %d", admin.patchCalls)
	}
}

// TestAddRoute_SecondCall_ReplacesViaPatch_NoDuplicateError is the core
// LAB-294 regression test: calling AddRoute twice for the same route (e.g.
// a retried `up` after a partial failure already registered this route)
// must succeed both times, not hit Caddy's real-world 400 on a duplicate
// @id append.
func TestAddRoute_SecondCall_ReplacesViaPatch_NoDuplicateError(t *testing.T) {
	admin := newFakeCaddyAdmin()
	srv := admin.server()
	defer srv.Close()

	c := newTestCaddyClient(srv)
	route := BuildRoute("orders-refactor", "front", "simplx.localhost", 5173, "")

	if err := c.AddRoute(route); err != nil {
		t.Fatalf("first AddRoute() error = %v", err)
	}
	if err := c.AddRoute(route); err != nil {
		t.Fatalf("second AddRoute() (should replace via PATCH, not 400) error = %v", err)
	}

	admin.mu.Lock()
	defer admin.mu.Unlock()
	if admin.postCalls != 1 {
		t.Errorf("expected exactly 1 POST (only the first call creates), got %d", admin.postCalls)
	}
	if admin.patchCalls != 2 {
		t.Errorf("expected 2 PATCH attempts (first 404s, second replaces), got %d", admin.patchCalls)
	}
}

func TestAddRoute_DifferentServices_BothCreatedIndependently(t *testing.T) {
	admin := newFakeCaddyAdmin()
	srv := admin.server()
	defer srv.Close()

	c := newTestCaddyClient(srv)
	front := BuildRoute("orders-refactor", "front", "simplx.localhost", 5173, "")
	core := BuildRoute("orders-refactor", "core", "simplx.localhost", 5174, "")

	if err := c.AddRoute(front); err != nil {
		t.Fatalf("AddRoute(front) error = %v", err)
	}
	if err := c.AddRoute(core); err != nil {
		t.Fatalf("AddRoute(core) error = %v", err)
	}

	admin.mu.Lock()
	defer admin.mu.Unlock()
	if len(admin.routes) != 2 {
		t.Errorf("expected 2 distinct routes registered, got %d", len(admin.routes))
	}
}
