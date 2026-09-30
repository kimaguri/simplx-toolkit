import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS } from '../../src/domain/types';
import {
  getSettings,
  getToken,
  getUiState,
  instanceId,
  normalizeBaseUrl,
  onSnapshotChanged,
  setSettings,
  setToken,
  setUiState,
} from '../../src/lib/storage';

describe('normalizeBaseUrl', () => {
  it('strips trailing slash', () => {
    expect(normalizeBaseUrl('https://x.example/')).toBe('https://x.example');
  });

  it('is stable without trailing slash', () => {
    expect(normalizeBaseUrl('https://x.example')).toBe('https://x.example');
  });

  it('strips trailing /api/v1', () => {
    expect(normalizeBaseUrl('https://x.example/api/v1')).toBe('https://x.example');
  });

  it('strips trailing /api/v1 and trailing slash combined', () => {
    expect(normalizeBaseUrl('https://x.example/api/v1/')).toBe('https://x.example');
  });

  it('lowercases the host', () => {
    expect(normalizeBaseUrl('https://X.Example.COM')).toBe('https://x.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  https://x.example  ')).toBe('https://x.example');
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => normalizeBaseUrl('ftp://x.example')).toThrow();
  });

  it('rejects garbage input', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow();
  });
});

describe('instanceId', () => {
  it('is stable across equivalent baseUrl variants', async () => {
    const a = await instanceId('https://x.example/');
    const b = await instanceId('https://x.example');
    const c = await instanceId('https://x.example/api/v1');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('has the i_<8 hex> shape', async () => {
    const id = await instanceId('https://x.example');
    expect(id).toMatch(/^i_[0-9a-f]{8}$/);
  });

  it('differs for different hosts', async () => {
    const a = await instanceId('https://x.example');
    const b = await instanceId('https://y.example');
    expect(a).not.toBe(b);
  });
});

describe('token storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('writes the token only to storage.local under token:<id>', async () => {
    await setToken('i_deadbeef', 'test-token');

    const local = await fakeBrowser.storage.local.get('token:i_deadbeef');
    expect(local['token:i_deadbeef']).toBe('test-token');

    expect(await getToken('i_deadbeef')).toBe('test-token');
  });

  it('never puts the token in storage.sync', async () => {
    await setToken('i_deadbeef', 'test-token');

    const syncAll = await fakeBrowser.storage.sync.get(null);
    const serialized = JSON.stringify(syncAll);
    expect(serialized).not.toContain('test-token');
  });
});

describe('settings storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('returns DEFAULT_SETTINGS when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial stored value with DEFAULT_SETTINGS on read', async () => {
    await fakeBrowser.storage.sync.set({
      settings: { pollIntervalSec: 90 },
    });

    const settings = await getSettings();
    expect(settings.pollIntervalSec).toBe(90);
    expect(settings.badgeMode).toBe(DEFAULT_SETTINGS.badgeMode);
    expect(settings.notify).toEqual(DEFAULT_SETTINGS.notify);
  });

  it('writes settings to storage.sync under key "settings"', async () => {
    await setSettings(DEFAULT_SETTINGS);
    const sync = await fakeBrowser.storage.sync.get('settings');
    expect(sync.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects pollIntervalSec < 30', async () => {
    await expect(
      setSettings({ ...DEFAULT_SETTINGS, pollIntervalSec: 29 })
    ).rejects.toThrow();

    const sync = await fakeBrowser.storage.sync.get('settings');
    expect(sync.settings).toBeUndefined();
  });

  it('accepts pollIntervalSec === 30', async () => {
    await expect(
      setSettings({ ...DEFAULT_SETTINGS, pollIntervalSec: 30 })
    ).resolves.not.toThrow();
  });
});

describe('onSnapshotChanged', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('invokes the callback when snapshot:<id> changes in storage.local, and can unsubscribe', async () => {
    const calls: unknown[] = [];
    const unsubscribe = onSnapshotChanged('i_deadbeef', (snapshot) => {
      calls.push(snapshot);
    });

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      prs: [],
      runs: [],
      counts: { reviews: 0, activeMine: 0, activeOthers: 0, failedOthers: 0 },
    };

    await fakeBrowser.storage.local.set({ 'snapshot:i_deadbeef': snapshot });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(snapshot);

    // Unrelated key must not trigger the callback.
    await fakeBrowser.storage.local.set({ 'snapshot:i_other': snapshot });
    expect(calls).toHaveLength(1);

    unsubscribe();
    await fakeBrowser.storage.local.set({ 'snapshot:i_deadbeef': { ...snapshot, prs: [] } });
    expect(calls).toHaveLength(1);
  });
});

describe('ui state (002 T006/T050: lastPageSection; legacy prView/buildsView ignored)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('defaults lastPageSection to undefined when nothing was stored', async () => {
    const ui = await getUiState();
    expect(ui.lastPageSection).toBeUndefined();
    expect(ui.lastTab).toBe('repos');
    expect(ui.othersCollapsed).toBe(true);
  });

  it('round-trips lastPageSection', async () => {
    await setUiState({ lastTab: 'prs', othersCollapsed: false, lastPageSection: 'builds' });
    const ui = await getUiState();
    expect(ui.lastPageSection).toBe('builds');
    expect(ui.lastTab).toBe('prs');
    expect(ui.othersCollapsed).toBe(false);
  });

  it('a partial setUiState update merges into stored state instead of wiping it', async () => {
    await setUiState({ lastTab: 'builds', othersCollapsed: false, lastPageSection: 'prs' });
    await setUiState({ lastPageSection: 'repos' });
    const ui = await getUiState();
    expect(ui.lastPageSection).toBe('repos');
    expect(ui.lastTab).toBe('builds');
    expect(ui.othersCollapsed).toBe(false);
  });

  it('T050: stored legacy prView/buildsView are ignored without error', async () => {
    await fakeBrowser.storage.local.set({
      ui: { lastTab: 'prs', othersCollapsed: false, prView: 'groups', buildsView: 'history' },
    });
    const ui = await getUiState();
    expect(ui.lastTab).toBe('prs');
    expect(ui.othersCollapsed).toBe(false);
    expect(ui).not.toHaveProperty('prView');
    expect(ui).not.toHaveProperty('buildsView');
    await expect(setUiState({ lastPageSection: 'prs' })).resolves.toBeUndefined();
    const stored = (await fakeBrowser.storage.local.get('ui')).ui as Record<string, unknown>;
    expect(stored).not.toHaveProperty('prView');
    expect(stored).not.toHaveProperty('buildsView');
  });
});
