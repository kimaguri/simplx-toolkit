// "Репо" section (US2, FR-010..014). Talks to searchRepos directly — the
// documented plan.md exception to the usual poller/snapshot flow — using the
// active instance's token/baseUrl from src/lib/storage.ts.
//
// Rendered by src/entrypoints/popup/tabs/Repos.tsx (density="compact") and,
// per docs/specs/002-fullpage-dashboard/research.md R8, by the dashboard page
// (density="comfortable") — same behavior, roomier spacing on the page.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { relative } from '../../lib/time';
import { createClient } from '../../api/client';
import { createEndpoints, type Endpoints } from '../../api/endpoints';
import { getInstances, getPins, getToken, setPins } from '../../lib/storage';
import { mergeRepoList, repoUrl, togglePin, type RepoUrlMode } from '../../domain/repos';
import type { ApiRepository } from '../../api/types';
import type { Repo, RepoRef } from '../../domain/types';
import { List } from '../../ui/List';
import { Empty } from '../../ui/Empty';
import { ErrorState } from '../../ui/ErrorState';
import { LockIcon, PinIcon } from '../../ui/RepoIcons';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { useRepoColors } from '../../ui/repo-colors';

const DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;

export type Density = 'compact' | 'comfortable';

export interface ReposSectionProps {
  density: Density;
  /**
   * T041 (dashboard page only, popup untouched): stretches this section to
   * fill its parent's available height instead of only as tall as its
   * content — the list scrolls internally (List's own `maxHeight="none"`)
   * inside a `flex-1 min-h-0` column instead of the fixed 320px popup
   * default. Defaults to `false` (popup's existing fixed-height behaviour).
   */
  fillHeight?: boolean;
}

export function ReposSection({ density, fillHeight = false }: ReposSectionProps): JSX.Element {
  const comfortable = density === 'comfortable';
  const inputRef = useRef<HTMLInputElement>(null);
  // FR-119: colour picker slot, provided only by the dashboard page (no
  // provider in the popup -> nothing rendered, popup bundle unchanged).
  const { renderRowPicker } = useRepoColors();

  const [configured, setConfigured] = useState(true);
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);
  const [endpoints, setEndpoints] = useState<Endpoints | undefined>(undefined);
  const [pins, setPinsState] = useState<RepoRef[]>([]);

  const [query, setQuery] = useState('');
  // undefined until the first search resolves — a pinned repo has no
  // confirmed htmlUrl/private/updatedAt yet, so nothing is shown before then
  // (matches the pre-refactor behavior of only ever rendering fetched data).
  const [results, setResults] = useState<ApiRepository[] | undefined>(undefined);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Merged view of the latest search results + current pins. Recomputes on a
  // pin toggle without touching `results` — Cmd/Ctrl+P must not refetch or
  // reset `selectedIndex` (see the search effect below, which intentionally
  // excludes `pins` from its deps).
  const items = useMemo(
    () => (results === undefined ? [] : mergeRepoList(pins, results)),
    [pins, results]
  );

  // FR-010: autofocus the search input on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load the active instance's client + pins once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { instances, activeInstanceId } = await getInstances();
      if (!activeInstanceId) {
        if (!cancelled) setConfigured(false);
        return;
      }
      const instance = instances.find((i) => i.id === activeInstanceId);
      const [token, currentPins] = await Promise.all([
        getToken(activeInstanceId),
        getPins(activeInstanceId),
      ]);
      if (cancelled) return;
      if (!instance || !token) {
        setConfigured(false);
        return;
      }
      setInstanceId(activeInstanceId);
      setPinsState(currentPins);
      setEndpoints(createEndpoints(createClient({ baseUrl: instance.baseUrl, token })));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // FR-010/011: debounced search — empty query -> pins + searchRepos('', 20)
  // (sorted by updated_at), otherwise the filtered results from the API.
  useEffect(() => {
    if (!endpoints) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(undefined);
        try {
          const searchResults = await endpoints.searchRepos(query, SEARCH_LIMIT);
          if (cancelled) return;
          setResults(searchResults);
          setSelectedIndex(0);
        } catch {
          if (!cancelled) setError('reposSearchError');
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `pins` intentionally excluded: toggling a pin (Cmd/Ctrl+P) must not
    // refetch or reset `selectedIndex` — `items` re-merges via useMemo above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints, query]);

  function openRepo(repo: Repo, mode: RepoUrlMode): void {
    void browser.tabs.create({ url: repoUrl(repo, mode) });
  }

  function handleTogglePin(repo: Repo): void {
    if (!instanceId) return;
    const nextPins = togglePin(pins, { owner: repo.owner, name: repo.name });
    setPinsState(nextPins);
    void setPins(instanceId, nextPins);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      const repo = items[selectedIndex];
      if (repo) handleTogglePin(repo);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      const repo = items[selectedIndex];
      if (!repo) return;
      event.preventDefault();
      if (mod) {
        openRepo(repo, 'pulls');
      } else if (event.shiftKey) {
        openRepo(repo, 'actions');
      } else {
        openRepo(repo, 'open');
      }
    }
  }

  if (!configured) {
    return <Empty messageKey="reposNotConfigured" />;
  }

  return (
    <div className={cn(fillHeight && 'flex min-h-0 flex-1 flex-col')}>
      <div className="relative mb-2">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="text"
          role="textbox"
          value={query}
          placeholder={t('reposSearchPlaceholder')}
          aria-label={t('reposSearchPlaceholder')}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          onKeyDown={handleInputKeyDown}
          className={cn(
            'h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pr-3 pl-8 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          )}
        />
      </div>
      {error && <ErrorState messageKey={error} />}
      {!error && !loading && items.length === 0 && <Empty messageKey="reposEmpty" />}
      {!error && items.length > 0 && (
        <div className={cn(fillHeight && 'min-h-0 flex-1 overflow-y-auto')}>
        <List
          items={items}
          selectedIndex={selectedIndex}
          onSelectIndex={setSelectedIndex}
          onActivate={(repo) => openRepo(repo, 'open')}
          aria-label={t('tabRepos')}
          maxHeight={fillHeight ? 'none' : undefined}
          renderItem={(repo) => (
            <div
              className={cn('flex items-center justify-between gap-2', comfortable && 'py-2.5')}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn('font-medium', comfortable ? 'text-base' : 'truncate')}>
                    {repo.owner}/{repo.name}
                  </span>
                  {repo.private && <LockIcon />}
                </div>
                <div className={cn('text-xs text-muted-foreground', !comfortable && 'truncate')}>
                  {repo.updatedAt ? relative(repo.updatedAt, new Date()) : ''}
                </div>
              </div>
              <div className="flex items-center gap-0.5">
              {comfortable && renderRowPicker?.(`${repo.owner}/${repo.name}`)}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('reposTogglePin')}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleTogglePin(repo);
                }}
              >
                <PinIcon pinned={repo.pinned} />
              </Button>
              </div>
            </div>
          )}
        />
        </div>
      )}
    </div>
  );
}
