import { browser } from 'wxt/browser';

/**
 * Looks up `key` in the extension's `_locales/<lang>/messages.json` via
 * `browser.i18n.getMessage`. Falls back to returning `key` itself when the
 * message is missing/empty (e.g. not yet added to messages.json).
 */
export function t(key: string, subs?: string | string[]): string {
  // `key` intentionally accepts any string (including keys not yet present
  // in messages.json, which fall back below) — the generated i18n message
  // union from `wxt prepare` is narrower than that, hence the cast.
  const message = browser.i18n.getMessage(
    key as Parameters<typeof browser.i18n.getMessage>[0],
    subs,
  );
  return message ? message : key;
}
