// Options page (US6, T055): "Охват" section.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-034/035, data-model.md
// "Settings.scope" (excludeOrgs/excludeRepos/includeRepos) and "repoModeLimit".
// T078: shadcn Card/Checkbox/Badge, sonner toast confirms the save actually
// happened.
import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { getInstances, getPins, getSettings, setPins, setSettings } from '../../lib/storage';
import type { Instance, RepoRef, Settings } from '../../domain/types';
import type { SettingsChangedMessage } from '../../background/messages';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`.toLowerCase();
}

function notifySettingsChanged(): void {
  const message: SettingsChangedMessage = { type: 'settings-changed' };
  browser.runtime.sendMessage(message).catch(() => {});
}

export function ScopeSection(): JSX.Element {
  const excludeRepoInputId = useId();
  const includeRepoInputId = useId();

  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [actionsMode, setActionsMode] = useState<Instance['capabilities']['actions']>('unsupported');
  const [repoModeLimit, setRepoModeLimit] = useState(30);

  const [excludeOrgs, setExcludeOrgs] = useState<string[]>([]);
  const [excludeRepos, setExcludeRepos] = useState<string[]>([]);
  const [includeRepos, setIncludeRepos] = useState<string[]>([]);
  const [pins, setPinsState] = useState<RepoRef[]>([]);

  const [excludeRepoInput, setExcludeRepoInput] = useState('');
  const [includeRepoInput, setIncludeRepoInput] = useState('');
  const [excludeRepoError, setExcludeRepoError] = useState(false);
  const [includeRepoError, setIncludeRepoError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [settings, { instances, activeInstanceId }] = await Promise.all([
        getSettings(),
        getInstances(),
      ]);
      if (cancelled) return;

      const instance = instances.find((entry) => entry.id === activeInstanceId);
      setActiveId(activeInstanceId);
      setOrgs(instance?.capabilities.orgs ?? []);
      setActionsMode(instance?.capabilities.actions ?? 'unsupported');
      setRepoModeLimit(settings.repoModeLimit);
      setExcludeOrgs(settings.scope.excludeOrgs);
      setExcludeRepos(settings.scope.excludeRepos);
      setIncludeRepos(settings.scope.includeRepos);

      if (activeInstanceId) {
        const storedPins = await getPins(activeInstanceId);
        if (!cancelled) setPinsState(storedPins);
      }

      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleOrg(org: string, included: boolean): void {
    setExcludeOrgs((current) =>
      included ? current.filter((entry) => entry !== org) : [...current, org]
    );
  }

  function addExcludeRepo(): void {
    const value = excludeRepoInput.trim();
    if (!REPO_PATTERN.test(value)) {
      setExcludeRepoError(true);
      return;
    }
    setExcludeRepoError(false);
    setExcludeRepos((current) => (current.includes(value) ? current : [...current, value]));
    setExcludeRepoInput('');
  }

  function removeExcludeRepo(value: string): void {
    setExcludeRepos((current) => current.filter((entry) => entry !== value));
  }

  function addIncludeRepo(): void {
    const value = includeRepoInput.trim();
    if (!REPO_PATTERN.test(value)) {
      setIncludeRepoError(true);
      return;
    }
    setIncludeRepoError(false);
    setIncludeRepos((current) => (current.includes(value) ? current : [...current, value]));
    setIncludeRepoInput('');
  }

  function removeIncludeRepo(value: string): void {
    setIncludeRepos((current) => current.filter((entry) => entry !== value));
  }

  async function unpin(ref: RepoRef): Promise<void> {
    if (!activeId) return;
    const next = pins.filter((pin) => repoKey(pin) !== repoKey(ref));
    setPinsState(next);
    await setPins(activeId, next);
    notifySettingsChanged();
  }

  async function handleSave(): Promise<void> {
    if (excludeRepoError || includeRepoError) {
      toast.error(t('optionsScopeInvalidRepo'));
      return;
    }
    const current = await getSettings();
    const next: Settings = {
      ...current,
      scope: {
        excludeOrgs,
        excludeRepos,
        includeRepos,
      },
    };
    await setSettings(next);
    toast.success(t('optionsSaveSuccess'));
    notifySettingsChanged();
  }

  if (!loaded) {
    return <Card />;
  }

  const candidateCount = new Set([
    ...pins.map(repoKey),
    ...includeRepos
      .filter((repo) => !excludeRepos.includes(repo))
      .map((repo) => repo.toLowerCase()),
  ]).size;
  const overRepoModeLimit = actionsMode === 'repo' && candidateCount > repoModeLimit;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('optionsSectionScope')}</CardTitle>
        <CardDescription>{t('optionsSectionScopeDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('optionsScopeOrgsTitle')}</p>
          {orgs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('optionsScopeNoOrgs')}</p>
          ) : (
            <div className="grid gap-2">
              {orgs.map((org) => {
                const orgId = `scope-org-${org}`;
                return (
                  <div key={org} className="flex items-center gap-2">
                    <Checkbox
                      id={orgId}
                      checked={!excludeOrgs.includes(org)}
                      onCheckedChange={(checked) => toggleOrg(org, checked === true)}
                    />
                    <Label htmlFor={orgId} className="font-normal">
                      {org}
                    </Label>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('optionsScopeExcludeReposTitle')}</p>
          <div className="flex flex-wrap gap-2">
            {excludeRepos.map((repo) => (
              <Badge key={repo} variant="secondary" className="gap-1">
                {repo}
                <button
                  type="button"
                  aria-label={t('optionsScopeRemoveButton')}
                  onClick={() => removeExcludeRepo(repo)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-2">
              <Label htmlFor={excludeRepoInputId} className="sr-only">
                {t('optionsScopeExcludeReposTitle')}
              </Label>
              <Input
                id={excludeRepoInputId}
                type="text"
                placeholder={t('optionsScopeAddRepoPlaceholder')}
                value={excludeRepoInput}
                onChange={(event) => setExcludeRepoInput(event.target.value)}
              />
            </div>
            <Button type="button" variant="outline" onClick={addExcludeRepo}>
              {t('optionsScopeAddButton_exclude')}
            </Button>
          </div>
          {excludeRepoError && (
            <p role="alert" className="text-sm text-destructive">
              {t('optionsScopeInvalidRepo')}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('optionsScopeIncludeReposTitle')}</p>
          <div className="flex flex-wrap gap-2">
            {includeRepos.map((repo) => (
              <Badge key={repo} variant="secondary" className="gap-1">
                {repo}
                <button
                  type="button"
                  aria-label={t('optionsScopeRemoveButton')}
                  onClick={() => removeIncludeRepo(repo)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-2">
              <Label htmlFor={includeRepoInputId} className="sr-only">
                {t('optionsScopeIncludeReposTitle')}
              </Label>
              <Input
                id={includeRepoInputId}
                type="text"
                placeholder={t('optionsScopeAddRepoPlaceholder')}
                value={includeRepoInput}
                onChange={(event) => setIncludeRepoInput(event.target.value)}
              />
            </div>
            <Button type="button" variant="outline" onClick={addIncludeRepo}>
              {t('optionsScopeAddButton_include')}
            </Button>
          </div>
          {includeRepoError && (
            <p role="alert" className="text-sm text-destructive">
              {t('optionsScopeInvalidRepo')}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('optionsScopePinnedReposTitle')}</p>
          {pins.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('optionsScopeNoPins')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pins.map((pin) => (
                <Badge key={repoKey(pin)} variant="secondary" className="gap-1">
                  {pin.owner}/{pin.name}
                  <button
                    type="button"
                    aria-label={t('optionsScopeUnpinButton')}
                    onClick={() => void unpin(pin)}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {actionsMode === 'repo' && (
          <p className="text-sm text-muted-foreground">
            {t('optionsScopeRepoModeCounter', [String(candidateCount), String(repoModeLimit)])}
            {overRepoModeLimit && (
              <span role="alert" className="ml-2 text-destructive">
                {t('optionsScopeRepoModeWarning')}
              </span>
            )}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => void handleSave()}>
          {t('optionsSaveButton')}
        </Button>
      </CardFooter>
    </Card>
  );
}
