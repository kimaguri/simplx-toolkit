#!/usr/bin/env node
// Dev-only visual QA tool (T080): builds the extension, loads it in a real
// (headless) Chromium via Playwright, seeds `chrome.storage` directly with a
// realistic fake instance/snapshot (see src/lib/storage.ts for the exact key
// layout) and screenshots the popup's three tabs + the options page, in
// light and dark, to docs/screenshots/*.png.
//
// IMPORTANT: this never touches the network. Host-permission prompts for a
// real Gitea instance can't be automated in headless Chrome, so instead of
// pointing the extension at a live/fake server we:
//   1. Seed `instances`/`token:<id>`/`snapshot:<id>`/`pins:<id>` etc.
//     directly via `serviceWorker.evaluate(() => chrome.storage...)`.
//   2. Seed `poll:<id>` with `pausedForAuth: true` so the background
//      poller's `doCycle` returns immediately (see
//      src/background/poller/index.ts) without ever calling `fetch()` --
//      deterministic, no flakiness, no "Stale" banner.
//   3. Route-intercept `**/api/v1/**` on every page we open, as a second
//      safety net (the "Репо" tab calls `searchRepos` directly on mount,
//      independent of the poller/snapshot flow -- see
//      src/entrypoints/popup/tabs/Repos.tsx) -- fulfilling `/repos/search`
//      with canned data so the empty-query pinned list renders realistically
//      instead of showing an error.
//
// Run: `pnpm screenshots` (implies `wxt build` first).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT, '.output', 'chrome-mv3');
const SHOTS_DIR = resolve(ROOT, 'docs', 'screenshots');

const BASE_URL = 'https://git.example.test';

// ---------------------------------------------------------------------------
// instanceId -- must match src/lib/storage.ts's `instanceId()` exactly:
// `i_` + first 8 hex chars of sha1(normalizedBaseUrl). BASE_URL above is
// already in normalized form (https, no trailing slash, no /api/v1), so no
// need to replicate normalizeBaseUrl()'s trimming logic here.
// ---------------------------------------------------------------------------
function instanceIdSync(normalizedBaseUrl) {
  const hex = createHash('sha1').update(normalizedBaseUrl).digest('hex').slice(0, 8);
  return `i_${hex}`;
}

const INSTANCE_ID = instanceIdSync(BASE_URL);

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------
// Fake data -- domain shapes from src/domain/types.ts.
// ---------------------------------------------------------------------------

const PINS = [
  { owner: 'acme', name: 'platform' },
  { owner: 'acme', name: 'billing' },
];

// Canned /repos/search response (ApiSearchResults) for the empty-query load
// on the "Репо" tab -- includes the pinned repos (so they resolve to real
// data instead of placeholders) plus a few extra, sorted by updated_at desc.
const REPO_SEARCH_RESPONSE = {
  ok: true,
  data: [
    {
      full_name: 'acme/platform',
      owner: { login: 'acme' },
      name: 'platform',
      private: true,
      updated_at: iso(20 * MIN),
      html_url: `${BASE_URL}/acme/platform`,
      has_actions: true,
    },
    {
      full_name: 'acme/billing',
      owner: { login: 'acme' },
      name: 'billing',
      private: true,
      updated_at: iso(3 * HOUR),
      html_url: `${BASE_URL}/acme/billing`,
      has_actions: true,
    },
    {
      full_name: 'umbrella/infra',
      owner: { login: 'umbrella' },
      name: 'infra',
      private: false,
      updated_at: iso(6 * HOUR),
      html_url: `${BASE_URL}/umbrella/infra`,
      has_actions: true,
    },
    {
      full_name: 'acme/api',
      owner: { login: 'acme' },
      name: 'api',
      private: true,
      updated_at: iso(26 * HOUR),
      html_url: `${BASE_URL}/acme/api`,
      has_actions: true,
    },
  ],
};

// Canned GET /repos/:owner/:repo/actions/runs/:id/jobs response
// (ApiWorkflowJobsResponse, src/api/types.ts) for every currently-running
// run -- used by the "build stage" feature (src/features/builds/run-jobs.ts)
// both for the heartbeat's batch `load()` (history/groups views) and for a
// row's explicit `loadOne()` on expand. Same fixture regardless of which
// run/repo asked -- deterministic, no per-run branching needed here.
const JOBS_RESPONSE = {
  total_count: 2,
  jobs: [
    {
      id: 1,
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      started_at: iso(6 * MIN),
      completed_at: iso(5 * MIN),
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Run lint', status: 'completed', conclusion: 'success' },
        { number: 3, name: 'Complete job', status: 'completed', conclusion: 'success' },
      ],
    },
    {
      id: 2,
      name: 'build',
      status: 'in_progress',
      started_at: iso(5 * MIN),
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Checkout', status: 'completed', conclusion: 'success' },
        { number: 3, name: 'Build', status: 'in_progress' },
        { number: 4, name: 'Test', status: 'queued' },
        { number: 5, name: 'Package', status: 'queued' },
        { number: 6, name: 'Upload artifact', status: 'queued' },
        { number: 7, name: 'Complete job', status: 'queued' },
      ],
    },
  ],
};

