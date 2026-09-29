package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// CaddyAvailable reports whether the caddy binary is on PATH.
func CaddyAvailable() bool { _, err := exec.LookPath("caddy"); return err == nil }

const (
	adminBaseURL   = "http://localhost:2019"
	defaultServer  = "srv0"
	ensureTimeout  = 10 * time.Second
	ensurePollStep = 250 * time.Millisecond
)

// CaddyClient talks to a locally running Caddy instance via its admin API
// (http://localhost:2019) to bootstrap the proxy and add/remove routes. It
// implements ProxyClient.
type CaddyClient struct {
	httpClient *http.Client
	// baseURL overrides adminBaseURL when set — test-only seam (unexported,
	// same-package tests construct a CaddyClient directly and point it at an
	// httptest server instead of the real Caddy admin API).
	baseURL string
}

// NewCaddyClient returns a CaddyClient ready to use.
func NewCaddyClient() *CaddyClient {
	return &CaddyClient{httpClient: &http.Client{Timeout: 5 * time.Second}}
}

func (c *CaddyClient) client() *http.Client {
	if c.httpClient == nil {
		c.httpClient = &http.Client{Timeout: 5 * time.Second}
	}
	return c.httpClient
}

// base returns the admin API base URL: baseURL if set (test seam), else the
// real adminBaseURL constant.
func (c *CaddyClient) base() string {
	if c.baseURL != "" {
		return c.baseURL
	}
	return adminBaseURL
}

// EnsureRunning makes sure Caddy's admin API is reachable, launching it
// (detached, not as a child of devdash) and bootstrapping a base HTTP
// server on :80 with an empty routes list if it isn't.
func (c *CaddyClient) EnsureRunning() error {
	if c.ping() == nil {
		return c.ensureBaseConfig()
	}

	if !CaddyAvailable() {
		return fmt.Errorf("proxy: caddy binary not found on PATH; install caddy to use devdash routing")
	}

	// `caddy start` detaches into its own daemon process; devdash never
	// holds it as a child so routes survive devdash exiting.
	cmd := exec.Command("caddy", "start")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("proxy: failed to start caddy: %w", err)
	}
	// Detach: don't Wait() on it, it's a launcher that exits once the
	// daemon is up.
	go func() { _ = cmd.Wait() }()

	deadline := time.Now().Add(ensureTimeout)
	for time.Now().Before(deadline) {
		if c.ping() == nil {
			return c.ensureBaseConfig()
		}
		time.Sleep(ensurePollStep)
	}

	return fmt.Errorf("proxy: caddy admin API at %s did not become ready within %s (is port 2019 blocked, or did caddy fail to bind port 80?)", c.base(), ensureTimeout)
}

// ping checks whether the admin API responds.
func (c *CaddyClient) ping() error {
	resp, err := c.client().Get(c.base() + "/config/")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// ensureBaseConfig makes sure an HTTP server named defaultServer exists on
// :80 with a routes array, without clobbering any existing routes.
func (c *CaddyClient) ensureBaseConfig() error {
	req, err := http.NewRequest(http.MethodGet, c.base()+"/config/apps/http/servers/"+defaultServer, nil)
	if err != nil {
		return fmt.Errorf("proxy: building base-config check request: %w", err)
	}
	resp, err := c.client().Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
	}

	base := map[string]any{
		"apps": map[string]any{
			"http": map[string]any{
				"servers": map[string]any{
					defaultServer: map[string]any{
						"listen": []string{":80"},
						"routes": []any{},
					},
				},
			},
		},
	}

	body, err := json.Marshal(base)
	if err != nil {
		return fmt.Errorf("proxy: marshaling base config: %w", err)
	}

	putReq, err := http.NewRequest(http.MethodPost, c.base()+"/load", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("proxy: building base-config load request: %w", err)
	}
	putReq.Header.Set("Content-Type", "application/json")

	putResp, err := c.client().Do(putReq)
	if err != nil {
		return fmt.Errorf("proxy: loading base caddy config (is port 80 already bound by another process?): %w", err)
	}
	defer putResp.Body.Close()

	if putResp.StatusCode >= 300 {
		return fmt.Errorf("proxy: caddy rejected base config (status %d) — check port 80 availability", putResp.StatusCode)
	}
	return nil
}

// AddRoute registers (or replaces) r idempotently. LAB-294: a plain
// POST-append (the old behavior) fails with a Caddy 400 if a route with the
// same "@id" already exists — e.g. from a prior `up` that partially
// registered routes before failing on a later service, and is then retried
// — because Caddy enforces @id uniqueness across the whole config (see
// specs/002-devdash-reliability/research.md Finding 4). AddRoute now tries
// an in-place replace first (PATCH /id/<id>, addressed by the same "@id" tag
// CaddyJSON already sets), and only falls back to the create/append POST
// when that 404s (the route genuinely doesn't exist yet).
func (c *CaddyClient) AddRoute(r Route) error {
	body, err := r.CaddyJSON()
	if err != nil {
		return fmt.Errorf("proxy: building route JSON for %s: %w", r.ID, err)
	}

	patchReq, err := http.NewRequest(http.MethodPatch, c.base()+"/id/"+r.ID, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("proxy: building replace-route request for %s: %w", r.ID, err)
	}
	patchReq.Header.Set("Content-Type", "application/json")

	patchResp, err := c.client().Do(patchReq)
	if err != nil {
		return fmt.Errorf("proxy: replacing route %s: %w", r.ID, err)
	}
	defer patchResp.Body.Close()

	if patchResp.StatusCode < 300 {
		return nil
	}
	if patchResp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("proxy: caddy rejected route replace %s (status %d)", r.ID, patchResp.StatusCode)
	}

	// Route doesn't exist yet — create it via append.
	url := fmt.Sprintf("%s/config/apps/http/servers/%s/routes", c.base(), defaultServer)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("proxy: building add-route request for %s: %w", r.ID, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("proxy: adding route %s: %w", r.ID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("proxy: caddy rejected route %s (status %d)", r.ID, resp.StatusCode)
	}
	return nil
}

// RemoveRoutesByInstance deletes every route whose "@id" is namespaced
// under "<slug>-", addressing each by Caddy's @id-based config path
// (DELETE /id/<routeID>).
func (c *CaddyClient) RemoveRoutesByInstance(slug string) error {
	ids, err := c.routeIDsForInstance(slug)
	if err != nil {
		return fmt.Errorf("proxy: listing routes for instance %s: %w", slug, err)
	}

	for _, id := range ids {
		req, err := http.NewRequest(http.MethodDelete, c.base()+"/id/"+id, nil)
		if err != nil {
			return fmt.Errorf("proxy: building delete request for route %s: %w", id, err)
		}
		resp, err := c.client().Do(req)
		if err != nil {
			return fmt.Errorf("proxy: deleting route %s: %w", id, err)
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
			return fmt.Errorf("proxy: caddy rejected delete of route %s (status %d)", id, resp.StatusCode)
		}
	}
	return nil
}

// routeIDsForInstance queries the current route list and returns the @id
// of every route namespaced under "<slug>-".
func (c *CaddyClient) routeIDsForInstance(slug string) ([]string, error) {
	url := fmt.Sprintf("%s/config/apps/http/servers/%s/routes", c.base(), defaultServer)
	resp, err := c.client().Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}

	var routes []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&routes); err != nil {
		return nil, fmt.Errorf("decoding routes list: %w", err)
	}

	prefix := slug + "-"
	var ids []string
	for _, route := range routes {
		id, ok := route["@id"].(string)
		if !ok {
			continue
		}
		if strings.HasPrefix(id, prefix) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
