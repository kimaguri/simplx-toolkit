// T030 [US2] — omnibox wiring (FR-015).
// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md "Omnibox".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import reposSearchFixture from '../fixtures/repos-search.json';
import { registerOmnibox } from '../../src/background/omnibox';
import type { RepoRef } from '../../src/domain/types';
import type { InstancesState } from '../../src/lib/storage';

const BASE_URL = 'https://git.example.test';
const INSTANCE_ID = 'i_test';

type ChangedListener = (
  text: string,
  suggest: (suggestions: { content: string; description: string }[]) => void
) => void;
type EnteredListener = (text: string, disposition: string) => void;

let changedListener: ChangedListener | undefined;
let enteredListener: EnteredListener | undefined;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function configuredInstances(): InstancesState {
  return {
    activeInstanceId: INSTANCE_ID,
    instances: [
      {
        id: INSTANCE_ID,
        baseUrl: BASE_URL,
        capabilities: { actions: 'org', notifications: true, orgs: [], missingScopes: [] },
      },
    ],
  };
}

function register(overrides: {
  configured?: boolean;
  pins?: RepoRef[];
  debounceMs?: number;
} = {}) {
  const { configured = true, pins = [], debounceMs = 200 } = overrides;
  registerOmnibox({
    debounceMs,
    getInstances: async () =>
      configured ? configuredInstances() : { instances: [], activeInstanceId: undefined },
    getToken: async () => (configured ? 'test-token' : undefined),
    getPins: async () => pins,
  });
}

