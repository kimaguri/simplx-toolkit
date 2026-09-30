// Options page (US1, FR-001..004, FR-075). "Подключение" section: address +
// token, scope list, save (host-permission request, FR-004/T025) and check
// (delegates diagnosis to the background via `check-connection`, T024).
//
// `Options` renders a header + a list of section Cards so later tasks kept
// appending their own section components without restructuring this file
// (T054 "Опрос и бейдж" / "Уведомления", T055 "Охват").
//
// T078: canonical shadcn/ui layout — every section is a Card with a visible
// "Сохранить" action and sonner toast feedback (the owner's complaint was
// that saving looked like nothing happened).
import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';
import { t } from '../../lib/i18n';
import {
  getInstances,
  getToken,
  instanceId,
  normalizeBaseUrl,
  removeToken,
  setInstances,
  setToken,
} from '../../lib/storage';
import type { CheckConnectionMessage, CheckConnectionResponse } from '../../background/messages';
import type { Capabilities, ConnectionReport, Instance } from '../../domain/types';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Toaster } from '../../components/ui/sonner';
import { PollingSection } from './PollingSection';
import { NotificationsSection } from './NotificationsSection';
import { ScopeSection } from './Scope';

const DEFAULT_BASE_URL = 'https://git.sadmin.app';

const REQUIRED_SCOPES: ReadonlyArray<{ scope: string; key: string }> = [
  { scope: 'read:repository', key: 'scopeReadRepository' },
  { scope: 'read:issue', key: 'scopeReadIssue' },
  { scope: 'read:user', key: 'scopeReadUser' },
  { scope: 'read:organization', key: 'scopeReadOrganization' },
  { scope: 'read:notification', key: 'scopeReadNotification' },
];

function actionsLabelKey(actions: Capabilities['actions']): string {
  return `optionsActionsMode_${actions}`;
}

function tokenApplicationsUrl(baseUrl: string): string {
  try {
    return `${normalizeBaseUrl(baseUrl)}/user/settings/applications`;
  } catch {
    return `${baseUrl}/user/settings/applications`;
  }
}

