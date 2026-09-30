// "Сборки" history stats (US4, FR-111, research R6): the stat card row +
// "по workflow" breakdown table above the runs table in BuildsHistory.tsx.
// Pure presentational component over `src/domain/history.ts`'s `RunStats`.
import type { JSX } from 'react';
import { t } from '../../lib/i18n';
import { duration } from '../../lib/time';
import type { RunStats } from '../../domain/history';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

const EPOCH_ISO = new Date(0).toISOString();

/**
 * Formats a duration given in seconds, reusing `src/lib/time.ts`'s
 * `duration()` (the one place the Russian "ч"/"м"/"с" unit suffixes are
 * allowed, per `tests/unit/i18n-lint.test.ts`) by feeding it two synthetic
 * ISO timestamps `sec` apart.
 */
export function formatDurationSec(sec: number | undefined): string {
  if (sec === undefined) return '—';
  const endIso = new Date(Math.max(0, sec) * 1000).toISOString();
  return duration(EPOCH_ISO, endIso, new Date(endIso));
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export interface HistoryStatsProps {
  stats: RunStats;
  /** Maps a workflow file (`RunStatsByWorkflow.workflow`) to its human name for a given repo-less display. */
  workflowLabel: (file: string) => string;
}

export function HistoryStats({ stats, workflowLabel }: HistoryStatsProps): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('historyStatTotal')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{stats.total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('historyStatFailureRate')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatPercent(stats.failureRate)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('historyStatAvgDuration')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatDurationSec(stats.avgDurationSec)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('historyStatMedianDuration')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatDurationSec(stats.medianDurationSec)}
          </CardContent>
        </Card>
      </div>

      {stats.byWorkflow.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('historyColWorkflow')}</TableHead>
              <TableHead className="text-right">{t('historyByWorkflowTotal')}</TableHead>
              <TableHead className="text-right">{t('historyByWorkflowFailed')}</TableHead>
              <TableHead className="text-right">{t('historyByWorkflowAvg')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.byWorkflow.map((row) => (
              <TableRow key={row.workflow}>
                <TableCell>{workflowLabel(row.workflow)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                <TableCell className="text-right tabular-nums">{row.failed}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDurationSec(row.avgDurationSec)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
