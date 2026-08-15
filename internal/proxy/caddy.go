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
			trustCaddyCA()
			return c.ensureBaseConfig()
		}
		time.Sleep(ensurePollStep)
	}

	return fmt.Errorf("proxy: caddy admin API at %s did not become ready within %s (is port 2019 blocked, or did caddy fail to bind port 80?)", adminBaseURL, ensureTimeout)
}

// ping checks whether the admin API responds.
func (c *CaddyClient) ping() error {
	resp, err := c.client().Get(adminBaseURL + "/config/")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// trustCaddyCA installs Caddy's internal root CA into the system trust store
// so browsers accept the local HTTPS certs devdash serves. Best-effort and
// idempotent (no-op if already trusted); runs only when caddy is started.
func trustCaddyCA() {
	_ = exec.Command("caddy", "trust").Run()
}

// ensureBaseConfig makes sure an HTTP server named defaultServer exists on
// :80 with a routes array, without clobbering any existing routes.
func (c *CaddyClient) ensureBaseConfig() error {
	req, err := http.NewRequest(http.MethodGet, adminBaseURL+"/config/apps/http/servers/"+defaultServer, nil)
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
			// Serve every proxied domain over local HTTPS using Caddy's internal
			// CA so cookie-auth apps work: remote backends set Secure/SameSite
			// cookies that a browser drops on a plain-HTTP origin. `caddy trust`
			// (run by EnsureRunning) adds the CA to the system trust store.
			"tls": map[string]any{
				"automation": map[string]any{
					"policies": []any{
						map[string]any{
							"issuers": []any{map[string]any{"module": "internal"}},
						},
					},
				},
			},
			"http": map[string]any{
				"servers": map[string]any{
					defaultServer: map[string]any{
						"listen": []string{":80", ":443"},
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

	putReq, err := http.NewRequest(http.MethodPost, adminBaseURL+"/load", bytes.NewReader(body))
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

// AddRoute registers r under the base HTTP server's routes list via the
// admin API's config-tree append endpoint.
func (c *CaddyClient) AddRoute(r Route) error {
	body, err := r.CaddyJSON()
	if err != nil {
		return fmt.Errorf("proxy: building route JSON for %s: %w", r.ID, err)
	}

	url := fmt.Sprintf("%s/config/apps/http/servers/%s/routes", adminBaseURL, defaultServer)
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
		req, err := http.NewRequest(http.MethodDelete, adminBaseURL+"/id/"+id, nil)
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
	url := fmt.Sprintf("%s/config/apps/http/servers/%s/routes", adminBaseURL, defaultServer)
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