function pr({ id, owner, name, number, title, author, updatedAt, draft, group, mergeable, ci, baseRef }) {
  return {
    id,
    repo: { owner, name },
    number,
    title,
    author,
    updatedAt,
    htmlUrl: `${BASE_URL}/${owner}/${name}/pulls/${number}`,
    draft: Boolean(draft),
    group,
    headSha: 'a1b2c3d',
    headRef: `feature/pr-${number}`,
    baseRef: baseRef ?? 'main',
    ...(mergeable !== undefined ? { mergeable } : {}),
    ci: { state: ci, fetchedAt: iso(2 * MIN) },
  };
}

const PRS = [
  // "Нужно моё ревью" (3)
  pr({
    id: 1,
    owner: 'acme',
    name: 'platform',
    number: 412,
    title: 'Добавить ретраи в API-клиент',
    author: 'nikita',
    updatedAt: iso(2 * HOUR),
    group: 'review',
    ci: 'success',
  }),
  pr({
    id: 2,
    owner: 'acme',
    name: 'billing',
    number: 88,
    title: 'Fix invoice rounding for KZT',
    author: 'olga',
    updatedAt: iso(5 * HOUR),
    group: 'review',
    ci: 'pending',
  }),
  pr({
    id: 3,
    owner: 'umbrella',
    name: 'infra',
    number: 15,
    title: 'Migrate CI runners to Node 22',
    author: 'sergey',
    updatedAt: iso(26 * HOUR),
    group: 'review',
    ci: 'failure',
  }),
  // "Мои PR" (2) -- one draft, one with a merge conflict.
  pr({
    id: 4,
    owner: 'acme',
    name: 'platform',
    number: 420,
    title: 'WIP: новые виджеты дашборда',
    author: 'me',
    updatedAt: iso(30 * MIN),
    draft: true,
    group: 'mine',
    ci: 'pending',
  }),
  pr({
    id: 5,
    owner: 'acme',
    name: 'billing',
    number: 91,
    title: 'Рефакторинг слоя хранилища',
    author: 'me',
    updatedAt: iso(4 * HOUR),
    mergeable: false,
    group: 'mine',
    ci: 'failure',
  }),
  // "Остальные открытые" (3)
  pr({
    id: 6,
    owner: 'acme',
    name: 'platform',
    number: 405,
    title: 'Bump dependencies',
    author: 'daria',
    updatedAt: iso(8 * HOUR),
    group: 'other',
    ci: 'success',
  }),
  pr({
    id: 7,
    owner: 'umbrella',
    name: 'infra',
    number: 12,
    title: 'Add staging environment',
    author: 'pavel',
    updatedAt: iso(30 * HOUR),
    group: 'other',
    ci: 'none',
  }),
  pr({
    id: 8,
    owner: 'acme',
    name: 'api',
    number: 60,
    title: 'Document rate limits',
    author: 'olga',
    updatedAt: iso(50 * HOUR),
    group: 'other',
    ci: 'success',
  }),
  // T056: matches RUNS' PR check run (acme/platform#81) so "Все запуски"
  // shows "#81 -> test" in the branch column/facet instead of a dash.
  pr({
    id: 9,
    owner: 'acme',
    name: 'platform',
    number: 81,
    title: 'Add integration smoke test',
    author: 'daria',
    updatedAt: iso(9 * MIN),
    group: 'other',
    ci: 'success',
    baseRef: 'test',
  }),
];

function run({ id, owner, name, number, workflow, branch, event, actor, state, startedAgo, completedAgo, mine, group, title, prNumber, baseRef }) {
  return {
    id,
    attempt: 1,
    number,
    repo: { owner, name },
    branch,
    event,
    actor,
    headSha: 'a1b2c3d',
    htmlUrl: `${BASE_URL}/${owner}/${name}/actions/runs/${id}`,
    title: title ?? `${event}: ${branch}`,
    workflow,
    state,
    ...(startedAgo !== undefined ? { startedAt: iso(startedAgo) } : {}),
    ...(completedAgo !== undefined ? { completedAt: iso(completedAgo) } : {}),
    mine,
    group,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(baseRef !== undefined ? { baseRef } : {}),
  };
}

