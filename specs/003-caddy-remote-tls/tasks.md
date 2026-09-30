# Tasks: Caddy remote-route TLS transport

**Input**: Design documents from `specs/003-caddy-remote-tls/` (spec.md, plan.md)
**Tests**: Included — TDD requested (project convention, [[plan.md]] Implementation Notes).

**Organization**: Single user story (P1) — this is a bug fix, not a multi-story feature.

## Phase 1: Setup

- [x] T001 Confirm existing test baseline passes before changes: `go test ./internal/proxy/...` in `/Users/al/simplx/.tools/simplx-toolkit/.worktrees/fix-lab-294-devdash-reliability`

## Phase 2: Foundational

*(No blocking prerequisites beyond Setup — single-file change.)*

## Phase 3: User Story 1 - Local frontend talks to a remote backend through devdash (Priority: P1)

**Goal**: Remote HTTPS routes built by `proxy.BuildRoute`/`Route.CaddyJSON` carry a TLS transport so Caddy actually performs a TLS handshake when dialing `https://` upstreams; local and `http://` remote routes are unaffected.

**Independent Test**: `go test ./internal/proxy/...` passes with new assertions proving TLS transport appears only for `https` remote routes; `go build ./...` succeeds.

### Tests for User Story 1 (write first — must fail before implementation)

- [x] T002 [P] [US1] In `internal/proxy/routes_test.go`, extend `TestBuildRoute_Remote_HTTPS` to assert `r.TLS == true`
- [x] T003 [P] [US1] In `internal/proxy/routes_test.go`, extend `TestBuildRoute_Remote_HTTP` to assert `r.TLS == false`
- [x] T004 [P] [US1] In `internal/proxy/routes_test.go`, extend `TestBuildRoute_Local` to assert `r.TLS == false`
- [x] T005 [P] [US1] In `internal/proxy/routes_test.go`, add `TestRoute_CaddyJSON_Remote_HTTPS_HasTLSTransport`: build an https remote route, call `CaddyJSON()`, assert the output contains `"transport"` and `"tls"`
- [x] T006 [P] [US1] In `internal/proxy/routes_test.go`, add `TestRoute_CaddyJSON_Remote_HTTP_NoTLSTransport`: build an http remote route, call `CaddyJSON()`, assert the output does NOT contain `"transport"`
- [x] T007 [P] [US1] In `internal/proxy/routes_test.go`, extend `TestRoute_CaddyJSON_Local` to assert the output does NOT contain `"transport"`
- [x] T008 [US1] Run `go test ./internal/proxy/...` and confirm the new/extended assertions from T002-T007 fail (red) against current `internal/proxy/routes.go` — do not proceed until confirmed red

### Implementation for User Story 1

- [x] T009 [US1] In `internal/proxy/routes.go`, add `TLS bool` field to the `Route` struct
- [x] T010 [US1] In `internal/proxy/routes.go`, change `parseRemoteUpstream` signature to `(upstream, hostHeader string, isTLS bool)`: well-formed URL branch sets `isTLS = u.Scheme == "https"`; malformed-URL fallback branch sets `isTLS` from which prefix (`https://` vs `http://`) was actually stripped, defaulting `isTLS = true` when neither prefix matched
- [x] T011 [US1] In `internal/proxy/routes.go`, update `BuildRoute` to receive the third return value from `parseRemoteUpstream` and set it on `Route.TLS` (local-mode branch leaves `TLS` at zero value `false`)
- [x] T012 [US1] In `internal/proxy/routes.go`, update `Route.CaddyJSON()`: when `r.TLS` is true, set `handler["transport"] = map[string]any{"protocol": "http", "tls": map[string]any{}}`
- [x] T013 [US1] Run `go test ./internal/proxy/...` and confirm all tests pass (green), including T002-T007
- [x] T014 [US1] Run `go build ./...` from `/Users/al/simplx/.tools/simplx-toolkit/.worktrees/fix-lab-294-devdash-reliability` and confirm the module builds clean

## Phase 4: Polish & Cross-Cutting Concerns

- [x] T015 Manually re-verify the original repro: rebuild/reinstall the `devdash` binary from this branch, re-run `devdash down`/`devdash up` for the `fix-lab-294-core-reliability-test` instance, and confirm a request to `/auth/dev-sign-in` (or `/auth/sign-in`) through the instance's `platform` remote route now returns the real backend's status (400, not the generic edge 404)

## Dependencies & Execution Order

- Phase 1 (T001) before everything.
- Phase 3 tests (T002-T007) can run in parallel with each other (`[P]`, same file but disjoint test functions — write all, then run once at T008).
- T008 (confirm red) gates T009-T012 (implementation).
- T009 → T010 → T011 → T012 strictly sequential (each edits overlapping code in the same functions/struct).
- T013 (confirm green) gates T014 (build).
- T014 gates T015 (manual verification, outside the Go test suite).

## Parallel Example

```text
# T002-T007 can be written together in one editing pass (same file, disjoint functions):
Task: "Extend TestBuildRoute_Remote_HTTPS to assert r.TLS == true"
Task: "Extend TestBuildRoute_Remote_HTTP to assert r.TLS == false"
Task: "Extend TestBuildRoute_Local to assert r.TLS == false"
Task: "Add TestRoute_CaddyJSON_Remote_HTTPS_HasTLSTransport"
Task: "Add TestRoute_CaddyJSON_Remote_HTTP_NoTLSTransport"
Task: "Extend TestRoute_CaddyJSON_Local with transport-absent assertion"
```

## Implementation Strategy

Single-story MVP: this whole feature IS the MVP (one bug, one fix). Complete Phase 1 → Phase 3 (tests red → implement → tests green → build) → Phase 4 (manual real-world confirmation) in one pass.
