// @vitest-environment happy-dom
// T044 / FR-119: per-repo colour override.
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { getRepoColors, setRepoColors, onRepoColorsChanged } from '../../src/lib/storage';
import { repoColorIndex, resolveRepoTone } from '../../src/domain/labels';
import { RepoTag } from '../../src/ui/Tags';
import { RepoColorsProvider } from '../../src/features/repos/RepoColorsProvider';
import { RepoColorPicker } from '../../src/features/repos/RepoColorPicker';
import { useRepoColors } from '../../src/ui/repo-colors';
import { setInstances } from '../../src/lib/storage';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});
afterEach(cleanup);

describe('resolveRepoTone', () => {
  it('falls back to the hash without override', () => {
    expect(resolveRepoTone('a/b', undefined)).toBe(repoColorIndex('a/b'));
    expect(resolveRepoTone('a/b', {})).toBe(repoColorIndex('a/b'));
  });
  it('uses a valid override', () => {
    const other = (repoColorIndex('a/b') + 1) % 8;
    expect(resolveRepoTone('a/b', { 'a/b': other })).toBe(other);
  });
  it('ignores an out-of-range override', () => {
    expect(resolveRepoTone('a/b', { 'a/b': 99 })).toBe(repoColorIndex('a/b'));
  });
});

describe('repoColors storage (sync)', () => {
  it('round-trips per instance and defaults to {}', async () => {
    expect(await getRepoColors('i1')).toEqual({});
    await setRepoColors('i1', { 'a/b': 3 });
    expect(await getRepoColors('i1')).toEqual({ 'a/b': 3 });
    expect(await getRepoColors('i2')).toEqual({});
    const stored = await browser.storage.sync.get('repoColors:i1');
    expect(stored['repoColors:i1']).toEqual({ 'a/b': 3 });
  });
  it('onRepoColorsChanged fires for own instance sync changes only', async () => {
    const cb = vi.fn();
    const off = onRepoColorsChanged('i1', cb);
    await browser.storage.sync.set({ 'repoColors:i2': { x: 1 } });
    await browser.storage.local.set({ 'repoColors:i1': { x: 1 } });
    expect(cb).not.toHaveBeenCalled();
    await setRepoColors('i1', { 'a/b': 2 });
    expect(cb).toHaveBeenCalledWith({ 'a/b': 2 });
    off();
    await setRepoColors('i1', {});
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

function toneOf(el: HTMLElement): string {
  return el.className;
}

describe('RepoTag with overrides', () => {
  it('without provider uses hash', () => {
    render(<RepoTag fullName="acme/api" allFullNames={['acme/api']} />);
    expect(screen.getByText('api')).toBeTruthy();
  });

  it('provider override changes the tag colour', async () => {
    const auto = render(<RepoTag fullName="acme/api" allFullNames={['acme/api']} />);
    const autoClass = toneOf(auto.getByText('api'));
    cleanup();
    const other = (repoColorIndex('acme/api') + 1) % 8;
    await setInstances({
      instances: [{ id: 'i1', baseUrl: 'https://g.example', capabilities: {} as never }],
      activeInstanceId: 'i1',
    });
    await setRepoColors('i1', { 'acme/api': other });
    render(
      <RepoColorsProvider>
        <RepoTag fullName="acme/api" allFullNames={['acme/api']} />
      </RepoColorsProvider>
    );
    await waitFor(() => expect(toneOf(screen.getByText('api'))).not.toBe(autoClass));
  });
});

describe('RepoColorPicker', () => {
  function Harness(): JSX.Element {
    const { overrides } = useRepoColors();
    return (
      <div>
        <RepoTag fullName="acme/api" allFullNames={['acme/api']} />
        <RepoColorPicker fullName="acme/api" />
        <span data-testid="ov">{JSON.stringify(overrides)}</span>
      </div>
    );
  }

  async function setup(): Promise<void> {
    await setInstances({
      instances: [{ id: 'i1', baseUrl: 'https://g.example', capabilities: {} as never }],
      activeInstanceId: 'i1',
    });
    render(
      <RepoColorsProvider>
        <Harness />
      </RepoColorsProvider>
    );
    await waitFor(() => expect(screen.getByTestId('ov')).toBeTruthy());
  }

  it('choosing a tone changes the tag live and persists; Авто resets', async () => {
    await setup();
    const before = toneOf(screen.getByText('api'));
    const target = (repoColorIndex('acme/api') + 1) % 8;
    fireEvent.click(screen.getByRole('button', { name: 'repoColorButton' }));
    fireEvent.click(await screen.findByTestId(`repo-color-tone-${target}`));
    await waitFor(() => expect(toneOf(screen.getByText('api'))).not.toBe(before));
    await waitFor(async () =>
      expect(await getRepoColors('i1')).toEqual({ 'acme/api': target })
    );

    fireEvent.click(screen.getByRole('button', { name: 'repoColorButton' }));
    fireEvent.click(await screen.findByRole('button', { name: 'repoColorAuto' }));
    await waitFor(() => expect(toneOf(screen.getByText('api'))).toBe(before));
    await waitFor(async () => expect(await getRepoColors('i1')).toEqual({}));
  });

  it('picks up a sync change from another device', async () => {
    await setup();
    const before = toneOf(screen.getByText('api'));
    const target = (repoColorIndex('acme/api') + 1) % 8;
    await setRepoColors('i1', { 'acme/api': target });
    await waitFor(() => expect(toneOf(screen.getByText('api'))).not.toBe(before));
  });
});

describe('RepoColorsProvider follows the active instance (T048 L7)', () => {
  it('re-reads overrides for the new instance and writes only under its key', async () => {
    const inst = (id: string) => ({ id, baseUrl: 'https://g.example', capabilities: {} as never });
    await setInstances({ instances: [inst('i1'), inst('i2')], activeInstanceId: 'i1' });
    await setRepoColors('i1', { 'acme/api': 1 });
    await setRepoColors('i2', { 'acme/api': 5 });

    function Probe(): JSX.Element {
      const { overrides, setColor } = useRepoColors();
      return (
        <div>
          <span data-testid="ov">{JSON.stringify(overrides)}</span>
          <button onClick={() => setColor?.('acme/web', 3)}>set</button>
        </div>
      );
    }
    render(
      <RepoColorsProvider>
        <Probe />
      </RepoColorsProvider>
    );
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('{"acme/api":1}'));

    await setInstances({ instances: [inst('i1'), inst('i2')], activeInstanceId: 'i2' });
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('{"acme/api":5}'));

    fireEvent.click(screen.getByText('set'));
    await waitFor(async () => expect(await getRepoColors('i2')).toEqual({ 'acme/api': 5, 'acme/web': 3 }));
    expect(await getRepoColors('i1')).toEqual({ 'acme/api': 1 });
  });
});
