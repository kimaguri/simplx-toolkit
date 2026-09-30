// @vitest-environment happy-dom
// T075: `applySystemTheme()` must toggle `dark` on <html> from the OS
// color-scheme immediately, and keep it in sync as the OS setting changes
// (matchMedia 'change' listener) — this is what replaced the old
// `prefers-color-scheme` CSS media queries in src/ui/theme.css (T075).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySystemTheme, isDark } from '../../src/lib/theme';

type Listener = (event: { matches: boolean }) => void;

class FakeMediaQueryList {
  matches: boolean;
  private listeners = new Set<Listener>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: 'change', listener: Listener) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: Listener) {
    this.listeners.delete(listener);
  }

  // Test helper: flips `matches` and notifies listeners, like a real OS
  // color-scheme change would via the 'change' event.
  emit(matches: boolean) {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches });
  }
}

function stubMatchMedia(initialDark: boolean): FakeMediaQueryList {
  const mql = new FakeMediaQueryList(initialDark);
  window.matchMedia = ((query: string) => {
    if (query !== '(prefers-color-scheme: dark)') {
      throw new Error(`unexpected media query: ${query}`);
    }
    return mql as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return mql;
}

describe('theme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('isDark reflects matchMedia(prefers-color-scheme: dark).matches', () => {
    stubMatchMedia(true);
    expect(isDark()).toBe(true);

    stubMatchMedia(false);
    expect(isDark()).toBe(false);
  });

  it('applySystemTheme adds `dark` to <html> immediately when OS is dark', () => {
    stubMatchMedia(true);
    applySystemTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applySystemTheme does not add `dark` when OS is light', () => {
    stubMatchMedia(false);
    applySystemTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applySystemTheme keeps <html class="dark"> in sync with later OS changes', () => {
    const mql = stubMatchMedia(false);
    applySystemTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    mql.emit(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    mql.emit(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