const RUNS = [
  // "Мои и закреплённые" (mine) -- one of each state.
  run({
    id: 101,
    owner: 'acme',
    name: 'platform',
    number: 55,
    workflow: 'CI',
    branch: 'feature/retries',
    event: 'push',
    actor: 'me',
    state: 'running',
    startedAgo: 3 * MIN,
    mine: true,
    group: 'mine',
  }),
  run({
    id: 102,
    owner: 'acme',
    name: 'billing',
    number: 20,
    workflow: 'Deploy',
    branch: 'main',
    event: 'workflow_dispatch',
    actor: 'me',
    state: 'waiting',
    mine: true,
    group: 'mine',
  }),
  run({
    id: 103,
    owner: 'acme',
    name: 'billing',
    number: 19,
    workflow: 'CI',
    branch: 'fix/rounding',
    event: 'pull_request',
    actor: 'me',
    state: 'success',
    startedAgo: 40 * MIN,
    completedAgo: 35 * MIN,
    mine: true,
    group: 'mine',
  }),
  run({
    id: 104,
    owner: 'acme',
    name: 'platform',
    number: 53,
    workflow: 'Lint',
    branch: 'chore/deps',
    event: 'push',
    actor: 'me',
    state: 'failure',
    startedAgo: HOUR,
    completedAgo: 58 * MIN,
    mine: true,
    group: 'mine',
  }),
  run({
    id: 105,
    owner: 'acme',
    name: 'billing',
    number: 18,
    workflow: 'CI',
    branch: 'refactor/storage',
    event: 'pull_request',
    actor: 'me',
    state: 'cancelled',
    startedAgo: 2 * HOUR,
    completedAgo: 118 * MIN,
    mine: true,
    group: 'mine',
  }),
  // "Остальные" (6)
  run({
    id: 201,
    owner: 'acme',
    name: 'platform',
    number: 56,
    workflow: 'CI',
    branch: 'main',
    event: 'push',
    actor: 'olga',
    state: 'running',
    startedAgo: MIN,
    mine: false,
    group: 'others',
  }),
  run({
    id: 202,
    owner: 'umbrella',
    name: 'infra',
    number: 30,
    workflow: 'Deploy',
    branch: 'release/1.4',
    event: 'push',
    actor: 'sergey',
    state: 'waiting',
    mine: false,
    group: 'others',
  }),
  run({
    id: 203,
    owner: 'acme',
    name: 'platform',
    number: 54,
    workflow: 'CI',
    branch: 'feature/x',
    event: 'pull_request',
    actor: 'nikita',
    state: 'success',
    startedAgo: 20 * MIN,
    completedAgo: 15 * MIN,
    mine: false,
    group: 'others',
  }),
  run({
    id: 204,
    owner: 'acme',
    name: 'api',
    number: 40,
    workflow: 'CI',
    branch: 'feature/y',
    event: 'pull_request',
    actor: 'daria',
    state: 'failure',
    startedAgo: 50 * MIN,
    completedAgo: 45 * MIN,
    mine: false,
    group: 'others',
  }),
  run({
    id: 205,
    owner: 'umbrella',
    name: 'infra',
    number: 29,
    workflow: 'Nightly',
    branch: 'main',
    event: 'schedule',
    actor: 'bot',
    state: 'failure',
    startedAgo: 6 * HOUR,
    completedAgo: 5 * HOUR + 50 * MIN,
    mine: false,
    group: 'others',
  }),
  run({
    id: 206,
    owner: 'acme',
    name: 'platform',
    number: 52,
    workflow: 'CI',
    branch: 'hotfix/timeout',
    event: 'push',
    actor: 'pavel',
    state: 'cancelled',
    startedAgo: 3 * HOUR,
    completedAgo: 2 * HOUR + 55 * MIN,
    mine: false,
    group: 'others',
  }),
  // T056: a PR check run (head_branch empty, PR number parsed from the
  // path) with baseRef straight from the run (T056 priority: Gitea's
  // pull_requests[].base.ref over the snapshot) -> branch column/facet show
  // "#81 -> test" instead of a dash. PRS #81 below also carries baseRef
  // 'test', for the (older-cache) snapshot-lookup fallback.
  run({
    id: 207,
    owner: 'acme',
    name: 'platform',
    number: 57,
    workflow: 'CI',
    branch: '',
    event: 'pull_request',
    actor: 'daria',
    state: 'success',
    startedAgo: 10 * MIN,
    completedAgo: 8 * MIN,
    mine: false,
    group: 'others',
    prNumber: 81,
    baseRef: 'test',
  }),
];

// 22 extra "other" PRs so the PR table exceeds one 25-row page (pagination footer).
for (let n = 0; n < 22; n += 1) {
  PRS.push(
    pr({
      id: 100 + n,
      owner: ['acme', 'umbrella', 'simplx'][n % 3],
      name: ['api', 'infra', 'core'][n % 3],
      number: 200 + n,
      title: `Maintenance task #${n + 1}`,
      author: ['olga', 'daria', 'pavel'][n % 3],
      updatedAt: iso((60 + n * 30) * MIN),
      group: 'other',
      ci: ['success', 'none', 'pending'][n % 3],
    })
  );
}

