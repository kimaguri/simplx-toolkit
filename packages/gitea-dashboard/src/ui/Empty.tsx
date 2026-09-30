import type { JSX } from 'react';
import { Button } from '../components/ui/button';
import { t } from '../lib/i18n';

export interface EmptyAction {
  labelKey: string;
  onClick: () => void;
}

export interface EmptyProps {
  messageKey: string;
  subs?: string | string[];
  action?: EmptyAction;
}

/** Empty-state placeholder: a message plus an optional call-to-action button. */
export function Empty({ messageKey, subs, action }: EmptyProps): JSX.Element {
  return (
    <div role="status" className="flex flex-col items-start gap-2 p-2 text-sm text-muted-foreground">
      <p>{t(messageKey, subs)}</p>
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {t(action.labelKey)}
        </Button>
      )}
    </div>
  );
}
