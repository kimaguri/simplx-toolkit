// Opens the dashboard page in a tab, reusing an already-open tab instead of
// creating duplicates.
// Contract: docs/specs/002-fullpage-dashboard/contracts/page-surface.md ("Кнопка
// в окне"). Research: docs/specs/002-fullpage-dashboard/research.md R1.

import { browser } from 'wxt/browser';
import { serializeRoute, type PageSection } from '../domain/route';

const DASHBOARD_PATH = '/dashboard.html';

export interface OpenDashboardDeps {
  runtime?: typeof browser.runtime;
  tabs?: typeof browser.tabs;
  windows?: typeof browser.windows;
}

/**
 * A minimal shape of `chrome.runtime.getContexts` (Chrome ≥ 116, MV3 only).
 * Not present in the webextension-polyfill types nor in `fakeBrowser`, so we
 * read it dynamically and treat it as absent when it isn't a function
 * (research.md R1: "getContexts отсутствует → фолбэк tabs.create").
 */
interface ExtensionContextLike {
  tabId?: number;
  windowId?: number;
  documentUrl?: string;
}

type GetContexts = (filter: {
  contextTypes?: string[];
  documentUrls?: string[];
}) => Promise<ExtensionContextLike[]>;

function getContextsFn(runtime: typeof browser.runtime): GetContexts | undefined {
  const candidate = (runtime as { getContexts?: unknown }).getContexts;
  return typeof candidate === 'function' ? (candidate as GetContexts) : undefined;
}

/** `true` when the context's document is the dashboard page (hash ignored). */
function isDashboardContext(ctx: ExtensionContextLike): boolean {
  if (!ctx.documentUrl) {
    return false;
  }
  try {
    return new URL(ctx.documentUrl).pathname === DASHBOARD_PATH;
  } catch {
    return false;
  }
}

async function findDashboardContext(
  getContexts: GetContexts,
  dashboardUrl: string,
): Promise<ExtensionContextLike | undefined> {
  // Chrome may match `documentUrls` exactly (hash included), which would
  // miss an existing tab sitting on a different section/filter. Try the
  // strict filter first (cheap common case), then fall back to scanning all
  // TAB contexts and filtering by pathname ourselves.
  const strict = await getContexts({ contextTypes: ['TAB'], documentUrls: [dashboardUrl] });
  const strictMatch = strict.find(isDashboardContext);
  if (strictMatch) {
    return strictMatch;
  }
  const allTabs = await getContexts({ contextTypes: ['TAB'] });
  return allTabs.find(isDashboardContext);
}

/**
 * Focuses the existing dashboard tab (any window) or opens a new one on
 * `section` when none exists.
 */
export async function openDashboard(section: PageSection, deps: OpenDashboardDeps = {}): Promise<void> {
  const runtime = deps.runtime ?? browser.runtime;
  const tabs = deps.tabs ?? browser.tabs;
  const windows = deps.windows ?? browser.windows;

  const dashboardUrl = runtime.getURL(DASHBOARD_PATH);
  const getContexts = getContextsFn(runtime);

  if (getContexts) {
    const match = await findDashboardContext(getContexts, dashboardUrl);
    if (match && match.tabId !== undefined && match.tabId >= 0) {
      await tabs.update(match.tabId, { active: true });
      if (match.windowId !== undefined && match.windowId >= 0) {
        await windows.update(match.windowId, { focused: true });
      }
      return;
    }
  }

  const hash = serializeRoute({ section, params: new URLSearchParams() });
  await tabs.create({ url: `${dashboardUrl}${hash}` });
}
