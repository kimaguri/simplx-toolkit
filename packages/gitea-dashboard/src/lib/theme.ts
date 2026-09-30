// T075: shadcn/ui + Tailwind v4 theming is class-based (`.dark` on <html>),
// not the OS-level `@media (prefers-color-scheme)` blocks theme.css used.
// We still want the effective theme to follow the OS setting (no manual
// toggle in this extension), so this module is the single place that reads
// `prefers-color-scheme` and keeps `<html class="dark">` in sync with it.

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Current OS color scheme, read directly (no caching). */
export function isDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Applies the OS color scheme to `<html>` immediately and keeps it in sync
 * as the OS setting changes while the popup/options page is open.
 * Call once per entrypoint (popup, options) before rendering.
 */
export function applySystemTheme(): void {
  const media = window.matchMedia(DARK_QUERY);
  const sync = () => {
    document.documentElement.classList.toggle('dark', media.matches);
  };
  sync();
  media.addEventListener('change', sync);
}