const ACTIVE_RUN_STATES = new Set(['waiting', 'blocked', 'running']);
const activeMine = RUNS.filter((r) => r.group === 'mine' && ACTIVE_RUN_STATES.has(r.state)).length;
const activeOthers = RUNS.filter((r) => r.group === 'others' && ACTIVE_RUN_STATES.has(r.state)).length;
const failedOthers = RUNS.filter((r) => r.group === 'others' && r.state === 'failure').length;
const reviewsCount = PRS.filter((p) => p.group === 'review').length;

const SNAPSHOT = {
  fetchedAt: iso(30_000),
  prs: PRS,
  runs: RUNS,
  counts: {
    reviews: reviewsCount,
    activeMine,
    activeOthers,
    failedOthers,
  },
  prTotals: { review: 5, mine: 2, other: 28 },
};

const DEFAULT_SETTINGS = {
  pollIntervalSec: 60,
  badgeMode: 'reviews',
  recentWindowHours: 24,
  redBadgeWindowMin: 30,
  showOtherPrs: true,
  notify: {
    buildFailed: 'mine',
    buildSucceededMyPr: false,
    reviewRequested: true,
    comments: false,
  },
  scope: { excludeRepos: [], excludeOrgs: [], includeRepos: [] },
  repoModeLimit: 30,
};

const INSTANCE = {
  id: INSTANCE_ID,
  baseUrl: BASE_URL,
  login: 'me',
  userId: 1,
  serverVersion: '1.27.3',
  capabilities: {
    actions: 'org',
    notifications: true,
    orgs: ['acme', 'umbrella'],
    missingScopes: [],
  },
  checkedAt: iso(30_000),
};

// ---------------------------------------------------------------------------
// Run history fixtures (T025) -- dashboard.html "Сборки" history view.
//
// The history loader (src/features/builds/history-loader.ts) never touches
// the network here: for our fake instance (capabilities.actions === 'org',
// orgs = ['acme', 'umbrella'], pins = acme/platform + acme/billing),
// `runSources` in 'base' mode produces exactly four distinct history
// sources after dedup -- `org:acme`, `org:umbrella`, `repo:acme/platform`,
// `repo:acme/billing` -- so we seed `runsHistory:<instanceId>:<sourceKey>`
// for exactly those four keys, each `fresh` (fetchedAt just now, well
// within the 5 min TTL) AND `exhausted: true`, so `loadHistory` treats
// every source as already fully covered and makes zero requests. We also
// seed `apiSettings:<instanceId>` (24h cache) so even the `max_response_items`
// lookup is skipped.
//
// To keep the four sources' runs non-overlapping (since a real org-wide
// Actions endpoint would actually overlap with its pinned repos, but we
// don't want to rely on `mergeRunPages`'s by-id dedup to hide that), each
// source is given its own repo: `org:acme` -> acme/api, `org:umbrella` ->
// umbrella/infra, `repo:acme/platform` -> acme/platform itself,
// `repo:acme/billing` -> acme/billing itself. Three workflow files
// (`ci.yml`, `deploy.yml`, `nightly.yml`) are spread across those four
// repos, with human names supplied via the `workflows:<instanceId>` cache
// (`src/features/builds/BuildsHistory.tsx` looks up `"<owner>/<name>::<file>"`).
// ---------------------------------------------------------------------------

const DAY = 24 * HOUR;

const HISTORY_WORKFLOW_NAMES = {
  'acme/platform::ci.yml': 'CI',
  'acme/platform::deploy.yml': 'Deploy',
  'acme/billing::ci.yml': 'CI',
  'acme/billing::deploy.yml': 'Deploy',
  'acme/api::ci.yml': 'CI',
  'acme/api::nightly.yml': 'Nightly',
  'umbrella/infra::ci.yml': 'CI',
  'umbrella/infra::nightly.yml': 'Nightly',
  // The three running "simplx/*" override runs (T038) all use `ci.yml`
  // (workflows[0] of their source).
  'simplx/platform::ci.yml': 'CI',
  'simplx/platform::docker-build.yml': 'docker-build',
  'simplx/core::ci.yml': 'CI',
  'simplx/apps::ci.yml': 'CI',
};

const RUN_ACTORS = ['me', 'olga', 'sergey', 'bot', 'nikita', 'daria', 'pavel'];
const RUN_BRANCHES = ['main', 'test', 'feature/retries', 'fix/rounding', 'release/1.4', 'chore/deps'];
const RUN_EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch'];
// Mostly success, a healthy dose of failures/cancellations, no more than
// one active run per source (index 0, most recent) so the stats look like
// a real 7-day window rather than an all-green or all-broken fixture.
const RUN_RESULT_PATTERN = [
  'success',
  'success',
  'failure',
  'success',
  'cancelled',
  'success',
  'failure',
  'success',
  'success',
  'failure',
];

