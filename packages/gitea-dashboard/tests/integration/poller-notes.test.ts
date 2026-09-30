// Contract: docs/specs/001-gitea-dashboard/spec.md FR-060 (comments/reviews on MY
// PRs, off by default), contracts/gitea-api.md A14 (`/notifications?since=&
// limit=50`, `subject.type`, `subject.html_url`, `latest_comment_html_url`,
// `repository.full_name`).
//
// Exercises src/background/poller/notes.ts (T052) standalone via
// createPoller (like tests/integration/poller-runs.test.ts) and wired to
// src/background/notifier.ts the same way tests/integration/notify-dedupe.
// test.ts and src/entrypoints/background.ts do, to prove a real
// `notifications.create` comes out the other end with the right id/url.
//
// Uses fakeBrowser (via storage.ts) + a fetch mock routed by URL
// pathname+query. No real HTTP is made.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createClient } from '../../src/api/client';
import { createNotifier } from '../../src/background/notifier';
import { createPoller, type Poller, type Section } from '../../src/background/poller';
import { notesSection } from '../../src/background/poller/notes';
import { DEFAULT_SETTINGS, type Instance, type PullRequest, type Settings } from '../../src/domain/types';
import * as storage from '../../src/lib/storage';

import notificationsFixture from '../fixtures/notifications.json';

const BASE_URL = 'https://git.example.test';

// -- fixed test world (fixtures/README.md): me (login 'me'), repo
// acme/platform. `notificationsFixture[0]` is a `Pull` thread on
// acme/platform#12 (matches `MY_PR` below); `notificationsFixture[1]` is an
// `Issue` thread (must never surface as a note). --

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i_notestest1',
    baseUrl: BASE_URL,
    login: 'me',
    capabilities: { actions: 'repo', notifications: true, orgs: [], missingScopes: [] },
    ...overrides,
  };
}

function settings(overrides: { notify?: Partial<Settings['notify']> } = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    notify: { ...DEFAULT_SETTINGS.notify, ...overrides.notify },
  };
}

function mkPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 900,
    repo: { owner: 'acme', name: 'platform' },
    number: 12,
    title: 'Add caching layer',
    author: 'alice',
    updatedAt: '2026-09-26T08:00:00Z',
    htmlUrl: 'https://git.example.test/acme/platform/pulls/12',
    draft: false,
    group: 'mine',
    ci: { state: 'success', fetchedAt: '2026-09-26T08:00:00Z' },
    ...overrides,
  };
}

/** Stands in for `prsSection` (T037): just seeds `ctx.merged.prs` for this cycle. */
function fakePrsSection(prs: PullRequest[]): Section {
  return {
    name: 'prs',
    async run() {
      return { prs };
    },
  };
}

type Handler = (url: URL) => unknown | Promise<unknown>;

interface Route {
  match: (url: URL) => boolean;
  handler: Handler;
  status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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
    // Awaited even for error statuses (whose body the client never reads)
    // so an async handler's side effects — e.g. simulating a concurrent
    // storage write mid-cycle — are guaranteed to land before this call
    // resolves.
    const body = await route.handler(url);
    return jsonResponse(body, route.status ?? 200);
  });
}

function path(url: URL): string {
  return url.pathname.replace(/^\/api\/v1/, '');
}

function notificationsRoute(handler: Handler, status = 200): Route {
  return { match: (u) => path(u) === '/notifications', handler, status };
}

async function setUp(inst: Instance, s: Settings): Promise<void> {
  await storage.setInstances({ instances: [inst], activeInstanceId: inst.id });
  await storage.setToken(inst.id, 'test-token');
  await storage.setSettings(s);
}

