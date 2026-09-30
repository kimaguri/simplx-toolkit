// Dashboard-only: a small `matchMedia`-backed hook (H2, tasks.md T041)
// used to mount the desktop sidebar only at >=1024px instead of the
// previous CSS-only ("hidden lg:flex") approach, which fought shadcn's own
// `md:flex` on the Sidebar root at 768-1023px (both nav *and* the mobile
// Tabs bar were visible in that range).
import { useEffect, useState } from 'react';

/**
 * SSR-safe (no `window`/`matchMedia` at import time -- defaults to `false`
 * until the effect below resolves the real value on mount), and re-renders
 * on any viewport change that flips the query.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    function handleChange(): void {
      setMatches(mql.matches);
    }
    handleChange();
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}