/**
 * Generates `count` synthetic completed/active runs for one history source,
 * spread evenly back over 7 days (index 0 = most recent), alternating
 * between `workflows`, deterministic (no Math.random) so screenshots are
 * reproducible across runs.
 *
 * `runningOverride` (T038, part b) lets the still-running index-0 run use a
 * different owner/name/branch than the rest of the source -- so the
 * "history" screenshots have running rows on `simplx/platform`,
 * `simplx/core`, `simplx/apps` (branches `main`/`test`/`feature/x`),
 * demonstrating both the repo-tag owner-prefix removal (RepoTag/repoLabel,
 * src/domain/labels.ts) and the branch tag tones (BranchTag).
 */
function genHistoryRuns({ idBase, owner, name, workflows, runningOverride }, count) {
  const runs = [];
  for (let i = 0; i < count; i += 1) {
    const workflow = workflows[i % workflows.length];
    const number = 100 + i;
    const id = idBase + i;
    const branch = RUN_BRANCHES[i % RUN_BRANCHES.length];
    const event = RUN_EVENTS[i % RUN_EVENTS.length];
    const actor = RUN_ACTORS[i % RUN_ACTORS.length];
    // First 30 runs are packed into the last ~2h (so «Сегодня» is well
    // populated and the pagination footer shows), the rest spread over 7 days.
    const startedAgo =
      i < 30 ? 10 * MIN + i * 4 * MIN : Math.round(((i - 30) / Math.max(count - 30, 1)) * (7 * DAY) + 3 * HOUR);

    if (i === 0) {
      // Most recent run of each source is still in flight -- no completedAt.
      runs.push(
        run({
          id,
          owner: runningOverride?.owner ?? owner,
          name: runningOverride?.name ?? name,
          number,
          workflow,
          branch: runningOverride?.branch ?? branch,
          event,
          actor,
          state: 'running',
          startedAgo: 4 * MIN,
          mine: actor === 'me',
          group: actor === 'me' ? 'mine' : 'others',
        })
      );
      continue;
    }

    const state = RUN_RESULT_PATTERN[i % RUN_RESULT_PATTERN.length];
    const durationSec = 45 + ((i * 37) % 600); // 45s..~10.5min, deterministic spread
    const completedAgo = Math.max(startedAgo - durationSec * 1000, 0);
    runs.push(
      run({
        id,
        owner,
        name,
        number,
        workflow,
        branch,
        event,
        actor,
        state,
        startedAgo,
        completedAgo,
        mine: actor === 'me',
        group: actor === 'me' ? 'mine' : 'others',
      })
    );
  }
  return runs;
}

