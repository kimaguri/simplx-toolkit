// Contract: docs/specs/001-gitea-dashboard/spec.md US5, FR-061..063, SC-005;
// contracts/extension-surface.md "Уведомления" (notificationId = event key;
// URL stored in `notifUrl:<id>`, TTL 24h; onClicked -> tabs.create + clear).
//
// Exercises src/background/notifier.ts wired to src/background/poller
// (index.ts) via the additive `onCycleComplete` hook, exactly the way
// src/entrypoints/background.ts wires it -- see that file's comment. Badge
// red/neutral assertions reuse the already-tested `applyBadge`/`redUntilFrom`
// (src/background/poller/badge.ts, src/domain/badge.ts) the same way
// background.ts's `afterCycle` does; nothing new is asserted about badge
// *computation* here, only that a failed run still drives it end to end.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL pathname
// (like tests/integration/poller-runs.test.ts). No real HTTP is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createNotifier } from '../../src/background/notifier';
import { createPoller, type Poller } from '../../src/background/poller';
import { applyBadge } from '../../src/background/poller/badge';
import { runsSection } from '../../src/background/poller/runs';
import { BADGE_NEUTRAL, BADGE_RED } from '../../src/domain/badge';
import { DEFAULT_SETTINGS, type Instance, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';
const BASE_URL_2 = 'https://git2.example.test';

// -- fixed test world: me (login 'me'), single repo acme/platform reached
// via repo-mode scope (capabilities.actions='repo', no org/PR fetches
// needed) so the only network calls are A12 (repo runs) + A13 (workflow
// names, once). --

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_notiftest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'repo', notifications: true, orgs: [], missingScopes: [] },
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    notify: { ...DEFAULT_SETTINGS.notify, ...overrides.notify },
    scope: { ...DEFAULT_SETTINGS.scope, includeRepos: ['acme/platform'], ...overrides.scope },
  };
}

type Handler = (url: URL) => unknown;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function makeFetchMock(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = routes.find((r) => r.match(url));
    if (!route) {
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    }
    return jsonResponse(route.handler(url));
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function runsResponse(runs: unknown[]): { total_count: number; workflow_runs: unknown[] } {
  return { total_count: runs.length, workflow_runs: runs };
}

/** Minimal `ApiActionWorkflowRun`-shaped object (only the fields the domain reads). */
function mkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    run_attempt: 1,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: 'deadbeef',
    display_title: 'push: main',
    path: 'ci.yml@refs/heads/main',
    actor: { login: 'me' },
    trigger_actor: { login: 'me' },
    repository: { full_name: 'acme/platform' },
    html_url: `https://git.example.test/acme/platform/actions/runs/${overrides.id ?? 1}`,
    started_at: '2026-09-26T09:00:00Z',
    completed_at: '2026-09-26T09:05:00Z',
    pull_requests: [],
    ...overrides,
  };
}

function repoRunsRoute(owner: string, repo: string, handler: Handler): Route {
  return { match: (u) => path(u) === `/repos/${owner}/${repo}/actions/runs`, handler };
}

function workflowsRoute(): Route {
  return {
    match: (u) => /\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(path(u)),
    handler: () => ({ total_count: 0, workflows: [] }),
  };
}

const RUN_ID = 501;
const RUN_ATTEMPT = 1;
const FAIL_KEY = `fail:${RUN_ID}:${RUN_ATTEMPT}`;
const FAIL_URL = `https://git.example.test/acme/platform/actions/runs/${RUN_ID}`;

// `Date#toISOString()` always includes milliseconds -- match that so
// `seen.initializedAt`/etc. compare equal to what the code actually stores.
const T0 = '2026-09-26T10:00:00.000Z'; // cycle 1: no runs yet, seeds `seen`
const T1 = '2026-09-26T10:05:00.000Z'; // cycle 2: my run completes as a failure
const T2 = '2026-09-26T10:10:00.000Z'; // cycle 3: same failed run, unchanged
const T3 = '2026-09-26T10:15:00.000Z'; // "browser restart": fresh poller+notifier
const T4 = '2026-09-26T10:20:00.000Z'; // new baseUrl -> separate instance/seen

