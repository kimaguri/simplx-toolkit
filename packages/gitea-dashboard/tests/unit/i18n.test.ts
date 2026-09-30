import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { t } from '../../src/lib/i18n';

describe('t', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the browser.i18n.getMessage result', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('Привет');
    expect(t('greeting')).toBe('Привет');
  });

  it('falls back to the key when the message is empty', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    expect(t('missing_key')).toBe('missing_key');
  });

  it('passes a single substitution through', () => {
    const spy = vi
      .spyOn(browser.i18n, 'getMessage')
      .mockReturnValue('Привет, Аня');
    expect(t('greeting_name', 'Аня')).toBe('Привет, Аня');
    expect(spy).toHaveBeenCalledWith('greeting_name', 'Аня');
  });

  it('passes multiple substitutions through', () => {
    const spy = vi
      .spyOn(browser.i18n, 'getMessage')
      .mockReturnValue('2 из 5');
    expect(t('progress', ['2', '5'])).toBe('2 из 5');
    expect(spy).toHaveBeenCalledWith('progress', ['2', '5']);
  });
});
