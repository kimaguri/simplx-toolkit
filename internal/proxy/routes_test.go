package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildRoute_Local(t *testing.T) {
	r := BuildRoute("taska", "web", "localhost", 5173, "")

	if r.ID != "taska-web" {
		t.Errorf("ID = %q, want %q", r.ID, "taska-web")
	}
	if r.HostMatch != "taska-web.localhost" {
		t.Errorf("HostMatch = %q, want %q", r.HostMatch, "taska-web.localhost")
	}
	if r.Upstream != "127.0.0.1:5173" {
		t.Errorf("Upstream = %q, want %q", r.Upstream, "127.0.0.1:5173")
	}
	if r.HostHeader != "" {
		t.Errorf("HostHeader = %q, want empty", r.HostHeader)
	}
}

func TestBuildRoute_Remote_HTTPS(t *testing.T) {
	r := BuildRoute("taska", "core", "localhost", 0, "https://core-test.sadmin.app")

	if r.ID != "taska-core" {
		t.Errorf("ID = %q, want %q", r.ID, "taska-core")
	}
	if r.HostMatch != "taska-core.localhost" {
		t.Errorf("HostMatch = %q, want %q", r.HostMatch, "taska-core.localhost")
	}
	if r.Upstream != "core-test.sadmin.app:443" {
		t.Errorf("Upstream = %q, want %q", r.Upstream, "core-test.sadmin.app:443")
	}
	if r.HostHeader != "core-test.sadmin.app" {
		t.Errorf("HostHeader = %q, want %q", r.HostHeader, "core-test.sadmin.app")
	}
}

func TestBuildRoute_Remote_HTTP(t *testing.T) {
	r := BuildRoute("taska", "core", "localhost", 0, "http://core-test.sadmin.app")

	if r.Upstream != "core-test.sadmin.app:80" {
		t.Errorf("Upstream = %q, want %q", r.Upstream, "core-test.sadmin.app:80")
	}
	if r.HostHeader != "core-test.sadmin.app" {
		t.Errorf("HostHeader = %q, want %q", r.HostHeader, "core-test.sadmin.app")
	}
}

func TestBuildRoute_Remote_ExplicitPort(t *testing.T) {
	r := BuildRoute("taska", "core", "localhost", 0, "https://core-test.sadmin.app:8443")

	if r.Upstream != "core-test.sadmin.app:8443" {
		t.Errorf("Upstream = %q, want %q", r.Upstream, "core-test.sadmin.app:8443")
	}
	if r.HostHeader != "core-test.sadmin.app" {
		t.Errorf("HostHeader = %q, want %q", r.HostHeader, "core-test.sadmin.app")
	}
}

func TestRoute_CaddyJSON_Local(t *testing.T) {
	r := BuildRoute("taska", "web", "localhost", 5173, "")

	raw, err := r.CaddyJSON()
	if err != nil {
		t.Fatalf("CaddyJSON error: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("CaddyJSON produced invalid JSON: %v", err)
	}

	if decoded["@id"] != "taska-web" {
		t.Errorf("@id = %v, want %q", decoded["@id"], "taska-web")
	}

	s := string(raw)
	if !strings.Contains(s, "127.0.0.1:5173") {
		t.Errorf("CaddyJSON missing upstream, got: %s", s)
	}
	if !strings.Contains(s, "taska-web.localhost") {
		t.Errorf("CaddyJSON missing host match, got: %s", s)
	}
	if strings.Contains(s, "headers") {
		t.Errorf("local route should not contain a Host header rewrite, got: %s", s)
	}
}

func TestRoute_CaddyJSON_Remote_HasHostHeaderRewrite(t *testing.T) {
	r := BuildRoute("taska", "core", "localhost", 0, "https://core-test.sadmin.app")

	raw, err := r.CaddyJSON()
	if err != nil {
		t.Fatalf("CaddyJSON error: %v", err)
	}

	s := string(raw)
	if !strings.Contains(s, "core-test.sadmin.app:443") {
		t.Errorf("CaddyJSON missing upstream, got: %s", s)
	}
	if !strings.Contains(s, "\"Host\"") {
		t.Errorf("remote route missing Host header rewrite, got: %s", s)
	}
	if !strings.Contains(s, "core-test.sadmin.app") {
		t.Errorf("CaddyJSON missing host header value, got: %s", s)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("CaddyJSON produced invalid JSON: %v", err)
	}
	if decoded["@id"] != "taska-core" {
		t.Errorf("@id = %v, want %q", decoded["@id"], "taska-core")
	}
}

func TestProxyClientInterface_Satisfied(t *testing.T) {
	var _ ProxyClient = (*CaddyClient)(nil)
}
