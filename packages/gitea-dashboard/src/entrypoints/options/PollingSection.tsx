// Options page (US6, T054): "Опрос и бейдж" section.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-034/040/050,
// data-model.md "Settings" (pollIntervalSec/badgeMode/recentWindowHours/
// redBadgeWindowMin/showOtherPrs — defaults + validation ranges).
//
// Values are staged locally and only written to storage (`setSettings`) once
// they all validate; an invalid field shows an inline error and blocks the
// whole save (nothing is persisted). T078: shadcn Card/Select/Switch, sonner
// toast confirms the save actually happened.
import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { getSettings, setSettings } from '../../lib/storage';
import type { BadgeMode, Settings } from '../../domain/types';
import type { SettingsChangedMessage } from '../../background/messages';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';

const BADGE_MODES: readonly BadgeMode[] = ['reviews', 'builds', 'sum'];

export function PollingSection(): JSX.Element {
  const pollIntervalId = useId();
  const badgeModeId = useId();
  const recentWindowId = useId();
  const redBadgeWindowId = useId();
  const showOtherPrsId = useId();

  const [loaded, setLoaded] = useState(false);
  const [pollIntervalSec, setPollIntervalSec] = useState('60');
  const [badgeMode, setBadgeMode] = useState<BadgeMode>('reviews');
  const [recentWindowHours, setRecentWindowHours] = useState('24');
  const [redBadgeWindowMin, setRedBadgeWindowMin] = useState('30');
  const [showOtherPrs, setShowOtherPrs] = useState(true);

  const [intervalError, setIntervalError] = useState(false);
  const [recentWindowError, setRecentWindowError] = useState(false);
  const [redBadgeWindowError, setRedBadgeWindowError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await getSettings();
      if (cancelled) return;
      setPollIntervalSec(String(settings.pollIntervalSec));
      setBadgeMode(settings.badgeMode);
      setRecentWindowHours(String(settings.recentWindowHours));
      setRedBadgeWindowMin(String(settings.redBadgeWindowMin));
      setShowOtherPrs(settings.showOtherPrs);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    const interval = Number(pollIntervalSec);
    const recentWindow = Number(recentWindowHours);
    const redWindow = Number(redBadgeWindowMin);

    const intervalInvalid = !Number.isFinite(interval) || interval < 30;
    const recentWindowInvalid = !Number.isFinite(recentWindow) || recentWindow < 1 || recentWindow > 168;
    const redWindowInvalid = !Number.isFinite(redWindow) || redWindow < 5 || redWindow > 1440;

    setIntervalError(intervalInvalid);
    setRecentWindowError(recentWindowInvalid);
    setRedBadgeWindowError(redWindowInvalid);

    if (intervalInvalid || recentWindowInvalid || redWindowInvalid) {
      toast.error(t('optionsPollIntervalError'));
      return;
    }

    const current = await getSettings();
    const next: Settings = {
      ...current,
      pollIntervalSec: interval,
      badgeMode,
      recentWindowHours: recentWindow,
      redBadgeWindowMin: redWindow,
      showOtherPrs,
    };
    await setSettings(next);
    toast.success(t('optionsSaveSuccess'));

    const message: SettingsChangedMessage = { type: 'settings-changed' };
    browser.runtime.sendMessage(message).catch(() => {});
  }

  if (!loaded) {
    return <Card />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('optionsSectionPolling')}</CardTitle>
        <CardDescription>{t('optionsSectionPollingDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor={pollIntervalId}>{t('optionsPollIntervalLabel')}</Label>
          <Input
            id={pollIntervalId}
            type="number"
            value={pollIntervalSec}
            onChange={(event) => setPollIntervalSec(event.target.value)}
          />
          {intervalError && (
            <p role="alert" className="text-sm text-destructive">
              {t('optionsPollIntervalError')}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={badgeModeId}>{t('optionsBadgeModeLabel')}</Label>
          <Select value={badgeMode} onValueChange={(value) => setBadgeMode(value as BadgeMode)}>
            <SelectTrigger id={badgeModeId} className="w-full">
              <SelectValue>{t(`optionsBadgeMode_${badgeMode}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BADGE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`optionsBadgeMode_${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={recentWindowId}>{t('optionsRecentWindowLabel')}</Label>
          <Input
            id={recentWindowId}
            type="number"
            value={recentWindowHours}
            onChange={(event) => setRecentWindowHours(event.target.value)}
          />
          {recentWindowError && (
            <p role="alert" className="text-sm text-destructive">
              {t('optionsRecentWindowError')}
            </p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={redBadgeWindowId}>{t('optionsRedBadgeWindowLabel')}</Label>
          <Input
            id={redBadgeWindowId}
            type="number"
            value={redBadgeWindowMin}
            onChange={(event) => setRedBadgeWindowMin(event.target.value)}
          />
          {redBadgeWindowError && (
            <p role="alert" className="text-sm text-destructive">
              {t('optionsRedBadgeWindowError')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor={showOtherPrsId}>{t('optionsShowOtherPrsLabel')}</Label>
          <Switch
            id={showOtherPrsId}
            checked={showOtherPrs}
            onCheckedChange={(checked) => setShowOtherPrs(checked === true)}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => void handleSave()}>
          {t('optionsSaveButton')}
        </Button>
      </CardFooter>
    </Card>
  );
}
