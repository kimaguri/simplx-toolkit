# Implementation Plan: Caddy remote-route TLS transport

**Branch**: `fix/lab-294/devdash-reliability` | **Date**: 2026-09-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-caddy-remote-tls/spec.md`

## Summary

`proxy.Route.CaddyJSON()` never emits a Caddy `transport` block, so every remote-mode route dials its upstream over plain HTTP regardless of scheme/port. For `https://` remotes (the only kind used in practice — `*-test.sadmin.app`), this makes Caddy send a plaintext HTTP request to port 443; the real backend never performs a TLS handshake and never sees the request, and whatever edge/LB sits in front answers with a generic 404 that is indistinguishable from a real missing-route 404. Fix: track whether the remote upstream's scheme is HTTPS through `parseRemoteUpstream` → `BuildRoute` → `Route.TLS`, and when true, add `"transport": {"protocol": "http", "tls": {}}` to the `reverse_proxy` handler JSON — the standard Caddy idiom for a TLS-terminated dial inside an HTTP-semantics reverse proxy.

## Technical Context

**Language/Version**: Go (module `simplx-toolkit`, existing codebase — see `go.mod`)

**Primary Dependencies**: none new; uses only `encoding/json`, `net`, `net/url`, `strings` (already imported in `internal/proxy/routes.go`)

**Storage**: N/A

**Testing**: `go test` — extends existing table-style tests in `internal/proxy/routes_test.go`

**Target Platform**: devdash CLI, macOS/Linux dev machines (unchanged)

**Project Type**: CLI tool — single Go module

**Performance Goals**: N/A (one-time route-construction cost, negligible)

**Constraints**: Must not change behavior for `local` routes or `http`-scheme remote routes (regression-free); must not change `Route`'s public surface in a way that breaks the two existing call sites in `internal/orchestrator/up.go`

**Scale/Scope**: One file (`internal/proxy/routes.go`) + its test file (`internal/proxy/routes_test.go`); no other files touched

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Project constitution (`.specify/memory/constitution.md`) is an unfilled template — no project-specific principles are ratified yet. No gates apply beyond this repo's general TDD convention (tests first), which this plan follows. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/003-caddy-remote-tls/
├── plan.md              # This file
├── spec.md              # Feature spec
├── checklists/
│   └── requirements.md  # Spec quality checklist (already passing)
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

No `research.md`, `data-model.md`, `contracts/`, or `quickstart.md` are generated for this feature: there are no unresolved unknowns (root cause and fix are already confirmed by live reproduction against `platform-test.sadmin.app`), no data entities beyond the existing in-memory `Route` struct, and no external interface contract beyond the internal `Route.CaddyJSON()` output shape already covered by `Requirements` in spec.md and by the test plan below.

### Source Code (repository root)

```text
internal/proxy/
├── routes.go         # Route struct, BuildRoute, parseRemoteUpstream, CaddyJSON — all edits here
└── routes_test.go     # Existing table-style tests — extended here
```

**Structure Decision**: Single existing package (`internal/proxy`), no new files. This is a bug fix confined entirely to `internal/proxy/routes.go`'s route-construction logic and its existing test file — no orchestrator, CLI, or config changes needed (`internal/orchestrator/up.go`'s two `BuildRoute(...)` call sites pass the same arguments as today; the scheme is derived internally from the `remoteUpstream string` they already pass).

## Implementation Notes (for tasks.md)

1. Add `TLS bool` field to `Route` struct (`internal/proxy/routes.go`).
2. `parseRemoteUpstream(remoteUpstream string) (upstream, hostHeader string, isTLS bool)`:
   - Well-formed URL branch: `isTLS = u.Scheme == "https"`.
   - Malformed-URL fallback branch: preserve which prefix was actually stripped (`https://` vs `http://`) to set `isTLS` correctly instead of guessing; when neither prefix is present, default `isTLS = true` (matches real project configs, which are always `https://*-test.sadmin.app`).
3. `BuildRoute` sets `Route.TLS` from `parseRemoteUpstream`'s new return value; local-mode branch leaves `TLS` at its zero value (`false`).
4. `Route.CaddyJSON()`: when `r.TLS`, add `handler["transport"] = map[string]any{"protocol": "http", "tls": map[string]any{}}`.
5. Tests (TDD — write/extend first, confirm red, then implement):
   - `TestBuildRoute_Remote_HTTPS`: assert `r.TLS == true`.
   - `TestBuildRoute_Remote_HTTP`: assert `r.TLS == false`.
   - `TestBuildRoute_Local`: assert `r.TLS == false`.
   - New `TestRoute_CaddyJSON_Remote_HTTPS_HasTLSTransport`: JSON contains `"transport"` and `"tls"`.
   - New `TestRoute_CaddyJSON_Remote_HTTP_NoTLSTransport`: JSON does not contain `"transport"`.
   - `TestRoute_CaddyJSON_Local`: add assertion that `"transport"` is absent.
6. Verify: `go test ./internal/proxy/...`, then `go build ./...` for the whole module.

## Complexity Tracking

*No constitution violations — table not needed.*
