// Typed access to extension storage.
// Storage layout: docs/specs/001-gitea-dashboard/data-model.md "Раскладка хранилищ".
//
// Rules:
// - The PAT token lives ONLY in storage.local under `token:<instanceId>` —
//   never in storage.sync (FR-003).
// - `settings` (without the token) and `pins:<instanceId>` live in storage.sync.
// - Everything else (instances, snapshots, caches, ui, poll/seen state) lives
//   in storage.local.

import { browser } from 'wxt/browser';
import {
  DEFAULT_SETTINGS,
  type CiStatus,
  type Instance,
  type PollState,
  type RepoRef,
  type Run,
  type SeenEvents,
  type Settings,
  type Snapshot,
  type UiState,
} from '../domain/types';

// ---------------------------------------------------------------------------
// Base URL normalization + instance id
// ---------------------------------------------------------------------------

/**
 * Normalizes a Gitea base URL so equivalent inputs collapse to the same
 * value: trims whitespace, requires http(s), strips a trailing slash and a
 * trailing `/api/v1` segment, and lowercases the host.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid base URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol in base URL: ${raw}`);
  }

  let path = url.pathname;
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path.toLowerCase().endsWith('/api/v1')) {
    path = path.slice(0, path.length - '/api/v1'.length);
  }
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // url.origin is already host-lowercased per the WHATWG URL spec.
  return `${url.origin}${path}`;
}

/**
 * Stable instance id derived from the normalized base URL:
 * `i_` + the first 8 hex chars of sha1(normalizedBaseUrl).
 */
export async function instanceId(baseUrl: string): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `i_${hex}`;
}

// ---------------------------------------------------------------------------
// Generic typed helpers
// ---------------------------------------------------------------------------

async function getLocal<T>(key: string): Promise<T | undefined> {
  const result = await browser.storage.local.get(key);
  return result[key] as T | undefined;
}

async function setLocal<T>(key: string, value: T): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

async function getSync<T>(key: string): Promise<T | undefined> {
  const result = await browser.storage.sync.get(key);
  return result[key] as T | undefined;
}

async function setSync<T>(key: string, value: T): Promise<void> {
  await browser.storage.sync.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// Settings (sync) — never contains the token
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await getSync<Partial<Settings>>(SETTINGS_KEY);
  return mergeSettings(stored);
}

export async function setSettings(settings: Settings): Promise<void> {
  if (settings.pollIntervalSec < 30) {
    throw new Error('pollIntervalSec must be >= 30');
  }
  await setSync(SETTINGS_KEY, settings);
}

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  if (!stored) {
    return DEFAULT_SETTINGS;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...stored.notify },
    scope: { ...DEFAULT_SETTINGS.scope, ...stored.scope },
  };
}

/**
 * Subscribes to changes of `settings` in storage.sync. Returns an
 * unsubscribe function. The callback receives the merged `Settings` (missing
 * fields filled in from `DEFAULT_SETTINGS`), matching `getSettings()`.
 */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName
  ) => {
    if (areaName !== 'sync') {
      return;
    }
    const change = changes[SETTINGS_KEY];
    if (!change) {
      return;
    }
    callback(mergeSettings(change.newValue as Partial<Settings> | undefined));
  };

  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Token (local only, FR-003)
// ---------------------------------------------------------------------------

function tokenKey(id: string): string {
  return `token:${id}`;
}

export async function getToken(id: string): Promise<string | undefined> {
  return getLocal<string>(tokenKey(id));
}

export async function setToken(id: string, token: string): Promise<void> {
  await setLocal(tokenKey(id), token);
}

/** Removes a stored token (e.g. the previous instance's, after its baseUrl changes — FR-003). */
export async function removeToken(id: string): Promise<void> {
  await browser.storage.local.remove(tokenKey(id));
}

// ---------------------------------------------------------------------------
// Instances (local)
// ---------------------------------------------------------------------------

export interface InstancesState {
  instances: Instance[];
  activeInstanceId?: string;
}

const INSTANCES_KEY = 'instances';

export async function getInstances(): Promise<InstancesState> {
  const stored = await getLocal<InstancesState>(INSTANCES_KEY);
  return stored ?? { instances: [], activeInstanceId: undefined };
}

