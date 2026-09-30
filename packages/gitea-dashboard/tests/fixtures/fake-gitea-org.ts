// T055: a fake Gitea 1.27.3 Actions server for one organization, with run
// shapes observed on the owner's live instance (org `simplx`, 28.09.2026):
// - tag build: event push, head_branch null, path `docker-build.yml@refs/tags/vX.Y.Z`
// - release on main: event push, head_branch main, path `release.yml@refs/heads/main`
// - push to test: head_branch test, path `docker-build.yml@refs/heads/test`
// - PR checks: event pull_request, head_branch null, path `pr.yml@refs/pull/N/head`
// - PR cleanup: event pull_request, head_branch null, path `pr-cleanup.yml@<40-hex sha>`
// Paging like the server: `page` (1-based) / `limit` (default 30 =
// default_paging_num, capped at 50 = max_response_items), newest first
// (id desc), `total_count` = all runs matching the endpoint.
//
// Gitea serializes a never-started run's `started_at` (and a not-finished
// run's `completed_at`) from a zero TimeStamp, i.e. the Unix epoch in the
// server's time zone — `notStartedEvery` seeds such runs (cancelled while
// queued by concurrency groups), `waitingHead` puts one waiting run on top.

import { vi } from 'vitest';

export const ORG = 'simplx';
export const REPOS = ['platform', 'simplx-apps', 'simplx-core', 'simplx-specs', 'predictor'] as const;
export const EPOCH = '1970-01-01T05:00:00+05:00';
const MAX_RESPONSE_ITEMS = 50;
const DEFAULT_PAGING_NUM = 30;

/** The 9 version-tag runs of the Almaty day 28.09.2026 (from 2026-09-27T19:00Z). */
export const TODAY_RELEASES: readonly { repo: string; tag: string; at: string }[] = [
  { repo: 'simplx-apps', tag: 'v1.39.1', at: '2026-09-27T20:07:00Z' },
  { repo: 'simplx-apps', tag: 'v1.40.0', at: '2026-09-28T07:23:00Z' },
  { repo: 'simplx-apps', tag: 'v1.41.0', at: '2026-09-28T10:48:00Z' },
  { repo: 'simplx-apps', tag: 'v1.41.1', at: '2026-09-28T17:59:00Z' },
  { repo: 'simplx-core', tag: 'v1.42.1', at: '2026-09-27T20:01:00Z' },
  { repo: 'simplx-core', tag: 'v1.43.0', at: '2026-09-28T10:50:00Z' },
  { repo: 'platform', tag: 'v1.44.0', at: '2026-09-28T09:10:00Z' },
  { repo: 'platform', tag: 'v1.45.0', at: '2026-09-28T13:40:00Z' },
  { repo: 'platform', tag: 'v1.45.1', at: '2026-09-28T17:59:30Z' },
];

export type ApiRunJson = Record<string, unknown> & { id: number; repository: { full_name: string } };

interface Seed {
  repo: string;
  at: number;
  kind: 'tag' | 'main' | 'test' | 'pr' | 'cleanup';
  tag?: string;
  notStarted?: boolean;
  waiting?: boolean;
}

export interface OrgOptions {
  now: Date;
  days: number;
  perDay: number;
  /** Every Nth generated run was cancelled before it started (epoch `started_at`). */
  notStartedEvery?: number;
  /** A run still waiting for a runner on top of the list (epoch `started_at`/`completed_at`). */
  waitingHead?: boolean;
  /** Include TODAY_RELEASES (default true). */
  releases?: boolean;
}

function hex40(n: number): string {
  return n.toString(16).padStart(40, 'a');
}

