# Feature Specification: Caddy remote-route TLS transport

**Feature Branch**: `fix/lab-294/devdash-reliability`

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "devdash's Caddy reverse-proxy route for a 'remote' service never sets a TLS transport when the upstream is HTTPS, so Caddy dials remote upstreams over plain HTTP even on port 443. The real backend never sees the request; some edge/LB answers with a generic 404 that looks exactly like a normal missing route, making every request through any devdash instance configured with a remote service silently fail with no clear error."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Local frontend talks to a remote backend through devdash (Priority: P1)

A developer runs `devdash up` for a task instance with one or more services in `remote` mode (e.g. `platform: remote`, pointing at `https://platform-test.sadmin.app`). They expect requests made by their locally-running frontend/service, through the domain devdash assigns, to reach the real remote backend and get real responses.

**Why this priority**: This is the core promise of "remote" mode — without it, every remote-backed instance is silently broken, and developers waste time debugging their own frontend/backend code for a proxy-layer bug that isn't theirs.

**Independent Test**: Bring up an instance with a remote HTTPS service, hit any real endpoint on that service's devdash-assigned domain, and confirm the response matches what querying the real upstream URL directly returns (same status code, not a generic edge/LB fallback page).

**Acceptance Scenarios**:

1. **Given** an instance with a service in `remote` mode pointing at an `https://` upstream, **When** a request is sent to that service's devdash-assigned local domain, **Then** the response matches what the same request sent directly to the real upstream URL returns (e.g. a route that returns 400 upstream returns 400 through devdash, not a generic 404).
2. **Given** an instance with a service in `remote` mode pointing at an `http://` (non-TLS) upstream, **When** a request is sent to that service's local domain, **Then** the request is proxied over plain HTTP as before (no regression for non-TLS remotes).
3. **Given** an instance with a service in `local` mode, **When** a request is sent to that service's local domain, **Then** the request is proxied to `127.0.0.1:<port>` unchanged (no regression for local routes).

---

### Edge Cases

- What happens when the remote upstream URL has an explicit non-standard HTTPS port (e.g. `https://host:8443`)? TLS must still be used.
- What happens when the remote upstream URL is malformed / not a well-formed URL (existing fallback parsing path in `parseRemoteUpstream`)? Current behavior assumes such values came from an `https://`-prefixed source when that prefix was stripped; this fix must preserve that inference for the TLS decision too, so it doesn't regress previously-working malformed-URL fallbacks.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When building a route for a `remote` service whose upstream URL scheme is `https` (or whose value implies HTTPS via the existing malformed-URL fallback), the system MUST configure Caddy to perform a TLS handshake when dialing that upstream, regardless of the dial port.
- **FR-002**: When building a route for a `remote` service whose upstream URL scheme is `http`, the system MUST continue to proxy over plain HTTP (no TLS transport added).
- **FR-003**: When building a route for a `local` service (no remote upstream), the system MUST NOT add any TLS transport configuration (unchanged from current behavior).
- **FR-004**: The emitted Caddy route JSON MUST remain valid Caddy admin-API route configuration (parses successfully, existing `@id`/`match`/`headers` behavior unchanged) when the new transport field is added.

### Key Entities

- **Route**: devdash's internal representation of one Caddy reverse-proxy route (host match, dial upstream, optional Host-header rewrite, and — after this fix — an "is this upstream TLS" flag used to decide whether to emit a Caddy transport block).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every devdash instance with at least one `remote` HTTPS service, requests proxied through devdash to that service return the same status code as requests made directly to the real upstream, 100% of the time (verified for at least the reported case: `platform-test.sadmin.app`).
- **SC-002**: No existing devdash route behavior (local routes, remote HTTP routes, Host-header rewrite) changes status/behavior as a result of this fix — full existing `internal/proxy` test suite continues to pass unmodified.
- **SC-003**: A developer debugging "frontend can't reach backend" through a devdash remote-mode instance no longer needs to suspect the proxy layer for this specific failure mode — a request that reaches the real backend gets the real backend's response, not a generic edge/LB 404.

## Assumptions

- The remote upstream value passed to `BuildRoute` is always either a well-formed `http://`/`https://` URL, or (existing fallback path) a raw value that had an `https://` or `http://` prefix stripped before being passed in some caller path — this fix preserves and extends that existing assumption rather than introducing new upstream-format requirements.
- Caddy's `reverse_proxy` `transport` field with `{"protocol": "http", "tls": {}}` is the correct, minimal way to force a TLS-terminated dial for an HTTP-semantics reverse proxy in the Caddy admin API JSON config (Caddy's own convention for "HTTPS upstream over the HTTP reverse-proxy handler").
- No change to `devdash`'s CLI surface, config file schema, or route ID/host-match naming is needed — this is purely a transport-layer fix inside route construction.
