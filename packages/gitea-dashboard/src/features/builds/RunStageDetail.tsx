// US6 scenario 2: the expanded-row detail — every job with its status and
// duration, and every job's steps with their own status/duration, the
// current step highlighted. Pure presentational component over `run-jobs.ts`
// (`StageInfo`, `currentStage`). Rendered by `BuildsHistory.tsx`'s
// Collapsible detail row (tasks.md T035).
import type { JSX } from 'react';
import { t } from '../../lib/i18n';
import { duration } from '../../lib/time';
import { cn } from '../../lib/utils';
import { StatusIcon, type StatusIconState } from '../../ui/StatusIcon';
import { currentStage, type StageInfo } from './run-jobs';

/**
 * Maps a Gitea Actions job/step `status` (+ `conclusion` once `completed`)
 * to a `StatusIcon` state. Job/step statuses ("waiting", "queued",
 * "in_progress", "completed") are a different vocabulary from `RunState`
 * ("waiting", "blocked", "running", ...) — this is the one place that
 * bridges them.
 */
function iconStateOf(status: string, conclusion?: string): StatusIconState {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'success';
      case 'failure':
        return 'failure';
      case 'cancelled':
        return 'cancelled';
      case 'skipped':
        return 'skipped';
      default:
        return 'success';
    }
  }
  if (status === 'in_progress' || status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'queued' || status === 'waiting') return 'waiting';
  return 'pending';
}

export interface RunStageDetailProps {
  /** `undefined` while loading (not yet fetched). */
  stage: StageInfo | undefined;
}

export function RunStageDetail({ stage }: RunStageDetailProps): JSX.Element {
  if (!stage) {
    return <p className="p-3 text-sm text-muted-foreground">{t('buildsStageLoading')}</p>;
  }
  if (stage.unavailable) {
    return <p className="p-3 text-sm text-muted-foreground">{t('buildsStageUnavailable')}</p>;
  }

  const now = new Date();
  const current = currentStage(stage.jobs);

  return (
    <div className="space-y-3 p-3">
      {stage.jobs.map((job) => (
        <div key={job.id}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <StatusIcon state={iconStateOf(job.status, job.conclusion)} />
            <span className="flex-1 truncate">{job.name}</span>
            <span className="shrink-0 tabular-nums text-xs font-normal text-muted-foreground">
              {duration(job.started_at, job.completed_at, now)}
            </span>
          </div>
          <ul className="ml-5 mt-1 space-y-0.5">
            {job.steps.map((step) => {
              const isCurrent =
                !!current && current.jobName === job.name && current.index === step.number;
              return (
                <li
                  key={step.number}
                  className={cn(
                    'flex items-center gap-2 rounded px-1.5 py-0.5 text-sm',
                    isCurrent && 'bg-accent/50 font-medium'
                  )}
                >
                  <StatusIcon state={iconStateOf(step.status, step.conclusion)} size={12} />
                  <span className="w-4 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                    {step.number}
                  </span>
                  <span className="flex-1 truncate">{step.name}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {duration(step.started_at, step.completed_at, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