export async function setInstances(state: InstancesState): Promise<void> {
  await setLocal(INSTANCES_KEY, state);
}

/** Subscribes to changes of the instances list / active instance (storage.local). */
export function onInstancesChanged(callback: (state: InstancesState) => void): () => void {
  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName
  ) => {
    if (areaName !== 'local') return;
    const change = changes[INSTANCES_KEY];
    if (!change) return;
    callback((change.newValue as InstancesState | undefined) ?? { instances: [], activeInstanceId: undefined });
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Snapshot (local)
// ---------------------------------------------------------------------------

function snapshotKey(id: string): string {
  return `snapshot:${id}`;
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return getLocal<Snapshot>(snapshotKey(id));
}

export async function setSnapshot(id: string, snapshot: Snapshot): Promise<void> {
  await setLocal(snapshotKey(id), snapshot);
}

// ---------------------------------------------------------------------------
// CI status cache (local)
// ---------------------------------------------------------------------------

function statusCacheKey(id: string): string {
  return `statusCache:${id}`;
}

export async function getStatusCache(id: string): Promise<Record<string, CiStatus>> {
  return (await getLocal<Record<string, CiStatus>>(statusCacheKey(id))) ?? {};
}

export async function setStatusCache(
  id: string,
  cache: Record<string, CiStatus>
): Promise<void> {
  await setLocal(statusCacheKey(id), cache);
}

// ---------------------------------------------------------------------------
// PR heads cache (local)
// ---------------------------------------------------------------------------

export interface PrHead {
  sha: string;
  ref: string;
  mergeable?: boolean;
  /** Target branch (`base.ref`, T056). Absent in cache entries written before T056. */
  baseRef?: string;
}

export interface PrHeadsEntry {
  maxUpdatedAt: string;
  heads: Record<number, PrHead>;
}

function prHeadsKey(id: string): string {
  return `prHeads:${id}`;
}

export async function getPrHeads(id: string): Promise<Record<string, PrHeadsEntry>> {
  return (await getLocal<Record<string, PrHeadsEntry>>(prHeadsKey(id))) ?? {};
}

export async function setPrHeads(
  id: string,
  value: Record<string, PrHeadsEntry>
): Promise<void> {
  await setLocal(prHeadsKey(id), value);
}

// ---------------------------------------------------------------------------
// Notification dedup (local)
// ---------------------------------------------------------------------------

function seenKey(id: string): string {
  return `seen:${id}`;
}

export async function getSeen(id: string): Promise<SeenEvents | undefined> {
  return getLocal<SeenEvents>(seenKey(id));
}

export async function setSeen(id: string, seen: SeenEvents): Promise<void> {
  await setLocal(seenKey(id), seen);
}

// ---------------------------------------------------------------------------
// Notes (comments) poll cursor (local, T069 M2)
// ---------------------------------------------------------------------------
//
// Own cursor for `poller/notes.ts`'s A14 `since`, independent of
// `Snapshot.fetchedAt` (which advances every cycle regardless of which
// sections actually ran — a fast cycle, or a cycle where the `notes`
// section errored, must not skip the window between the last successful
// A14 request and now). ISO string; advanced by the caller only after a
// successful A14 response.

function notesCursorKey(id: string): string {
  return `notesCursor:${id}`;
}

export async function getNotesCursor(id: string): Promise<string | undefined> {
  return getLocal<string>(notesCursorKey(id));
}

export async function setNotesCursor(id: string, cursor: string): Promise<void> {
  await setLocal(notesCursorKey(id), cursor);
}

// ---------------------------------------------------------------------------
// Poll state (local)
// ---------------------------------------------------------------------------

function pollKey(id: string): string {
  return `poll:${id}`;
}

export async function getPollState(id: string): Promise<PollState | undefined> {
  return getLocal<PollState>(pollKey(id));
}

export async function setPollState(id: string, state: PollState): Promise<void> {
  await setLocal(pollKey(id), state);
}

// ---------------------------------------------------------------------------
// Workflow name cache (local, TTL managed by the caller)
// ---------------------------------------------------------------------------

export interface WorkflowsCacheEntry {
  fetchedAt: string;
  names: Record<string, string>;
}

function workflowsKey(id: string): string {
  return `workflows:${id}`;
}

export async function getWorkflowsCache(
  id: string
): Promise<WorkflowsCacheEntry | undefined> {
  return getLocal<WorkflowsCacheEntry>(workflowsKey(id));
}

export async function setWorkflowsCache(
  id: string,
  value: WorkflowsCacheEntry
): Promise<void> {
  await setLocal(workflowsKey(id), value);
}

// ---------------------------------------------------------------------------
// Own repos cache (local, TTL managed by the caller — T066, hourly in
// src/background/poller/runs.ts)
// ---------------------------------------------------------------------------

export interface OwnReposCacheEntry {
  fetchedAt: string;
  repos: RepoRef[];
}

function ownReposKey(id: string): string {
  return `ownRepos:${id}`;
}

export async function getOwnReposCache(id: string): Promise<OwnReposCacheEntry | undefined> {
  return getLocal<OwnReposCacheEntry>(ownReposKey(id));
}

export async function setOwnReposCache(id: string, value: OwnReposCacheEntry): Promise<void> {
  await setLocal(ownReposKey(id), value);
}

// ---------------------------------------------------------------------------
// Notification URL cache (local, TTL managed by the caller)
// ---------------------------------------------------------------------------

export interface NotifUrlEntry {
  url: string;
  expiresAt: number;
}

function notifUrlKey(id: string): string {
  return `notifUrl:${id}`;
}

export async function getNotifUrls(id: string): Promise<Record<string, NotifUrlEntry>> {
  return (await getLocal<Record<string, NotifUrlEntry>>(notifUrlKey(id))) ?? {};
}

export async function setNotifUrls(
  id: string,
  value: Record<string, NotifUrlEntry>
): Promise<void> {
  await setLocal(notifUrlKey(id), value);
}

// ---------------------------------------------------------------------------
// Gitea `/settings/api` cache (local, 002 R5) — TTL managed by the caller
// (src/features/builds/history-loader.ts, 24h per research.md R5).
// ---------------------------------------------------------------------------

export interface ApiSettingsCacheEntry {
  fetchedAt: string;
  maxResponseItems: number;
}

function apiSettingsKey(id: string): string {
  return `apiSettings:${id}`;
}

export async function getApiSettingsCache(
  id: string
): Promise<ApiSettingsCacheEntry | undefined> {
  return getLocal<ApiSettingsCacheEntry>(apiSettingsKey(id));
}

export async function setApiSettingsCache(
  id: string,
  value: ApiSettingsCacheEntry
): Promise<void> {
  await setLocal(apiSettingsKey(id), value);
}

// ---------------------------------------------------------------------------
// Run history cache (local, 002 data-model.md "RunHistoryCache") — one entry
// per history source (`sourceKey` = `org:<org>` | `repo:<owner>/<name>`,
// `:branch=…`/`:event=…`/`:actor=…` appended when a server filter narrows
// the source), TTL 5 min managed by the caller
// (src/features/builds/history-loader.ts). `runs` is trimmed to the newest
// `RUN_HISTORY_MAX` entries on write so a long-lived source can't grow
// storage.local unbounded.
// ---------------------------------------------------------------------------

export interface RunHistoryCacheEntry {
  fetchedAt: string;
  runs: Run[];
  nextPage: number;
  exhausted: boolean;
  oldestStartedAt?: string;
  /**
   * The widest `periodStart` (ms epoch) any `loadHistory`/`loadMore` call has
   * asked this source about while this cache entry was still fresh (T028
   * M5 fix): a repeat request for the same/narrower period within the TTL
   * makes 0 requests, but a genuinely wider period deserves a real attempt
   * even within the TTL window.
   */
  requestedPeriodStartMs?: number;
}

// T055: 30 days of a busy org (~200 runs/day). At 2000 a 30d history lost
// everything past ~10 days on every call (the loader re-paged the same
// pages and the cache cut them again).
export const RUN_HISTORY_MAX = 6000;

function runHistoryKey(id: string, sourceKey: string): string {
  return `runsHistory:${id}:${sourceKey}`;
}

export async function getRunHistoryCache(
  id: string,
  sourceKey: string
): Promise<RunHistoryCacheEntry | undefined> {
  return getLocal<RunHistoryCacheEntry>(runHistoryKey(id, sourceKey));
}

export async function setRunHistoryCache(
  id: string,
  sourceKey: string,
  value: RunHistoryCacheEntry
): Promise<void> {
  if (value.runs.length <= RUN_HISTORY_MAX) {
    await setLocal(runHistoryKey(id, sourceKey), value);
    return;
  }
  const sorted = [...value.runs].sort((a, b) => {
    const aMs = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bMs = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bMs - aMs;
  });
  await setLocal(runHistoryKey(id, sourceKey), { ...value, runs: sorted.slice(0, RUN_HISTORY_MAX) });
}

// ---------------------------------------------------------------------------
// UI state (local)
// ---------------------------------------------------------------------------

const UI_KEY = 'ui';

// othersCollapsed defaults to true: the "Builds" tab's "Others" group is
// collapsed on first run (US4 scenario, FR-030..033).
const DEFAULT_UI_STATE: UiState = { lastTab: 'repos', othersCollapsed: true };

export async function getUiState(): Promise<UiState> {
  const stored = await getLocal<UiState & { prView?: unknown; buildsView?: unknown }>(UI_KEY);
  // T050: drop legacy prView/buildsView (view toggles were removed).
  const { prView: _prView, buildsView: _buildsView, ...rest } = stored ?? {};
  return { ...DEFAULT_UI_STATE, ...rest };
}

/**
 * Merges `patch` onto the currently stored ui state (falling back to
 * `DEFAULT_UI_STATE`), so a partial update like `setUiState({ lastTab:
 * 'prs' })` never wipes unrelated fields (e.g. `lastTab`,
 * `othersCollapsed`) — data-model.md "UiState (расширение)".
 */
export async function setUiState(patch: Partial<UiState>): Promise<void> {
  const current = await getUiState();
  await setLocal(UI_KEY, { ...current, ...patch });
}

// ---------------------------------------------------------------------------
// Pinned repos (sync, FR-014)
// ---------------------------------------------------------------------------

function pinsKey(id: string): string {
  return `pins:${id}`;
}

export async function getPins(id: string): Promise<RepoRef[]> {
  return (await getSync<RepoRef[]>(pinsKey(id))) ?? [];
}

export async function setPins(id: string, pins: RepoRef[]): Promise<void> {
  await setSync(pinsKey(id), pins);
}

// ---------------------------------------------------------------------------
// Repo colour overrides (sync, FR-119)
// ---------------------------------------------------------------------------

/** fullName ("owner/name") -> palette tone index. Absent = auto (hash). */
export type RepoColors = Record<string, number>;

function repoColorsKey(id: string): string {
  return `repoColors:${id}`;
}

export async function getRepoColors(id: string): Promise<RepoColors> {
  return (await getSync<RepoColors>(repoColorsKey(id))) ?? {};
}

export async function setRepoColors(id: string, colors: RepoColors): Promise<void> {
  await setSync(repoColorsKey(id), colors);
}

/** Subscribes to `repoColors:<id>` in storage.sync. Returns an unsubscribe function. */
export function onRepoColorsChanged(id: string, callback: (colors: RepoColors) => void): () => void {
  const key = repoColorsKey(id);
  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName
  ) => {
    if (areaName !== 'sync') return;
    const change = changes[key];
    if (!change) return;
    callback((change.newValue as RepoColors | undefined) ?? {});
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Snapshot change subscription (local)
// ---------------------------------------------------------------------------

/**
 * Subscribes to changes of `snapshot:<id>` in storage.local. Returns an
 * unsubscribe function.
 */
export function onSnapshotChanged(
  id: string,
  callback: (snapshot: Snapshot) => void
): () => void {
  const key = snapshotKey(id);

  const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName
  ) => {
    if (areaName !== 'local') {
      return;
    }
    const change = changes[key];
    if (!change) {
      return;
    }
    callback(change.newValue as Snapshot);
  };

  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
