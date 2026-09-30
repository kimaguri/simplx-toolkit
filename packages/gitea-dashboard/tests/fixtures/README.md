# Fixtures

Synthetic JSON responses shaped like Gitea **v1.27.3** (field names verified against
`docs/swagger-1.27.3.json`; behaviour per `docs/specs/001-gitea-dashboard/research.md` R4–R8 and
`docs/specs/001-gitea-dashboard/contracts/gitea-api.md`). No real Gitea instance was contacted.

Fixed test world, reused across all files:

- `baseUrl`: `https://git.example.test`
- Users: `me` (id 1), `alice` (id 2), `bob` (id 3)
- Orgs: `acme` (id 10), `umbrella` (id 11)
- Repos: `acme/platform` (id 100), `acme/core` (id 101), `umbrella/web` (id 102),
  `me/dotfiles` (id 103)
- Timestamps cluster around `2026-09-26T10:00:00Z`

## Files

- **repos-search.json** — `GET /repos/search` (A4) response envelope `{ok, data[]}` with the
  four synthetic repos as `Repository` objects.
- **issues-search-review.json** — `GET /repos/issues/search?...review_requested=true` (A5):
  two open PRs (as `Issue` with `pull_request`), one of them a draft, requesting `me`'s review.
- **issues-search-created.json** — same endpoint with `created=true` (A6): one PR opened by `me`.
- **issues-search-org.json** — same endpoint with `owner=<org>` (A7): "other" open PRs not
  covered by review/created (used for `showOtherPrs`).
- **pulls-open.json** — `GET /repos/{o}/{r}/pulls?state=open` (A8): three `PullRequest` objects
  with `head.sha`/`head.ref`; one has `mergeable:false`, one is `draft:true`.
- **status-empty.json** — `GET /repos/{o}/{r}/commits/{sha}/status` (A9) with no statuses:
  `{state:"pending", total_count:0, statuses:null}` per R7 (empty response ⇒ treat as "none").
- **status-success.json** — combined status with one `success` context.
- **status-warning.json** — combined status with one `warning` context.
- **runs-active.json** — `GET /.../actions/runs?status=queued&status=waiting&status=in_progress`
  (A10): one run per active status (`queued`, `waiting`, `in_progress`), including a PR-triggered
  run with `pull_requests[]` populated (R6).
- **runs-recent.json** — `GET /.../actions/runs?limit=50` (A11): covers every completed
  `conclusion` (`success`, `failure`, `cancelled`, `skipped`), a scheduled/`workflow_dispatch`-like
  run with an empty `head_branch`, a tag run (`path` ends `@refs/tags/v1.0.0`), and a
  `completed` run with **no `conclusion` field at all** (R4 edge case: completed-without-conclusion
  is omitted, not `null`, and callers must treat it as the "unknown"/cancelling case).
- **runs-flood.json** — 60 runs by `alice`/`bob` (`pull_request` events) with ids `10000–10059`
  (recent/high ids), simulating a burst of third-party CI activity that could push a user's own
  runs off a 50-item page (R4 "мои не вытесняются").
- **runs-mine.json** — ~5 runs (ids `9000–9004`, actor `me`) that are **all older (lower ids)**
  than every id in `runs-flood.json`, so a naive merge+`limit 50` by `id DESC` would drop them —
  this is exactly the scenario the dedicated `actor=<me>` query (A15) exists to fix.
- **workflows.json** — `GET /repos/{o}/{r}/actions/workflows` (A13):
  `{total_count, workflows:[{id, name, path, state}]}` for the three workflow files referenced by
  the runs above (`ci.yml`, `lint.yml`, `nightly.yml`).
- **notifications.json** — `GET /notifications` (A14): two unread notification threads
  (`Pull`, `Issue` subjects).
- **user.json** — `GET /user` (A2): the `me` user object.
- **orgs.json** — `GET /user/orgs` (A3): `acme` and `umbrella`.
- **version.json** — `GET /version` (A1): `{version: "1.27.3"}`.

## Verification

Every fixture was validated to be parseable JSON:

```
node -e '
  const fs = require("fs");
  for (const f of fs.readdirSync(".").filter(f => f.endsWith(".json")))
    JSON.parse(fs.readFileSync(f, "utf8"));
'
```

All 17 files parsed successfully (`ALL_OK`).
