import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { FolderGit2, GitPullRequest, Hammer, Settings as SettingsIcon } from 'lucide-react';
import { browser } from 'wxt/browser';
import { t } from '@/lib/i18n';
import {
  getInstances,
  onInstancesChanged,
  getSettings,
  getSnapshot,
  getToken,
  getUiState,
  onSettingsChanged,
  onSnapshotChanged,
  setUiState,
} from '@/lib/storage';
import { DEFAULT_SETTINGS, type Settings, type Snapshot } from '@/domain/types';
import { parseRoute, serializeRoute, type PageRoute, type PageSection } from '@/domain/route';
import type { PopupHeartbeatMessage, RefreshMessage } from '@/background/messages';
import { Empty } from '@/ui/Empty';
import { ErrorState } from '@/ui/ErrorState';
import { Stale } from '@/ui/Stale';
import { ReposSection } from '@/features/repos/ReposSection';
import { PrsTable } from '@/features/prs/PrsTable';
import { BuildsHistory } from '@/features/builds/BuildsHistory';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { useMediaQuery } from '@/hooks/use-media-query';

const HEARTBEAT_MS = 5000;

interface NavItem {
  id: PageSection;
  labelKey: string;
  Icon: typeof FolderGit2;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'repos', labelKey: 'tabRepos', Icon: FolderGit2 },
  { id: 'prs', labelKey: 'tabPrs', Icon: GitPullRequest },
  { id: 'builds', labelKey: 'tabBuilds', Icon: Hammer },
];

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

