import type { JSX } from 'react';
import { AlertCircle } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { t } from '../lib/i18n';

export interface ErrorStateProps {
  messageKey: string;
  subs?: string | string[];
}

/** Error placeholder: a message plus a button that opens the options page. */
export function ErrorState({ messageKey, subs }: ErrorStateProps): JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{t(messageKey, subs)}</AlertTitle>
      <AlertDescription>
        <Button variant="outline" size="sm" onClick={() => browser.runtime.openOptionsPage()}>
          {t('errorStateOpenOptions')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