const HISTORY_SOURCES = {
  'org:acme': genHistoryRuns(
    {
      idBase: 1000,
      owner: 'acme',
      name: 'api',
      workflows: ['ci.yml', 'nightly.yml'],
      runningOverride: { owner: 'simplx', name: 'platform', branch: 'main' },
    },
    40
  ),
  'org:umbrella': genHistoryRuns(
    {
      idBase: 2000,
      owner: 'umbrella',
      name: 'infra',
      workflows: ['ci.yml', 'nightly.yml'],
      runningOverride: { owner: 'simplx', name: 'core', branch: 'test' },
    },
    40
  ),
  'repo:acme/platform': [
    // Real release build (rev.5): push of tag v1.45.1 -- the ref is the tag
    // name, the title is the head merge-commit message (no version in it).
    run({
      id: 3900,
      owner: 'simplx',
      name: 'platform',
      number: 242,
      workflow: 'docker-build.yml',
      branch: 'v1.45.1',
      event: 'push',
      actor: 'simplx-ci-bot',
      state: 'success',
      startedAgo: 20 * MIN,
      completedAgo: 14 * MIN,
      mine: false,
      group: 'others',
      title: "Merge pull request 'fix(LAB-313): пересчёт' (#78) from feat/lab-313/koreana-demo-bugs into main",
    }),
    // T056: a PR check run (head_branch empty, PR number parsed from the
    // path) with baseRef straight from the run -- "Все запуски" shows
    // "#81 -> test" in the branch column/facet.
    run({
      id: 3950,
      owner: 'acme',
      name: 'platform',
      number: 57,
      workflow: 'ci.yml',
      branch: '',
      event: 'pull_request',
      actor: 'daria',
      state: 'success',
      startedAgo: 12 * MIN,
      completedAgo: 10 * MIN,
      mine: false,
      group: 'others',
      prNumber: 81,
      baseRef: 'test',
    }),
    ...genHistoryRuns(
      {
        idBase: 3000,
        owner: 'acme',
        name: 'platform',
        workflows: ['ci.yml', 'deploy.yml'],
        runningOverride: { owner: 'simplx', name: 'apps', branch: 'feature/x' },
      },
      40
    ),
  ],
  'repo:acme/billing': genHistoryRuns(
    { idBase: 4000, owner: 'acme', name: 'billing', workflows: ['ci.yml', 'deploy.yml'] },
    40
  ),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run_(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

async function seedStorage(serviceWorker) {
  await serviceWorker.evaluate(
    async ({
      instanceId,
      instance,
      token,
      settings,
      pins,
      snapshot,
      poll,
      ui,
      apiSettings,
      runHistory,
      workflows,
      repoColors,
    }) => {
      const runHistoryEntries = {};
      for (const [sourceKey, runs] of Object.entries(runHistory)) {
        const oldestStartedAt = runs.reduce((oldest, r) => {
          if (!r.startedAt) return oldest;
          return !oldest || r.startedAt < oldest ? r.startedAt : oldest;
        }, undefined);
        runHistoryEntries[`runsHistory:${instanceId}:${sourceKey}`] = {
          fetchedAt: apiSettings.fetchedAt,
          runs,
          nextPage: 2,
          exhausted: true,
          oldestStartedAt,
        };
      }

      await chrome.storage.local.set({
        instances: { instances: [instance], activeInstanceId: instanceId },
        [`token:${instanceId}`]: token,
        [`snapshot:${instanceId}`]: snapshot,
        // pausedForAuth: true -- the poller's doCycle() returns immediately
        // without any fetch (see src/background/poller/index.ts), so the
        // 'refresh' message the popup sends on open never touches the
        // network and never overwrites/errors the seeded snapshot.
        [`poll:${instanceId}`]: poll,
        ui,
        [`apiSettings:${instanceId}`]: apiSettings,
        [`workflows:${instanceId}`]: workflows,
        ...runHistoryEntries,
      });
      await chrome.storage.sync.set({
        settings,
        [`pins:${instanceId}`]: pins,
        [`repoColors:${instanceId}`]: repoColors,
      });
    },
    {
      instanceId: INSTANCE_ID,
      instance: INSTANCE,
      token: 'test-token',
      settings: DEFAULT_SETTINGS,
      pins: PINS,
      snapshot: SNAPSHOT,
      poll: { mode: 'base', backoffSec: 0, pausedForAuth: true },
      ui: { lastTab: 'repos', othersCollapsed: true },
      apiSettings: { fetchedAt: iso(30_000), maxResponseItems: 50 },
      runHistory: HISTORY_SOURCES,
      workflows: { fetchedAt: iso(30_000), names: HISTORY_WORKFLOW_NAMES },
      // Custom colour for acme/platform (tone 4 = orange) -- shows in PR/history repo tags.
      repoColors: { 'acme/platform': 4 },
    }
  );
}

/** Route-intercept every Gitea API call a page might make (belt-and-braces:
 * the poller never fetches because it's paused, but the "Репо" tab talks to
 * the API directly on mount). */
// Chromium intermittently answers ERR_FILE_NOT_FOUND for a chrome-extension:// URL
// right after another page closed -- retry a few times.
async function gotoRetry(page, url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await page.goto(url);
    } catch (err) {
      if (attempt >= 4) throw err;
      await page.waitForTimeout(500);
    }
  }
}

async function stubNetwork(page) {
  // Playwright checks routes most-recently-registered-first, so the
  // catch-all must be added BEFORE the more specific `/repos/search`
  // override -- otherwise the catch-all would win and `/repos/search` would
  // always see `{ ok: true, data: [] }`.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) })
  );
  await page.route('**/api/v1/repos/search**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPO_SEARCH_RESPONSE) })
  );
  // 002 R9 (T033/T035): GET /repos/:owner/:repo/actions/runs/:id/jobs --
  // same fixture for every running run, see JOBS_RESPONSE above.
  await page.route('**/api/v1/repos/*/*/actions/runs/*/jobs**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOBS_RESPONSE) })
  );
}