function toJson(seed: Seed, id: number): ApiRunJson {
  const iso = new Date(seed.at).toISOString();
  const done = new Date(seed.at + 4 * 60 * 1000).toISOString();
  const pr = 1 + (id % 90);
  const shape: Record<string, unknown> = (() => {
    switch (seed.kind) {
      case 'tag':
        return { event: 'push', head_branch: null, path: `docker-build.yml@refs/tags/${seed.tag}`, display_title: `release ${seed.tag}` };
      case 'main':
        return { event: 'push', head_branch: 'main', path: 'release.yml@refs/heads/main', display_title: 'Merge into main' };
      case 'test':
        return { event: 'push', head_branch: 'test', path: 'docker-build.yml@refs/heads/test', display_title: 'Merge into test' };
      case 'pr':
        return { event: 'pull_request', head_branch: null, path: `pr.yml@refs/pull/${pr}/head`, display_title: `PR #${pr}` };
      case 'cleanup':
        return { event: 'pull_request', head_branch: null, path: `pr-cleanup.yml@${hex40(id)}`, display_title: `PR #${pr} closed` };
    }
  })();
  const status = seed.waiting ? 'waiting' : 'completed';
  const conclusion = seed.waiting ? '' : seed.notStarted ? 'cancelled' : 'success';
  return {
    id,
    run_attempt: 1,
    run_number: id,
    status,
    conclusion,
    head_sha: hex40(id * 7),
    actor: { login: 'dev' },
    trigger_actor: { login: 'dev' },
    repository: { full_name: `${ORG}/${seed.repo}` },
    html_url: `https://git.example.test/${ORG}/${seed.repo}/actions/runs/${id}`,
    started_at: seed.notStarted || seed.waiting ? EPOCH : iso,
    completed_at: seed.waiting ? EPOCH : seed.notStarted ? iso : done,
    pull_requests: [],
    ...shape,
  };
}

/** All runs of the org, newest (highest id) first. */
export function buildOrgRuns(opts: OrgOptions): ApiRunJson[] {
  const nowMs = opts.now.getTime();
  const total = opts.days * opts.perDay;
  const step = (24 * 60 * 60 * 1000) / opts.perDay;
  const seeds: Seed[] = [];
  for (let i = 0; i < total; i++) {
    const at = nowMs - 5 * 60 * 1000 - (total - 1 - i) * step;
    const repo = REPOS[i % REPOS.length]!;
    const kind: Seed['kind'] = i % 10 === 3 ? 'test' : i % 23 === 5 ? 'main' : i % 7 === 2 ? 'cleanup' : 'pr';
    const notStarted = !!opts.notStartedEvery && i % opts.notStartedEvery === 0 && kind !== 'test';
    seeds.push({ repo, at, kind, notStarted });
  }
  if (opts.releases !== false) {
    for (const r of TODAY_RELEASES) seeds.push({ repo: r.repo, at: Date.parse(r.at), kind: 'tag', tag: r.tag });
  }
  if (opts.waitingHead) seeds.push({ repo: 'platform', at: nowMs - 60 * 1000, kind: 'test', waiting: true });
  seeds.sort((a, b) => a.at - b.at);
  return seeds.map((s, i) => toJson(s, 10_000 + i)).reverse();
}

export interface FakeGitea {
  fetch: ReturnType<typeof vi.fn>;
  /** Every runs request as `<source>?page=N` (source = `org:simplx` | `repo:simplx/x`). */
  runRequests: string[];
  /** Replace the server's data (e.g. new runs appeared, a run started). */
  setRuns(runs: ApiRunJson[]): void;
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

export function fakeGitea(initial: ApiRunJson[]): FakeGitea {
  let runs = initial;
  const runRequests: string[] = [];
  const page = (list: ApiRunJson[], url: URL): unknown => {
    const p = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const rawLimit = Number(url.searchParams.get('limit') ?? '0') || DEFAULT_PAGING_NUM;
    const limit = Math.min(rawLimit, MAX_RESPONSE_ITEMS);
    return { total_count: list.length, workflow_runs: list.slice((p - 1) * limit, p * limit) };
  };
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (path === '/settings/api') {
      return json({ max_response_items: MAX_RESPONSE_ITEMS, default_paging_num: DEFAULT_PAGING_NUM });
    }
    const org = /^\/orgs\/([^/]+)\/actions\/runs$/.exec(path);
    if (org) {
      runRequests.push(`org:${org[1]}?page=${url.searchParams.get('page') ?? '1'}`);
      return json(page(runs, url));
    }
    const repo = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(path);
    if (repo) {
      const full = `${repo[1]}/${repo[2]}`;
      runRequests.push(`repo:${full}?page=${url.searchParams.get('page') ?? '1'}`);
      return json(page(runs.filter((r) => r.repository.full_name === full), url));
    }
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs$/.test(path)) return json({ total_count: 0, jobs: [] });
    if (path === '/user/repos' || path.startsWith('/users/')) return json([]);
    throw new Error(`unexpected request: ${path}${url.search}`);
  });
  return {
    fetch,
    runRequests,
    setRuns(next) {
      runs = next;
    },
  };
}