describe('poller notes section (T052)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clock: Date;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    clock = new Date('2026-09-26T10:00:00.000Z');
  });

  it('comments disabled in settings: no /notifications request at all', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: false } }));
    fetchMock.mockImplementation(
      makeFetchMock([]).getMockImplementation()! // no routes registered -> any request throws
    );

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    await expect(poller.runCycle('base')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('comments enabled: requests /notifications with `since`, only my-PR Pull threads reach the snapshot', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const notifRoute = notificationsRoute(() => notificationsFixture);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    await poller.runCycle('base');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get('limit')).toBe('50');
    // First-ever cycle (no `prev` snapshot): since = now - recentWindowHours.
    const expectedSince = new Date(
      clock.getTime() - DEFAULT_SETTINGS.recentWindowHours * 60 * 60 * 1000
    ).toISOString();
    expect(requestedUrl.searchParams.get('since')).toBe(expectedSince);

    const snapshot = await storage.getSnapshot(inst.id);
    expect(snapshot?.notes).toHaveLength(1);
    expect(snapshot?.notes?.[0]?.threadId).toBe('6001');
    expect(snapshot?.notes?.[0]?.updatedAt).toBe('2026-09-26T08:45:00Z');
  });

  it('second cycle uses `since` = the cursor advanced by the first cycle', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const notifRoute = notificationsRoute(() => []);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    const firstNow = clock;
    await poller.runCycle('base'); // cycle 1

    clock = new Date('2026-09-26T10:05:00.000Z');
    fetchMock.mockClear();
    await poller.runCycle('base'); // cycle 2

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get('since')).toBe(firstNow.toISOString());
  });

  it('a fast cycle between two base cycles does not advance `since`: the second base cycle still requests from the first base cycle\'s time (M2)', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const notifRoute = notificationsRoute(() => []);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    // `notesSection` has no `fast` flag, so it never runs on a 'fast'
    // cycle — but the fast cycle still writes a snapshot (and would have
    // advanced `Snapshot.fetchedAt`), which is exactly the M2 defect this
    // section's own cursor must be immune to.
    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    const baseNow = clock;
    await poller.runCycle('base'); // base cycle 1: cursor -> baseNow
    fetchMock.mockClear();

    clock = new Date('2026-09-26T10:01:00.000Z');
    await poller.runCycle('fast'); // fast cycle: notes section skipped entirely
    expect(fetchMock).not.toHaveBeenCalled();
    const fastFetchedAt = (await storage.getSnapshot(inst.id))?.fetchedAt;
    expect(fastFetchedAt).toBe(clock.toISOString()); // fetchedAt DID advance

    clock = new Date('2026-09-26T10:05:00.000Z');
    await poller.runCycle('base'); // base cycle 2

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    // Must be the first base cycle's time, NOT the fast cycle's fetchedAt.
    expect(requestedUrl.searchParams.get('since')).toBe(baseNow.toISOString());
    expect(requestedUrl.searchParams.get('since')).not.toBe(fastFetchedAt);
  });

  it('a 500 from /notifications leaves the cursor unchanged; the next cycle re-requests from the same `since` (M2)', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const notifRoute = notificationsRoute(() => []);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    const firstNow = clock;
    await poller.runCycle('base'); // cycle 1: cursor -> firstNow

    clock = new Date('2026-09-26T10:05:00.000Z');
    const failingRoute = notificationsRoute(() => ({ message: 'boom' }), 500);
    fetchMock.mockImplementation(makeFetchMock([failingRoute]).getMockImplementation()!);
    await poller.runCycle('base'); // cycle 2: A14 500s -> cursor must not advance

    const snapshot = await storage.getSnapshot(inst.id);
    // Not cycle-fatal: `prs` still succeeded this cycle.
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.prs).toHaveLength(1);

    clock = new Date('2026-09-26T10:10:00.000Z');
    fetchMock.mockClear();
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);
    await poller.runCycle('base'); // cycle 3: re-requests from the old since

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get('since')).toBe(firstNow.toISOString());
  });

  it('403 on /notifications persists capabilities.notifications=false, is not a cycle-fatal error, and the next cycle makes no request', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const notifRoute = notificationsRoute(() => ({ message: 'forbidden' }), 403);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    await poller.runCycle('base');

    const snapshot = await storage.getSnapshot(inst.id);
    // Not fatal: `prs` (and the cycle overall) still succeeded, no top-level
    // error and no `sectionErrors` entry (there's no slot for `notes`).
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.prs).toHaveLength(1);
    expect(snapshot?.notes ?? []).toHaveLength(0);

    const { instances } = await storage.getInstances();
    expect(instances[0]?.capabilities.notifications).toBe(false);

    clock = new Date('2026-09-26T10:05:00.000Z');
    fetchMock.mockClear();
    await poller.runCycle('base'); // cycle 2: capability now false -> gated

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('L6: a concurrent capabilities.orgs write mid-cycle survives this section\'s own notifications=false write', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    let concurrentWriteDone = false;
    const notifRoute = notificationsRoute(async () => {
      // Simulate another write (e.g. runs.ts's own persistCapabilities, or
      // an Options save) landing on `capabilities.orgs` while this
      // section's A14 request is in flight — strictly before this
      // section re-reads+writes `capabilities.notifications` below.
      const state = await storage.getInstances();
      await storage.setInstances({
        ...state,
        instances: state.instances.map((i) =>
          i.id === inst.id
            ? { ...i, capabilities: { ...i.capabilities, orgs: ['acme', 'newco'] } }
            : i
        ),
      });
      concurrentWriteDone = true;
      return { message: 'forbidden' };
    }, 403);
    fetchMock.mockImplementation(makeFetchMock([notifRoute]).getMockImplementation()!);

    const poller = createPoller({
      sections: [fakePrsSection([mkPr()]), notesSection],
      clientFactory: createClient,
      now: () => clock,
    });

    await poller.runCycle('base');

    expect(concurrentWriteDone).toBe(true);
    const { instances } = await storage.getInstances();
    // This section's own write (notifications -> false) must land...
    expect(instances[0]?.capabilities.notifications).toBe(false);
    // ...without clobbering the concurrent orgs write with a stale copy.
    expect(instances[0]?.capabilities.orgs).toEqual(['acme', 'newco']);
  });

  it('end-to-end with the notifier: a new thread on my PR produces one notification with id note:<threadId>:<updatedAt> and click URL = latest_comment_html_url', async () => {
    const inst = instance();
    await setUp(inst, settings({ notify: { comments: true } }));

    const thread = {
      id: 7001,
      updated_at: '2026-09-26T10:10:00Z',
      subject: {
        type: 'Pull',
        title: 'Add caching layer',
        html_url: 'https://git.example.test/acme/platform/pulls/12',
        latest_comment_html_url: 'https://git.example.test/acme/platform/pulls/12#issuecomment-99',
      },
      repository: { full_name: 'acme/platform' },
    };

    function wirePoller(): { poller: Poller; notifier: ReturnType<typeof createNotifier> } {
      const notifier = createNotifier({ now: () => clock });
      const poller = createPoller({
        sections: [fakePrsSection([mkPr()]), notesSection],
        clientFactory: createClient,
        now: () => clock,
        onCycleComplete: async (prev, next, i) => {
          const s = await storage.getSettings();
          await notifier.handleCycle(prev, next, i, s);
        },
      });
      return { poller, notifier };
    }

    fetchMock.mockImplementation(
      makeFetchMock([notificationsRoute(() => [])]).getMockImplementation()!
    );
    const { poller } = wirePoller();
    await poller.runCycle('base'); // cycle 1: seed only, no threads yet

    const createSpy = vi.spyOn(browser.notifications, 'create');
    createSpy.mockClear();

    clock = new Date('2026-09-26T10:15:00.000Z');
    fetchMock.mockImplementation(
      makeFetchMock([notificationsRoute(() => [thread])]).getMockImplementation()!
    );
    await poller.runCycle('base'); // cycle 2: the new thread fires

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toBe('note:7001:2026-09-26T10:10:00Z');

    const urls = await storage.getNotifUrls(inst.id);
    expect(urls['note:7001:2026-09-26T10:10:00Z']?.url).toBe(
      'https://git.example.test/acme/platform/pulls/12#issuecomment-99'
    );
  });
});