async function shootPopupTab(context, extensionId, theme, tab, fileSuffix, { expandOthers } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 600 });
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/popup.html`);

  await page.getByRole('tab', { name: tab.label }).click();
  await page.waitForTimeout(150);

  if (tab.label === 'Репо') {
    // The "Репо" tab debounces its search 200ms after mount, then awaits the
    // (stubbed) fetch -- wait for the first pinned repo's real data (not the
    // no-match placeholder) to actually render before screenshotting.
    await page
      .getByText('acme/platform', { exact: false })
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForTimeout(100);
  }

  if (expandOthers !== undefined) {
    const trigger = page.getByText('Остальные', { exact: false }).first();
    const isCollapsed = await page
      .locator('[data-slot="collapsible-content"]')
      .first()
      .isHidden()
      .catch(() => true);
    if (expandOthers && isCollapsed) {
      await trigger.click();
      await page.waitForTimeout(150);
    } else if (!expandOthers && !isCollapsed) {
      await trigger.click();
      await page.waitForTimeout(150);
    }
  }

  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `popup-${fileSuffix}-${theme}.png`);
  await page.screenshot({ path: file });
  await page.close();
  return file;
}

// ---------------------------------------------------------------------------
let SW; // extension service worker, set in main()

/** Reset persisted dashboard UI toggles so every shot starts from the defaults. */
async function resetUi() {
  await SW.evaluate(async () => {
    const { ui } = await chrome.storage.local.get('ui');
    await chrome.storage.local.set({ ui: { ...ui, historyStatsOpen: false, sidebarOpen: true } });
  });
}

async function reportOverflow(page, file) {
  // Viewport-only shots (real window behaviour: inner scroll areas, footer pinned).
  const o = await page.evaluate(() => ({
    h: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    v: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    sh: document.documentElement.scrollHeight,
    ch: document.documentElement.clientHeight,
  }));
  if (o.h || o.v) console.log(`OVERFLOW ${o.h ? 'horizontal ' : ''}${o.v ? 'vertical ' : ''}(${o.sh}/${o.ch}) ${file}`);
}

// dashboard.html shots (T025) -- full-page dashboard, wide (1280x800) and
// narrow (800x900, below the 1024px breakpoint where the nav collapses to
// Tabs -- src/entrypoints/dashboard/App.tsx) viewports, per hash route.
// ---------------------------------------------------------------------------

const DASHBOARD_VIEWPORTS = [
  { width: 1280, height: 800, suffix: '' },
  { width: 800, height: 900, suffix: '-narrow' },
];

const DASHBOARD_ROUTES = [
  { hash: '#/repos', suffix: 'repos', waitText: 'acme/platform' },
  { hash: '#/prs', suffix: 'prs', waitText: 'acme/platform' },
  { hash: '#/prs?ci=failure', suffix: 'prs-filtered', waitText: 'acme/billing' },
  // Whole page (the table exceeds one screen) to show the pagination footer.
  { hash: '#/prs', suffix: 'prs-pagination', waitText: 'acme/platform', fullPage: true },
  // Default history: period «Сегодня», tab «Сборки» (releases + builds), no branch preset, stats collapsed.
  { hash: '#/builds', suffix: 'builds', waitTestId: 'history-runs-table' },
  // Tab «Все запуски» (kind=all): PR checks and feature-branch pushes included.
  { hash: '#/builds?view=history&kind=all', suffix: 'builds-all', waitTestId: 'history-runs-table' },
];

async function shootDashboardRoute(context, extensionId, theme, viewport, routeSpec) {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/dashboard.html${routeSpec.hash}`);
  await page.waitForTimeout(200);

  if (routeSpec.waitText) {
    await page
      .getByText(routeSpec.waitText, { exact: false })
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
  }
  if (routeSpec.waitTestId) {
    await page
      .getByTestId(routeSpec.waitTestId)
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForTimeout(150);
  }

  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `dashboard-${routeSpec.suffix}-${theme}${viewport.suffix}.png`);
  await reportOverflow(page, file);
  await page.screenshot({ path: file, fullPage: Boolean(routeSpec.fullPage) });
  await page.close();
  return file;
}

// ---------------------------------------------------------------------------
// T038 (part b) -- three extra dashboard shots, 1280x800 only, demonstrating
// features not visible in the plain DASHBOARD_ROUTES loop above: the
// expanded "build stage" detail row, the PR table's RepoTag/NumberTag/
// BranchTag chips, and the collapsible sidebar.
// ---------------------------------------------------------------------------

const WIDE_VIEWPORT = { width: 1280, height: 800 };