/** "Подключение" section (FR-001..004): address, token, scopes, save/check. */
export function ConnectionSection(): JSX.Element {
  const urlId = useId();
  const tokenId = useId();

  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [replacingToken, setReplacingToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<ConnectionReport | undefined>(undefined);

  // Load the currently active instance (if any) once on mount — never the
  // token itself, only whether one is stored.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { instances, activeInstanceId } = await getInstances();
      if (cancelled || !activeInstanceId) return;
      const instance = instances.find((entry) => entry.id === activeInstanceId);
      if (!instance) return;
      setBaseUrl(instance.baseUrl);
      setActiveId(activeInstanceId);
      const existingToken = await getToken(activeInstanceId);
      if (!cancelled) setTokenSaved(Boolean(existingToken));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Shared with the manual "Проверить подключение" button (T024) and the
   * post-save auto-check (T025 follow-up): runs `check-connection` and
   * renders whatever report comes back.
   *
   * `persist` (M5 review fix): the Save flow's auto-check passes `true` (the
   * URL was just saved, it's fine to become/stay the active instance); the
   * manual Check button passes `false` — the user may be probing an
   * unsaved/different URL, and switching `activeInstanceId` to an instance
   * without a token would silently stop the poller. */
  async function runCheck(
    urlToCheck: string,
    tokenToCheck: string,
    persist: boolean
  ): Promise<void> {
    try {
      const message: CheckConnectionMessage = {
        type: 'check-connection',
        baseUrl: urlToCheck,
        token: tokenToCheck,
        persist,
      };
      const response = (await browser.runtime.sendMessage(message)) as CheckConnectionResponse;
      setReport(response);
    } catch {
      setReport(undefined);
    }
  }

  async function handleSave(): Promise<void> {
    setReport(undefined);

    let normalized: string;
    try {
      normalized = normalizeBaseUrl(baseUrl);
    } catch {
      toast.error(t('optionsInvalidUrl'));
      return;
    }

    const origin = new URL(normalized).origin;

    // FR-004 / research R11: request exactly this origin. This call happens
    // synchronously as the first await in the click handler — no await runs
    // before it — so the browser still treats it as a user gesture.
    setSaving(true);
    try {
      const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        toast.error(t('optionsPermissionDenied'));
        return;
      }

      const { instances, activeInstanceId: previousId } = await getInstances();
      const previousInstance = instances.find((entry) => entry.id === previousId);
      const nextId = await instanceId(normalized);

      const trimmedToken = tokenInput.trim();
      if (trimmedToken) {
        await setToken(nextId, trimmedToken);
        setTokenInput('');
        setTokenSaved(true);
        setReplacingToken(false);
      }

      const existing = instances.find((entry) => entry.id === nextId);
      const nextInstance: Instance = existing
        ? { ...existing, baseUrl: normalized }
        : {
            id: nextId,
            baseUrl: normalized,
            capabilities: { actions: 'unsupported', notifications: false, orgs: [], missingScopes: [] },
          };

      await setInstances({
        instances: [...instances.filter((entry) => entry.id !== nextId), nextInstance],
        activeInstanceId: nextId,
      });

      if (previousInstance && previousInstance.id !== nextId) {
        const previousOrigin = new URL(previousInstance.baseUrl).origin;
        if (previousOrigin !== origin) {
          await browser.permissions.remove({ origins: [`${previousOrigin}/*`] });
          // The old instance id's token is now orphaned — remove it rather
          // than leaving a stale PAT sitting in storage.local (FR-003).
          await removeToken(previousInstance.id);
        }
      }

      setActiveId(nextId);

      // Placeholder capabilities ({actions:'unsupported', orgs:[]}) would
      // otherwise sit in storage until the user manually clicks "Проверить
      // подключение" — the Builds tab would say "unsupported" and the
      // poller would think there are no orgs. Run the same check the button
      // runs, right away, with the token that's now actually saved, and
      // only notify the poller (`settings-changed`) once real capabilities
      // have been persisted by `checkConnection` in the background.
      const tokenForCheck = trimmedToken || (await getToken(nextId)) || '';
      await runCheck(normalized, tokenForCheck, true);

      toast.success(t('optionsSaveSuccess'));
      browser.runtime.sendMessage({ type: 'settings-changed' }).catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck(): Promise<void> {
    setChecking(true);
    setReport(undefined);
    try {
      const trimmedToken = tokenInput.trim();
      const tokenToCheck = trimmedToken || (activeId ? await getToken(activeId) : undefined) || '';
      await runCheck(baseUrl, tokenToCheck, false);
    } finally {
      setChecking(false);
    }
  }

  const showTokenInput = !tokenSaved || replacingToken;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('optionsSectionConnection')}</CardTitle>
        <CardDescription>{t('optionsSectionConnectionDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor={urlId}>{t('optionsUrlLabel')}</Label>
          <Input
            id={urlId}
            type="text"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>

        {showTokenInput ? (
          <div className="grid gap-2">
            <Label htmlFor={tokenId}>{t('optionsTokenLabel')}</Label>
            <Input
              id={tokenId}
              type="password"
              value={tokenInput}
              placeholder={t('optionsTokenPlaceholder')}
              onChange={(event) => setTokenInput(event.target.value)}
            />
          </div>
        ) : (
          <div className="grid gap-2">
            <Label>{t('optionsTokenLabel')}</Label>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('optionsTokenSaved')}</span>
              <Button type="button" variant="link" size="sm" onClick={() => setReplacingToken(true)}>
                {t('optionsTokenReplace')}
              </Button>
            </div>
          </div>
        )}

        <Button
          type="button"
          variant="link"
          className="h-auto w-fit justify-start px-0 text-sm"
          asChild
        >
          <a href={tokenApplicationsUrl(baseUrl)} target="_blank" rel="noreferrer">
            <ExternalLink />
            {t('optionsCreateTokenLink')}
          </a>
        </Button>

        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">{t('optionsScopesTitle')}</p>
          <div className="flex flex-wrap gap-2">
            {REQUIRED_SCOPES.map(({ scope, key }) => (
              <Badge key={scope} variant="outline" className="font-normal text-muted-foreground">
                {t(key)}
              </Badge>
            ))}
          </div>
        </div>

        {report && (
          <Alert variant={report.ok ? 'default' : 'destructive'}>
            {report.ok ? <CheckCircle2 /> : <AlertCircle />}
            <AlertTitle>{t(report.messageKey)}</AlertTitle>
            <AlertDescription>
              {report.login && <p>{t('optionsLoginLabel', report.login)}</p>}
              {report.version && <p>{t('optionsVersionValueLabel', report.version)}</p>}
              <p>{t(actionsLabelKey(report.actions))}</p>
              {report.missingScopes.length > 0 && (
                <p>{t('optionsMissingScopesLabel', report.missingScopes.join(', '))}</p>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button type="button" onClick={() => void handleSave()} disabled={saving}>
          {t('optionsSaveButton')}
        </Button>
        <Button type="button" variant="outline" onClick={() => void handleCheck()} disabled={checking}>
          {t('optionsCheckButton')}
        </Button>
      </CardFooter>
    </Card>
  );
}

const SECTIONS: ReadonlyArray<() => JSX.Element> = [
  ConnectionSection,
  PollingSection,
  NotificationsSection,
  ScopeSection,
];

/** Options page shell — header, sonner Toaster (mounted once), sections. */
export function Options(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">{t('optionsTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('optionsExtensionVersion', browser.runtime.getManifest().version)}
          </p>
        </header>

        {SECTIONS.map((Section, index) => (
          <Section key={index} />
        ))}
      </div>
    </div>
  );
}
