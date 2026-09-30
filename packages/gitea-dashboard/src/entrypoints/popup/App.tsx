import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ExternalLink, Settings as SettingsIcon } from 'lucide-react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { openDashboard } from '../../background/open-dashboard';
import {
  getInstances,
  getSettings,
  getSnapshot,
  getToken,
  getUiState,
  onSettingsChanged,
  onSnapshotChanged,
  setUiState,
} from '../../lib/storage';
import { DEFAULT_SETTINGS, type Capabilities, type Settings, type Snapshot } from '../../domain/types';
import type { RefreshMessage } from '../../background/messages';
import { Stale } from '../../ui/Stale';
import { Empty } from '../../ui/Empty';
import { ErrorState } from '../../ui/ErrorState';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Repos } from './tabs/Repos';
import { Prs } from './tabs/Prs';
import { Builds } from './tabs/Builds';

type TabId = 'repos' | 'prs' | 'builds';

const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'repos', labelKey: 'tabRepos' },
  { id: 'prs', labelKey: 'tabPrs' },
  { id: 'builds', labelKey: 'tabBuilds' },
];

function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

/** Popup shell: tab bar (Repos / PRs / Builds) + active-instance snapshot wiring. */
export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('repos');
  const [snapshot, setSnapshotState] = useState<Snapshot | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState<string | undefined>(undefined);
  // Tri-state: 'loading' while the active instance/token check is in flight
  // (nothing is rendered yet — T058: rendering the tab bar optimistically
  // here caused it to flash before flipping to the "unconfigured" empty
  // state), then 'configured' or 'unconfigured' once the check resolves.
  const [configured, setConfigured] = useState<'loading' | 'configured' | 'unconfigured'>('loading');

  const switchTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    void setUiState({ lastTab: tab });
  }, []);

  const openInTab = useCallback(() => {
    // If opening the dashboard tab fails, keep the popup open and do nothing
    // further (no toast/log — L2): closing it here would strand the user
    // with no way to retry, and this must never surface as an unhandled
    // rejection.
    void openDashboard(activeTab)
      .then(() => window.close())
      .catch(() => {});
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeSnapshot: (() => void) | undefined;

    void (async () => {
      const ui = await getUiState();
      if (cancelled) return;
      if (isTabId(ui.lastTab)) {
        setActiveTab(ui.lastTab);
      }

      const { instances, activeInstanceId } = await getInstances();
      if (cancelled) return;
      if (!activeInstanceId) {
        setConfigured('unconfigured');
        return;
      }

      const token = await getToken(activeInstanceId);
      if (cancelled) return;
      if (!token) {
        setConfigured('unconfigured');
        return;
      }
      setConfigured('configured');

      const activeInstance = instances.find((instance) => instance.id === activeInstanceId);
      if (activeInstance) {
        setCapabilities(activeInstance.capabilities);
        setBaseUrl(activeInstance.baseUrl);
      }

      const snap = await getSnapshot(activeInstanceId);
      if (!cancelled) {
        setSnapshotState(snap);
      }

      unsubscribeSnapshot = onSnapshotChanged(activeInstanceId, (next) => {
        setSnapshotState(next);
      });
    })();

    // Fire-and-forget: the background page may not have a listener attached
    // yet (or at all, e.g. in tests) — a rejected promise here must not
    // surface as an unhandled rejection or crash the popup.
    browser.runtime
      .sendMessage({ type: 'refresh', reason: 'popup-open' } satisfies RefreshMessage)
      .catch(() => {});

    return () => {
      cancelled = true;
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

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey) return;
      const index = Number(event.key) - 1;
      const tab = TABS[index];
      if (tab) {
        event.preventDefault();
        switchTab(tab.id);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [switchTab]);

  const shellClass = 'flex w-[400px] max-h-[580px] flex-col bg-background text-sm text-foreground';

  if (configured === 'loading') {
    // Neutral: render nothing until we know whether there is a configured,
    // authenticated instance (avoids flashing the tab bar or the
    // "unconfigured" empty state).
    return <div className={shellClass} />;
  }

  if (configured === 'unconfigured') {
    return (
      <div className={shellClass}>
        <Empty
          messageKey="popupUnconfigured"
          action={{ labelKey: 'errorStateOpenOptions', onClick: openOptions }}
        />
      </div>
    );
  }

  const authError = snapshot?.error?.kind === 'auth';
  const reviewsCount = snapshot?.counts.reviews ?? 0;
  const activeMineCount = snapshot?.counts.activeMine ?? 0;

  return (
    <div className={shellClass}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-medium">{t('extName')}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('popupOpenInTab')}
            title={t('popupOpenInTab')}
            onClick={openInTab}
          >
            <ExternalLink size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('popupSettingsButton')}
            title={t('popupSettingsButton')}
            onClick={openOptions}
          >
            <SettingsIcon size={16} />
          </Button>
        </div>
      </div>
      {snapshot?.error && <Stale fetchedAt={snapshot.fetchedAt} />}
      <Tabs
        value={activeTab}
        onValueChange={(value) => switchTab(value as TabId)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-2 mt-2 grid w-auto grid-cols-3">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
              <span>{t(tab.labelKey)}</span>
              {tab.id === 'prs' && <Badge variant="secondary">{reviewsCount}</Badge>}
              {tab.id === 'builds' && <Badge variant="secondary">{activeMineCount}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="repos" className="min-h-0 flex-1 overflow-y-auto p-2">
          {authError ? <ErrorState messageKey="authError" /> : <Repos />}
        </TabsContent>
        <TabsContent value="prs" className="min-h-0 flex-1 overflow-y-auto p-2">
          {authError ? (
            <ErrorState messageKey="authError" />
          ) : (
            <Prs snapshot={snapshot} settings={settings} baseUrl={baseUrl} />
          )}
        </TabsContent>
        <TabsContent value="builds" className="min-h-0 flex-1 overflow-y-auto p-2">
          {authError ? (
            <ErrorState messageKey="authError" />
          ) : (
            <Builds snapshot={snapshot} capabilities={capabilities} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
