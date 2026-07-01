package proxy

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Route describes one Caddy reverse-proxy route: a Host-header match paired
// with an upstream (local port or remote origin). ID is the Caddy "@id" used
// to address the route for targeted deletion ("<slug>-<service>").
type Route struct {
	ID         string
	HostMatch  string
	Upstream   string
	HostHeader string
}

// ProxyClient is the minimal surface devdash needs against the shared Caddy
// reverse proxy. It exists so orchestrator code can depend on an interface
// and tests can supply a fake instead of talking to a real Caddy instance.
type ProxyClient interface {
	// EnsureRunning makes sure Caddy is reachable via its admin API,
	// bootstrapping it (detached) if necessary.
	EnsureRunning() error
	// AddRoute registers (or replaces) a single route.
	AddRoute(r Route) error
	// RemoveRoutesByInstance removes every route whose ID is namespaced
	// under the given instance slug (i.e. "<slug>-*").
	RemoveRoutesByInstance(slug string) error
}

// schemeDefaultPort maps a URL scheme to its implicit port, used when the
// remote upstream URL omits an explicit port.
var schemeDefaultPort = map[string]string{
	"http":  "80",
	"https": "443",
}

// BuildRoute constructs the Route for a given instance/service pair.
//
// Local mode (remoteUpstream == ""): the route points at 127.0.0.1:localPort
// on the local machine; no Host header rewrite is needed.
//
// Remote mode: remoteUpstream is a full URL (e.g. "https://core-test.sadmin.app").
// Upstream becomes "<host>:<port>" (port defaulted from scheme when absent),
// and HostHeader is set to the upstream's bare host so Caddy presents the
// correct Host/SNI to the remote server.
func BuildRoute(slug, service, domainSuffix string, localPort int, remoteUpstream string) Route {
	id := fmt.Sprintf("%s-%s", slug, service)
	hostMatch := fmt.Sprintf("%s.%s", id, domainSuffix)

	if remoteUpstream == "" {
		return Route{
			ID:        id,
			HostMatch: hostMatch,
			Upstream:  fmt.Sprintf("127.0.0.1:%d", localPort),
		}
	}

	upstream, hostHeader := parseRemoteUpstream(remoteUpstream)

	return Route{
		ID:         id,
		HostMatch:  hostMatch,
		Upstream:   upstream,
		HostHeader: hostHeader,
	}
}

// parseRemoteUpstream turns a remote upstream URL into a Caddy "host:port"
// dial address plus the bare host to present via a Host header rewrite.
func parseRemoteUpstream(remoteUpstream string) (upstream, hostHeader string) {
	u, err := url.Parse(remoteUpstream)
	if err != nil || u.Host == "" {
		// Not a well-formed URL; treat the raw value as a host[:port].
		host := strings.TrimSuffix(strings.TrimPrefix(remoteUpstream, "https://"), "/")
		host = strings.TrimPrefix(host, "http://")
		return host, host
	}

	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = schemeDefaultPort[u.Scheme]
	}
	if port == "" {
		return host, host
	}
	return net.JoinHostPort(host, port), host
}

// CaddyJSON renders the Caddy admin-API route object for r: a Host match
// paired with a reverse_proxy handler. When HostHeader is set (remote mode),
// a header_up request-header transform rewrites the outbound Host so the
// remote origin sees the correct vhost/SNI name. The object is tagged with
// "@id" = r.ID for later targeted deletion.
func (r Route) CaddyJSON() ([]byte, error) {
	handler := map[string]any{
		"handler": "reverse_proxy",
		"upstreams": []map[string]any{
			{"dial": r.Upstream},
		},
	}

	if r.HostHeader != "" {
		handler["headers"] = map[string]any{
			"request": map[string]any{
				"set": map[string]any{
					"Host": []string{r.HostHeader},
				},
			},
		}
	}

	route := map[string]any{
		"@id": r.ID,
		"match": []map[string]any{
			{"host": []string{r.HostMatch}},
		},
		"handle": []map[string]any{handler},
	}

	return json.Marshal(route)
}