async function shootHistoryExpanded(context, extensionId, theme) {
  const page = await openHistory(context, extensionId, theme);

  // First row's chevron -- aria-label from the `buildsStageToggle` i18n key
  // (Russian: "Подробности запуска"), src/features/builds/BuildsHistory.tsx.
  const toggle = page.getByRole('button', { name: 'Подробности запуска', expanded: false }).first();
  await toggle.click();
  // Wait for the (stubbed) jobs to actually render inside the expanded row
  // before screenshotting, instead of a fixed sleep.
  await page.getByText('build', { exact: true }).first().waitFor({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(150);

  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `dashboard-history-expanded-${theme}.png`);
  await reportOverflow(page, file);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

async function openHistory(context, extensionId, theme, hash = '#/builds') {
  const page = await context.newPage();
  await page.setViewportSize(WIDE_VIEWPORT);
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/dashboard.html${hash}`);
  await page.getByTestId('history-runs-table').waitFor({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
  return page;
}

async function shootHistoryStats(context, extensionId, theme) {
  const page = await openHistory(context, extensionId, theme);
  await page.getByRole('button', { name: /Статистика/ }).click();
  await page.waitForTimeout(300);
  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `dashboard-history-stats-${theme}.png`);
  await reportOverflow(page, file);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

async function shootReposPicker(context, extensionId, theme) {
  const page = await context.newPage();
  await page.setViewportSize(WIDE_VIEWPORT);
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/dashboard.html#/repos`);
  await page.getByText('acme/platform', { exact: false }).first().waitFor({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Цвет репозитория' }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `dashboard-repos-picker-${theme}.png`);
  await reportOverflow(page, file);
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  return file;
}

async function shootSidebarCollapsed(context, extensionId, theme) {
  const page = await context.newPage();
  await page.setViewportSize(WIDE_VIEWPORT);
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/dashboard.html#/prs`);
  await page.waitForTimeout(200);
  await page
    .getByText('acme/platform', { exact: false })
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => {});

  // App.tsx's `sidebarOpen` starts optimistically `true`, then an async
  // `getUiState()` effect re-resolves it from storage and can clobber a
  // click that lands before that effect settles -- give it a beat before
  // toggling so our click isn't immediately undone.
  await page.waitForTimeout(300);

  // shadcn Sidebar renders two "Toggle Sidebar" controls (the header
  // SidebarTrigger + the edge SidebarRail) with the same accessible name --
  // target the trigger specifically by its `data-slot` to avoid ambiguity.
  const trigger = page.locator('[data-slot="sidebar-trigger"]');
  const collapsed = page.locator('[data-slot="sidebar"][data-state="collapsed"]');
  // Confirm the toggle actually took (data-state flips on the Sidebar root,
  // src/components/ui/sidebar.tsx) instead of a fixed sleep + hope; retry
  // once in case the click above still raced the storage-resolution effect.
  await trigger.click();
  try {
    await collapsed.waitFor({ state: 'attached', timeout: 2_000 });
  } catch {
    await trigger.click();
    await collapsed.waitFor({ state: 'attached', timeout: 5_000 });
  }
  await page.waitForTimeout(300); // sidebar collapse is CSS-transitioned

  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `dashboard-sidebar-collapsed-${theme}.png`);
  await reportOverflow(page, file);
  await page.screenshot({ path: file, fullPage: false });
  // The collapsed state persists in ui storage -- expand again so later shots start open.
  await trigger.click();
  await page.locator('[data-slot="sidebar"][data-state="expanded"]').waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.close();
  return file;
}

async function shootOptions(context, extensionId, theme) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 1400 });
  await stubNetwork(page);
  await page.emulateMedia({ colorScheme: theme });
  await gotoRetry(page, `chrome-extension://${extensionId}/options.html`);
  await page.waitForTimeout(200);

  await mkdir(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `options-${theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

async function main() {
  console.log('Building extension (wxt build)...');
  run_('./node_modules/.bin/wxt', ['build']);

  const userDataDir = await mkdtemp(join(tmpdir(), 'gitea-dashboard-screenshots-'));
  // Load a private copy of the build: a concurrent `wxt build` (which wipes
  // .output/) must not pull the extension files out from under the browser.
  const EXT_DIR = join(userDataDir, 'ext');
  await cp(OUTPUT_DIR, EXT_DIR, { recursive: true });
  console.log(`Launching persistent context (extension: ${EXT_DIR})`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const extensionId = new URL(serviceWorker.url()).hostname;
    console.log(`Extension id: ${extensionId}`);

    SW = serviceWorker;
    await seedStorage(serviceWorker);

    const shots = [];
    for (const theme of ['light', 'dark']) {
      shots.push(await shootPopupTab(context, extensionId, theme, { label: 'Репо' }, 'repos'));
      shots.push(await shootPopupTab(context, extensionId, theme, { label: 'PR' }, 'prs'));
      shots.push(
        await shootPopupTab(context, extensionId, theme, { label: 'Сборки' }, 'builds', {
          expandOthers: false,
        })
      );
      shots.push(
        await shootPopupTab(context, extensionId, theme, { label: 'Сборки' }, 'builds-others', {
          expandOthers: true,
        })
      );
      shots.push(await shootOptions(context, extensionId, theme));

      for (const viewport of DASHBOARD_VIEWPORTS) {
        for (const routeSpec of DASHBOARD_ROUTES) {
          shots.push(await shootDashboardRoute(context, extensionId, theme, viewport, routeSpec));
        }
      }

      shots.push(await shootHistoryExpanded(context, extensionId, theme));
      shots.push(await shootHistoryStats(context, extensionId, theme));
      await resetUi();
      shots.push(await shootReposPicker(context, extensionId, theme));
      shots.push(await shootSidebarCollapsed(context, extensionId, theme));
      await resetUi();
    }

    console.log('\nScreenshots written:');
    for (const file of shots) {
      console.log(`  ${file}`);
    }
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
