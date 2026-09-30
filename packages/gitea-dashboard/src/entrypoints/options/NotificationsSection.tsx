// Options page (US6, T054): "Уведомления" section.
// Contract: docs/specs/001-gitea-dashboard/spec.md FR-060, data-model.md
// "Settings.notify" (buildFailed scope + booleans). T078: shadcn Card/
// Select/Switch, sonner toast confirms the save actually happened.
import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { getSettings, setSettings } from '../../lib/storage';
import type { NotifyBuildFailed, Settings } from '../../domain/types';
import type { SettingsChangedMessage } from '../../background/messages';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';

const BUILD_FAILED_SCOPES: readonly NotifyBuildFailed[] = [
  'off',
  'myPrs',
  'myPushes',
  'mine',
  'all',
];

export function NotificationsSection(): JSX.Element {
  const buildFailedId = useId();
  const buildSucceededId = useId();
  const reviewRequestedId = useId();
  const commentsId = useId();

  const [loaded, setLoaded] = useState(false);
  const [buildFailed, setBuildFailed] = useState<NotifyBuildFailed>('mine');
  const [buildSucceededMyPr, setBuildSucceededMyPr] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(true);
  const [comments, setComments] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = await getSettings();
      if (cancelled) return;
      setBuildFailed(settings.notify.buildFailed);
      setBuildSucceededMyPr(settings.notify.buildSucceededMyPr);
      setReviewRequested(settings.notify.reviewRequested);
      setComments(settings.notify.comments);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    const current = await getSettings();
    const next: Settings = {
      ...current,
      notify: {
        buildFailed,
        buildSucceededMyPr,
        reviewRequested,
        comments,
      },
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
        <CardTitle>{t('optionsSectionNotifications')}</CardTitle>
        <CardDescription>{t('optionsSectionNotificationsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor={buildFailedId}>{t('optionsNotifyBuildFailedLabel')}</Label>
          <Select
            value={buildFailed}
            onValueChange={(value) => setBuildFailed(value as NotifyBuildFailed)}
          >
            <SelectTrigger id={buildFailedId} className="w-full">
              <SelectValue>{t(`optionsNotifyBuildFailed_${buildFailed}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BUILD_FAILED_SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {t(`optionsNotifyBuildFailed_${scope}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor={buildSucceededId}>{t('optionsNotifyBuildSucceededLabel')}</Label>
          <Switch
            id={buildSucceededId}
            checked={buildSucceededMyPr}
            onCheckedChange={(checked) => setBuildSucceededMyPr(checked === true)}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor={reviewRequestedId}>{t('optionsNotifyReviewRequestedLabel')}</Label>
          <Switch
            id={reviewRequestedId}
            checked={reviewRequested}
            onCheckedChange={(checked) => setReviewRequested(checked === true)}
          />
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor={commentsId}>{t('optionsNotifyCommentsLabel')}</Label>
          <Switch
            id={commentsId}
            checked={comments}
            onCheckedChange={(checked) => setComments(checked === true)}
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
