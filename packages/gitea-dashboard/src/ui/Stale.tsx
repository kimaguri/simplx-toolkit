import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { t } from '../lib/i18n';

export interface StaleProps {
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: string;
}

function formatHhMm(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * "Data as of HH:MM, no connection" banner shown when the last poll failed.
 * Uses role="status" (not the shadcn Alert default of role="alert") since
 * this is a non-error, informational banner that can appear alongside a
 * real alert (e.g. an auth ErrorState) without stealing its `role="alert"`
 * query match.
 */
export function Stale({ fetchedAt }: StaleProps): JSX.Element {
  return (
    <Alert role="status" className="gap-y-0 py-2">
      <Clock />
      <AlertDescription>{t('staleMessage', formatHhMm(fetchedAt))}</AlertDescription>
    </Alert>
  );
}
