// T055: collapsed «Диагностика» panel under the history table — the
// loader's own per-source numbers for the last call (history-loader.ts
// `LoadHistoryResult.diagnostics`), so the owner can send a screenshot of
// what the live server gave. Dashboard-only: never imported by popup code.
import { useState } from 'react';
import type { JSX } from 'react';
import { ChevronDown } from 'lucide-react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import type { LoadHistoryResult } from './history-loader';
import { Button } from '../../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

export interface HistoryDiagnosticsProps {
  result: LoadHistoryResult;
}

function yesNo(value: boolean): string {
  return t(value ? 'historyDiagYes' : 'historyDiagNo');
}

export function HistoryDiagnostics({ result }: HistoryDiagnosticsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const diag = result.diagnostics;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="shrink-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="gap-2 px-2">
          <ChevronDown size={14} className={cn('transition-transform', !open && '-rotate-90')} />
          {t('historyDiagToggle')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-56 overflow-auto">
        <div data-testid="history-diagnostics" className="space-y-2 text-xs">
          <p data-testid="history-diag-summary" className="text-muted-foreground tabular-nums">
            {t('historyDiagSummary', [
              result.coveredUntil,
              yesNo(result.hasMore),
              String(result.requests),
              diag?.periodStart ?? '—',
              String(diag?.limit ?? '—'),
            ])}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('historyDiagSource')}</TableHead>
                <TableHead>{t('historyDiagRequests')}</TableHead>
                <TableHead>{t('historyDiagPages')}</TableHead>
                <TableHead>{t('historyDiagRuns')}</TableHead>
                <TableHead>{t('historyDiagTotal')}</TableHead>
                <TableHead>{t('historyDiagOldest')}</TableHead>
                <TableHead>{t('historyDiagExhausted')}</TableHead>
                <TableHead>{t('historyDiagError')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(diag?.sources ?? []).map((s) => (
                <TableRow key={s.key} data-testid={`history-diag-${s.key}`}>
                  <TableCell>{s.key}</TableCell>
                  <TableCell className="tabular-nums">{s.requests}</TableCell>
                  <TableCell className="tabular-nums">{s.pages}</TableCell>
                  <TableCell className="tabular-nums">{s.cachedRuns}</TableCell>
                  <TableCell className="tabular-nums">{s.totalCount ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{s.oldestStartedAt ?? '—'}</TableCell>
                  <TableCell>{yesNo(s.exhausted)}</TableCell>
                  <TableCell>{s.error ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