describe('registerOmnibox', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let addChanged: ReturnType<typeof vi.fn>;
  let addEntered: ReturnType<typeof vi.fn>;
  let setDefaultSuggestion: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tabsCreate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tabsUpdate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openOptionsPage: any;

  beforeEach(() => {
    vi.useFakeTimers();
    changedListener = undefined;
    enteredListener = undefined;

    fetchMock = vi.fn(async () => jsonResponse(reposSearchFixture));
    vi.stubGlobal('fetch', fetchMock);

    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');

    addChanged = vi.fn((cb: ChangedListener) => {
      changedListener = cb;
    });
    addEntered = vi.fn((cb: EnteredListener) => {
      enteredListener = cb;
    });
    setDefaultSuggestion = vi.fn();
    // fakeBrowser has no in-memory omnibox implementation (only "not
    // implemented" stubs) — stub the surface this module needs. The `as
    // never` casts sidestep the (chrome-callback-style) overloads TS would
    // otherwise try to unify our capture-only mocks with.
    vi.spyOn(browser.omnibox.onInputChanged, 'addListener').mockImplementation(
      addChanged as never
    );
    vi.spyOn(browser.omnibox.onInputEntered, 'addListener').mockImplementation(
      addEntered as never
    );
    vi.spyOn(browser.omnibox, 'setDefaultSuggestion').mockImplementation(
      setDefaultSuggestion as never
    );

    tabsCreate = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    tabsUpdate = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);

    openOptionsPage = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers listeners and sets an initial default suggestion', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);
    expect(addChanged).toHaveBeenCalledTimes(1);
    expect(addEntered).toHaveBeenCalledTimes(1);
    expect(setDefaultSuggestion).toHaveBeenCalled();
  });

  it('debounces onInputChanged: rapid keystrokes trigger exactly one search', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();

    const suggest = vi.fn();
    changedListener?.('a', vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    changedListener?.('ac', vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    changedListener?.('acm', suggest);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('returns at most 6 suggestions', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    const suggest = vi.fn();
    changedListener?.('', suggest);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);

    expect(suggest).toHaveBeenCalledTimes(1);
    const [suggestions] = suggest.mock.calls[0] as [{ content: string; description: string }[]];
    expect(suggestions.length).toBeLessThanOrEqual(6);
    // the fixture has 4 repos -> all 4 should come through, unescaped names.
    expect(suggestions.map((s) => s.description)).toEqual(
      expect.arrayContaining(['acme/platform', 'acme/core', 'umbrella/web', 'me/dotfiles'])
    );
  });

  it('escapes &, <, > in suggestion descriptions for the omnibox XML dialect', async () => {
    register({
      pins: [{ owner: 'a&b', name: '<c>' }],
    });
    await vi.advanceTimersByTimeAsync(0);

    const suggest = vi.fn();
    changedListener?.('a&b', suggest);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);

    const [suggestions] = suggest.mock.calls[0] as [{ content: string; description: string }[]];
    const pinSuggestion = suggestions.find((s) => s.description.includes('a&amp;b'));
    expect(pinSuggestion).toBeDefined();
    expect(pinSuggestion?.description).toBe('a&amp;b/&lt;c&gt;');
    expect(pinSuggestion?.description).not.toContain('<c>');
  });

  it('Enter on a raw http(s) URL on the instance origin opens it directly', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.(`${BASE_URL}/acme/core`, 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({ url: `${BASE_URL}/acme/core`, active: true });
  });

  it('Enter on plain text opens the first suggestion url when one exists', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    const suggest = vi.fn();
    changedListener?.('acme/core', suggest);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);
    const [suggestions] = suggest.mock.calls[0] as [{ content: string; description: string }[]];
    expect(suggestions[0]?.content).toBe('https://git.example.test/acme/core');

    enteredListener?.('acme/core', 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'https://git.example.test/acme/core',
      active: true,
    });
  });

  it('Enter with a raw "owner/name" ref opens that repo on the instance, even with no suggestions loaded', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.('acme/platform', 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({
      url: `${BASE_URL}/acme/platform`,
      active: true,
    });
  });

  it('resolves a top suggestion that is a pinned "owner/name" (no matching search result) to a real URL', async () => {
    // A pin with no matching search result gets `owner/name` as its
    // suggestion `content` (src/domain/repos.ts toPlaceholderRepo path) —
    // Chrome would hand that straight back as `text` if selected, or as the
    // top suggestion's content when the user just presses Enter.
    register({ pins: [{ owner: 'acme', name: 'unlisted' }] });
    await vi.advanceTimersByTimeAsync(0);

    const suggest = vi.fn();
    changedListener?.('acme/unlisted', suggest);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);
    const [suggestions] = suggest.mock.calls[0] as [{ content: string; description: string }[]];
    expect(suggestions[0]?.content).toBe('acme/unlisted');

    enteredListener?.('something not a url or ref!!', 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({
      url: `${BASE_URL}/acme/unlisted`,
      active: true,
    });
  });

  it('Enter with no matching suggestion falls back to /explore/repos?q=', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: [] }));
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.('nothing here', 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({
      url: `${BASE_URL}/explore/repos?q=nothing%20here`,
      active: true,
    });
  });

  it('opens in the current tab via tabs.update for disposition "currentTab"', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.(`${BASE_URL}/acme/core`, 'currentTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsUpdate).toHaveBeenCalledWith({ url: `${BASE_URL}/acme/core` });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('opens a background tab (active: false) for disposition "newBackgroundTab"', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.(`${BASE_URL}/acme/core`, 'newBackgroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({ url: `${BASE_URL}/acme/core`, active: false });
  });

  it('opens a foreground tab (active: true) for disposition "newForegroundTab"', async () => {
    register();
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.(`${BASE_URL}/acme/core`, 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(tabsCreate).toHaveBeenCalledWith({ url: `${BASE_URL}/acme/core`, active: true });
  });

  it('when not configured: default suggestion says so and never calls searchRepos', async () => {
    register({ configured: false });
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();

    const suggest = vi.fn();
    changedListener?.('anything', suggest);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(suggest).toHaveBeenCalledWith([]);
    expect(setDefaultSuggestion).toHaveBeenCalled();
  });

  it('when not configured: Enter opens the options page', async () => {
    register({ configured: false });
    await vi.advanceTimersByTimeAsync(0);

    enteredListener?.('anything', 'newForegroundTab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(openOptionsPage).toHaveBeenCalledTimes(1);
    expect(tabsCreate).not.toHaveBeenCalled();
  });
});