/** "HH:MM" for the header's muted "обновлено HH:MM" freshness text. */
function formatHhMm(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Full-page dashboard shell (T010 + T012): tri-state configured check
 * mirroring the popup (unchanged from T010), plus (T011/T012, US2) hash
 * routing between the Репо/PR/Сборки sections (`src/domain/route.ts`), a
 * left nav column at >=1024px / shadcn Tabs below that (both driving the
 * same `section` state), Alt+1..3 shortcuts, a one-shot `refresh` on mount
 * and a `popup-heartbeat` sent every 5s while the tab is visible (stopped
 * while hidden and on unmount) so background polling speeds up the same way
 * it does while the popup is open (contracts/page-surface.md "Сообщения").
 */
export function App(): JSX.Element {
  const [snapshot, setSnapshotState] = useState<Snapshot | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Tri-state, same rationale as the popup: 'loading' renders nothing until
  // the active instance/token check resolves, avoiding a flash of the shell
  // or the "unconfigured" empty state.
  const [configured, setConfigured] = useState<'loading' | 'configured' | 'unconfigured'>('loading');
  // Best-effort initial guess from the hash alone (ui.lastPageSection isn't
  // known synchronously); refined by the effect below once storage resolves.
  const [section, setSectionState] = useState<PageSection>(
    () => parseRoute(window.location.hash, 'prs').section
  );
  // T037 (US7, FR-116): sidebar open/collapsed, persisted to `ui.sidebarOpen`.
  // Optimistic default (`true`, matching shadcn's own `defaultOpen`) until
  // the effect below resolves the stored value.
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(true);
  // T041 follow-up: if the user clicks the sidebar trigger before the
  // ui.sidebarOpen load effect below resolves (e.g. a slow storage read),
  // their explicit choice must win -- the load effect skips applying the
  // stored value once this is set, instead of clobbering it back.
  const sidebarUserToggledRef = useRef(false);
  // H2 (T041): the desktop sidebar nav only mounts at >=1024px -- driven by
  // `matchMedia` instead of a CSS-only "hidden lg:flex" class, which used to
  // fight shadcn's own `md:flex` on the Sidebar root and left both the
  // sidebar *and* the mobile Tabs bar visible at 768-1023px.
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const navigate = useCallback(
    (next: PageSection) => {
      // Navigating to the section that's already open is a no-op for the
      // hash (M2, T031): resetting it would drop that section's own
      // `view`/filter params even though the screen doesn't change.
      if (next === section) return;
      setSectionState(next);
      const route: PageRoute = { section: next, params: new URLSearchParams() };
      window.location.hash = serializeRoute(route);
      void setUiState({ lastPageSection: next });
    },
    [section]
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribeSnapshot: (() => void) | undefined;
    let generation = 0;
    let currentId: string | undefined;

    // L7: (re)runs whenever the active instance changes, so the page follows
    // an instance switch made in options instead of showing the old one.
    async function load(): Promise<void> {
      const mine = ++generation;
      const stale = (): boolean => cancelled || mine !== generation;
      unsubscribeSnapshot?.();
      unsubscribeSnapshot = undefined;
      const { activeInstanceId } = await getInstances();
      if (stale()) return;
      currentId = activeInstanceId;
      if (!activeInstanceId) {
        setSnapshotState(undefined);
        setConfigured('unconfigured');
        return;
      }

      const token = await getToken(activeInstanceId);
      if (stale()) return;
      if (!token) {
        setSnapshotState(undefined);
        setConfigured('unconfigured');
        return;
      }
      setConfigured('configured');

      const snap = await getSnapshot(activeInstanceId);
      if (stale()) return;
      setSnapshotState(snap);

      unsubscribeSnapshot = onSnapshotChanged(activeInstanceId, (next) => {
        setSnapshotState(next);
      });
    }

    void load();
    const offInstances = onInstancesChanged(({ activeInstanceId }) => {
      if (cancelled || activeInstanceId === currentId) return;
      void load();
    });

    return () => {
      cancelled = true;
      offInstances();
      unsubscribeSnapshot?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getSettings().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });

    const unsubscribe = onSettingsChanged((next) => {
      setSettings(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Resolves the initial section from the hash, falling back to
  // `ui.lastPageSection ?? 'prs'` (data-model.md "PageRoute") once storage
  // has loaded -- refines the synchronous hash-only guess above. Also
  // resolves the stored sidebar open/collapsed state (T037) from the same
  // read.
  useEffect(() => {
    let cancelled = false;
    void getUiState()
      .then((ui) => {
        if (cancelled) return;
        const fallback = ui.lastPageSection ?? 'prs';
        setSectionState(parseRoute(window.location.hash, fallback).section);
        // T041 follow-up: an explicit user toggle that happened while this
        // read was in flight wins -- applying the stored value here would
        // otherwise clobber it back (e.g. a slow storage read racing a
        // trigger click right after mount).
        if (!sidebarUserToggledRef.current) {
          setSidebarOpenState(ui.sidebarOpen ?? true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // T037: persists the sidebar's open/collapsed state to `ui.sidebarOpen`
  // (data-model.md "UiState (расширение)") so it's restored across page
  // reopenings, independently of the current section.
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    sidebarUserToggledRef.current = true;
    setSidebarOpenState(open);
    void setUiState({ sidebarOpen: open });
  }, []);

  // Back/forward navigation (or any external hash change) switches the
  // section too.
  useEffect(() => {
    function handleHashChange(): void {
      setSectionState((current) => parseRoute(window.location.hash, current).section);
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Alt+1..3 switch sections (contracts/page-surface.md "Клавиатура"),
  // mirroring the popup's Alt+1..3 tab shortcuts.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!event.altKey) return;
      const index = Number(event.key) - 1;
      const item = NAV_ITEMS[index];
      if (item) {
        event.preventDefault();
        navigate(item.id);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  // Sent once on open (contracts/page-surface.md "Сообщения"): the
  // background may not have a listener yet (or at all, e.g. in tests) -- a
  // rejected promise here must not surface as an unhandled rejection.
  useEffect(() => {
    browser.runtime
      .sendMessage({ type: 'refresh', reason: 'popup-open' } satisfies RefreshMessage)
      .catch(() => {});
  }, []);

  // While the tab is visible, sends `popup-heartbeat` every 5s so the
  // background's fast-poll loop stays alive (same contract as the popup's
  // BuildsGroups heartbeat) -- but only while this tab is actually the
  // foreground one, unlike the popup (which is only ever open while
  // visible). Stops within one tick of the tab going hidden and never fires
  // again after unmount (US2 edge case: "Вкладка дашборда закрыта во время
  // учащённого обновления").
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;

    function send(): void {
      browser.runtime
        .sendMessage({ type: 'popup-heartbeat', page: true } satisfies PopupHeartbeatMessage)
        .catch(() => {});
    }

    function start(): void {
      if (intervalId !== undefined) return;
      send();
      intervalId = setInterval(send, HEARTBEAT_MS);
    }

    function stop(): void {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, []);

  const shellClass = 'flex min-h-screen flex-col bg-background text-foreground';

  if (configured === 'loading') {
    // Neutral: render nothing until we know whether there is a configured,
    // authenticated instance (avoids flashing the shell or the
    // "unconfigured" empty state).
    return <div className={shellClass} />;
  }

  if (configured === 'unconfigured') {
    return (
      <div className={`${shellClass} items-center justify-center`}>
        <div className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <Empty
            messageKey="popupUnconfigured"
            action={{ labelKey: 'errorStateOpenOptions', onClick: openOptions }}
          />
        </div>
      </div>
    );
  }

  const authError = snapshot?.error?.kind === 'auth';
  const reviewsCount = snapshot?.counts.reviews ?? 0;
  const activeMineCount = snapshot?.counts.activeMine ?? 0;

  function badgeFor(id: PageSection): JSX.Element | null {
    if (id === 'prs') return <Badge variant="secondary">{reviewsCount}</Badge>;
    if (id === 'builds') return <Badge variant="secondary">{activeMineCount}</Badge>;
    return null;
  }

  // T041 re-scope: the page now always shows the table/history views (no
  // more Группы/Таблица and Группы/История toggles) -- "Репо" additionally
  // fills the remaining viewport height (its own list scrolls internally
  // instead of the whole page growing).
  function renderSection(): JSX.Element {
    switch (section) {
      case 'repos':
        return <ReposSection density="comfortable" fillHeight />;
      case 'prs':
        return <PrsTable snapshot={snapshot} settings={settings} />;
      case 'builds':
        return <BuildsHistory />;
    }
  }

  // T041 (H2): the desktop nav (shadcn sidebar, collapsible="icon", state in
  // ui.sidebarOpen) only mounts at >=1024px (`isDesktop`, matchMedia-backed);
  // narrower screens mount the bottom Tabs bar instead -- only one of the two
  // is ever mounted, so they can no longer both be visible at once.
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={handleSidebarOpenChange}
      className="h-svh min-h-0 overflow-hidden bg-background text-foreground"
    >
      {isDesktop && (
        <Sidebar collapsible="icon">
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      type="button"
                      tooltip={t(item.labelKey)}
                      isActive={section === item.id}
                      onClick={() => navigate(item.id)}
                    >
                      <item.Icon size={16} />
                      <span>{t(item.labelKey)}</span>
                    </SidebarMenuButton>
                    {item.id === 'prs' && <SidebarMenuBadge>{reviewsCount}</SidebarMenuBadge>}
                    {item.id === 'builds' && <SidebarMenuBadge>{activeMineCount}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
      )}
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
          {isDesktop && <SidebarTrigger />}
          <h1 className="text-lg font-semibold">{t('dashboardTitle')}</h1>
          <div className="flex-1" />
          {snapshot?.fetchedAt && (
            <span className="text-sm text-muted-foreground">
              {t('dashboardUpdatedAt', formatHhMm(snapshot.fetchedAt))}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('popupSettingsButton')}
            onClick={openOptions}
          >
            <SettingsIcon size={16} />
          </Button>
        </header>
        {snapshot?.error && !authError && <Stale fetchedAt={snapshot.fetchedAt} />}
        {!isDesktop && (
          <div className="shrink-0 border-b p-2">
            <Tabs value={section} onValueChange={(value) => navigate(value as PageSection)}>
              <TabsList className="grid w-full grid-cols-3">
                {NAV_ITEMS.map((item) => (
                  <TabsTrigger key={item.id} value={item.id} className="gap-1.5">
                    <item.Icon size={16} />
                    <span>{t(item.labelKey)}</span>
                    {badgeFor(item.id)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
            {authError ? <ErrorState messageKey="authError" /> : renderSection()}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
