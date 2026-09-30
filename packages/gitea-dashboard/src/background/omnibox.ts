// T030 [US2] — omnibox wiring (`gt <query>`), FR-015.
// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md "Omnibox".
//
// `gt <query>` -> up to 6 suggestions (pinned + searchRepos, debounced
// 200 ms). Enter on a suggestion / a raw Gitea URL opens it directly; Enter
// on plain text falls back to the first suggestion, then to the instance's
// `/explore/repos?q=` search page. Not configured -> a "connect first"
// default suggestion and Enter opens the options page.
import { browser } from 'wxt/browser';
import { createClient, type ApiClient } from '../api/client';
import { createEndpoints } from '../api/endpoints';
import { omniboxSuggestions, type OmniboxSuggestion } from '../domain/repos';
import { getInstances, getPins, getToken, type InstancesState } from '../lib/storage';
import { t } from '../lib/i18n';

const DEBOUNCE_MS = 200;
const SUGGESTION_LIMIT = 6;

export interface OmniboxDeps {
  clientFactory?: (args: { baseUrl: string; token: string }) => ApiClient;
  getInstances?: () => Promise<InstancesState>;
  getToken?: (id: string) => Promise<string | undefined>;
  getPins?: (id: string) => ReturnType<typeof getPins>;
  debounceMs?: number;
}

interface ResolvedDeps {
  clientFactory: (args: { baseUrl: string; token: string }) => ApiClient;
  getInstances: () => Promise<InstancesState>;
  getToken: (id: string) => Promise<string | undefined>;
  getPins: (id: string) => ReturnType<typeof getPins>;
  debounceMs: number;
}

interface OmniboxContext {
  baseUrl: string;
  searchRepos: (q: string, limit: number) => Promise<Parameters<typeof omniboxSuggestions>[2]>;
  pins: Awaited<ReturnType<typeof getPins>>;
}

// Chrome omnibox suggestion descriptions are a small XML dialect
// (https://developer.chrome.com/docs/extensions/reference/api/omnibox) — the
// three characters that would otherwise be parsed as markup must be escaped.
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isUrlOnOrigin(text: string, baseUrl: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(text);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  return (
    (target.protocol === 'http:' || target.protocol === 'https:') && target.origin === base.origin
  );
}

// Matches a bare `owner/name` ref — the `content` a pinned repo with no
// matching search result gets in OmniboxSuggestion (see
// src/domain/repos.ts toPlaceholderRepo/refKey), as opposed to a full
// html_url for repos backed by an actual search result.
const OWNER_NAME_REF = /^[\w.-]+\/[\w.-]+$/;

/**
 * Resolves arbitrary omnibox input (raw typed text, or a suggestion's
 * `content`) to an actual URL: an http(s) URL on the instance origin is used
 * as-is, a bare `owner/name` ref is expanded against `baseUrl`, and anything
 * else resolves to `undefined` (not a directly openable target).
 */
function resolveDirectUrl(text: string, baseUrl: string): string | undefined {
  if (isUrlOnOrigin(text, baseUrl)) return text;
  if (OWNER_NAME_REF.test(text)) return `${baseUrl}/${text}`;
  return undefined;
}

async function loadContext(deps: ResolvedDeps): Promise<OmniboxContext | undefined> {
  const { instances, activeInstanceId } = await deps.getInstances();
  if (!activeInstanceId) return undefined;
  const instance = instances.find((i) => i.id === activeInstanceId);
  if (!instance) return undefined;
  const token = await deps.getToken(activeInstanceId);
  if (!token) return undefined;
  const pins = await deps.getPins(activeInstanceId);
  const endpoints = createEndpoints(deps.clientFactory({ baseUrl: instance.baseUrl, token }));
  return { baseUrl: instance.baseUrl, searchRepos: endpoints.searchRepos, pins };
}

function openUrl(url: string, disposition: string): void {
  if (disposition === 'currentTab') {
    void browser.tabs.update({ url });
    return;
  }
  void browser.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
}

/**
 * Wires `browser.omnibox` (`gt <query>` keyword, FR-015). Call once from the
 * background entrypoint. Accepts overrides for tests.
 */
export function registerOmnibox(deps: OmniboxDeps = {}): void {
  const resolved: ResolvedDeps = {
    clientFactory: deps.clientFactory ?? createClient,
    getInstances: deps.getInstances ?? getInstances,
    getToken: deps.getToken ?? getToken,
    getPins: deps.getPins ?? getPins,
    debounceMs: deps.debounceMs ?? DEBOUNCE_MS,
  };

  let lastSuggestions: OmniboxSuggestion[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function setDefaultSuggestion(configured: boolean): void {
    browser.omnibox.setDefaultSuggestion({
      description: escapeXmlText(t(configured ? 'omniboxDescription' : 'omniboxNotConfigured')),
    });
  }

  // Best-effort initial default suggestion (async — configured state isn't
  // known synchronously); onInputChanged/onInputEntered refresh it as needed.
  void loadContext(resolved).then((context) => setDefaultSuggestion(context !== undefined));

  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        const context = await loadContext(resolved);
        if (!context) {
          lastSuggestions = [];
          setDefaultSuggestion(false);
          suggest([]);
          return;
        }
        setDefaultSuggestion(true);
        const results = await context.searchRepos(text, SUGGESTION_LIMIT);
        const suggestions = omniboxSuggestions(text, context.pins, results);
        lastSuggestions = suggestions;
        suggest(
          suggestions.map((s) => ({
            content: s.content,
            description: escapeXmlText(s.description),
          }))
        );
      })();
    }, resolved.debounceMs);
  });

  browser.omnibox.onInputEntered.addListener((text, disposition) => {
    void (async () => {
      const context = await loadContext(resolved);
      if (!context) {
        void browser.runtime.openOptionsPage();
        return;
      }
      const direct = resolveDirectUrl(text, context.baseUrl);
      if (direct) {
        openUrl(direct, disposition);
        return;
      }
      const first = lastSuggestions[0];
      const resolvedFirst = first ? resolveDirectUrl(first.content, context.baseUrl) : undefined;
      if (resolvedFirst) {
        openUrl(resolvedFirst, disposition);
        return;
      }
      openUrl(`${context.baseUrl}/explore/repos?q=${encodeURIComponent(text)}`, disposition);
    })();
  });
}