async function setUp(inst: Instance, s: Settings): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(s);
}

describe('notify-dedupe integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clock: Date;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.action, 'setBadgeText').mockResolvedValue(undefined);
    vi.spyOn(browser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
    // fakeBrowser has no i18n; `t()` then falls back to returning the key.
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    clock = new Date(T0);
  });

  function noRunsRoutes(): Route[] {
    return [repoRunsRoute('acme', 'platform', () => runsResponse([])), workflowsRoute()];
  }

  function failedRunRoutes(): Route[] {
    return [
      repoRunsRoute('acme', 'platform', () =>
        runsResponse([
          mkRun({ id: RUN_ID, run_attempt: RUN_ATTEMPT, status: 'completed', conclusion: 'failure', completed_at: T1 }),
        ])
      ),
      workflowsRoute(),
    ];
  }

  function wirePoller(): { poller: Poller; notifier: ReturnType<typeof createNotifier> } {
    const notifier = createNotifier({ now: () => clock });
    const poller = createPoller({
      sections: [runsSection],
      clientFactory: createClient,
      now: () => clock,
      // T050's additive hook (poller/index.ts): called with (prev, next,
      // instance) right after a cycle writes `snapshot:<id>` -- exactly what
      // src/entrypoints/background.ts wires to the notifier.
      onCycleComplete: async (prev, next, inst) => {
        const s = await storage.getSettings();
        await notifier.handleCycle(prev, next, inst, s);
      },
    });
    return { poller, notifier };
  }

  it('first-ever cycle only seeds `seen`, no notification avalanche', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const createSpy = vi.spyOn(browser.notifications, 'create');
    const { poller } = wirePoller();

    await poller.runCycle('base');

    expect(createSpy).not.toHaveBeenCalled();
    const seen = await storage.getSeen(inst.id);
    expect(seen?.initializedAt).toBe(T0);
  });

  it('a run of mine newly completed as a failure (after initializedAt) fires exactly one notification, seen written before create', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const { poller } = wirePoller();
    await poller.runCycle('base'); // cycle 1: seed only

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);

    const setSeenSpy = vi.spyOn(storage, 'setSeen');
    const createSpy = vi.spyOn(browser.notifications, 'create');
    setSeenSpy.mockClear();
    createSpy.mockClear();

    await poller.runCycle('base'); // cycle 2: the failure

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toBe(FAIL_KEY);

    // seen persisted before the notification was created (FR-061).
    expect(setSeenSpy).toHaveBeenCalled();
    const setSeenOrder = setSeenSpy.mock.invocationCallOrder[0];
    const createOrder = createSpy.mock.invocationCallOrder[0];
    expect(setSeenOrder).toBeLessThan(createOrder as number);

    const seen = await storage.getSeen(inst.id);
    expect(seen?.keys[FAIL_KEY]).toBeDefined();
  });

  it('an unchanged repeat cycle fires nothing', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const { poller } = wirePoller();
    await poller.runCycle('base'); // cycle 1: seed

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);
    await poller.runCycle('base'); // cycle 2: the failure fires once

    clock = new Date(T2);
    const createSpy = vi.spyOn(browser.notifications, 'create');
    createSpy.mockClear();

    await poller.runCycle('base'); // cycle 3: same data again

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('surviving a "browser restart" (brand-new poller+notifier over the same storage) still dedupes', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const first = wirePoller();
    await first.poller.runCycle('base'); // cycle 1: seed

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);
    await first.poller.runCycle('base'); // cycle 2: fires once

    // Simulate a service-worker restart: brand-new closures, same
    // fakeBrowser.storage underneath (no fakeBrowser.reset() here).
    clock = new Date(T3);
    const restarted = wirePoller();
    const createSpy = vi.spyOn(browser.notifications, 'create');
    createSpy.mockClear();

    await restarted.poller.runCycle('base');

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a different baseUrl (separate instanceId) gets its own `seen` and only seeds on its first cycle', async () => {
    const inst1 = instance();
    await setUp(inst1, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const { poller } = wirePoller();
    await poller.runCycle('base'); // cycle 1 on instance 1: seed

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);
    await poller.runCycle('base'); // cycle 2 on instance 1: fires once (already covered above)

    // Switch the active instance to a different baseUrl -> different id.
    const inst2 = instance({ id: 'i_notiftest2', baseUrl: BASE_URL_2 });
    await storage.setInstances({ instances: [inst1, inst2], activeInstanceId: inst2.id });
    await storage.setToken(inst2.id, 'test-token');

    clock = new Date(T4);
    const createSpy = vi.spyOn(browser.notifications, 'create');
    createSpy.mockClear();

    await poller.runCycle('base'); // instance 2's first-ever cycle: seed only, even though the fetched run is a failure

    expect(createSpy).not.toHaveBeenCalled();
    const seen2 = await storage.getSeen(inst2.id);
    expect(seen2?.initializedAt).toBe(T4);
    // Instance 1's own `seen` is untouched by instance 2's cycle.
    const seen1 = await storage.getSeen(inst1.id);
    expect(seen1?.initializedAt).toBe(T0);
  });

  it('clicking a notification opens its URL and clears it; an expired URL (>24h) opens no tab but still clears', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const { poller, notifier } = wirePoller();
    await poller.runCycle('base'); // cycle 1: seed

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);
    await poller.runCycle('base'); // cycle 2: fires + stores notifUrl:<id>[FAIL_KEY]

    const tabsCreateSpy = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const clearSpy = vi.spyOn(browser.notifications, 'clear');

    clock = new Date('2026-09-26T11:00:00Z'); // +55min, well within the 24h TTL
    await notifier.handleClick(FAIL_KEY);

    expect(tabsCreateSpy).toHaveBeenCalledWith({ url: FAIL_URL });
    expect(clearSpy).toHaveBeenCalledWith(FAIL_KEY);

    // A stale entry older than the 24h TTL: no tab opened, but the
    // notification is still cleared.
    await storage.setNotifUrls(inst.id, {
      ...(await storage.getNotifUrls(inst.id)),
      'stale:1': { url: 'https://git.example.test/acme/platform/pulls/9', expiresAt: Date.parse(T0) },
    });
    tabsCreateSpy.mockClear();
    clearSpy.mockClear();

    clock = new Date('2026-09-27T12:00:00Z'); // well past `stale:1`'s expiresAt
    await notifier.handleClick('stale:1');

    expect(tabsCreateSpy).not.toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalledWith('stale:1');
  });

  it('the badge is red right after my failure and turns neutral once redBadgeWindowMin has elapsed (SC-005, FR-051)', async () => {
    const inst = instance();
    await setUp(inst, settings());
    fetchMock.mockImplementation(makeFetchMock(noRunsRoutes()).getMockImplementation()!);

    const { poller } = wirePoller();
    await poller.runCycle('base'); // cycle 1: seed

    fetchMock.mockImplementation(makeFetchMock(failedRunRoutes()).getMockImplementation()!);
    clock = new Date(T1);
    await poller.runCycle('base'); // cycle 2: the failure

    const colorSpy = vi.spyOn(browser.action, 'setBadgeBackgroundColor');
    const s = await storage.getSettings();
    const snapshot = await storage.getSnapshot(inst.id);

    colorSpy.mockClear();
    // redBadgeWindowMin defaults to 30 -> redUntil = T1 + 30min = 10:35.
    await applyBadge(s, snapshot ?? null, new Date('2026-09-26T10:20:00Z'));
    expect(colorSpy).toHaveBeenCalledWith({ color: BADGE_RED });

    colorSpy.mockClear();
    await applyBadge(s, snapshot ?? null, new Date('2026-09-26T10:36:00Z'));
    expect(colorSpy).toHaveBeenCalledWith({ color: BADGE_NEUTRAL });
  });
});
