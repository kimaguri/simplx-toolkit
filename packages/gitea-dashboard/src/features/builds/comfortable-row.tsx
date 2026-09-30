// Dashboard-only `renderSecondary` for BuildsGroups' comfortable density
// (T039). Split out of BuildsGroups.tsx so importing that shared component
// never pulls `src/ui/Tags` (RepoTag/BranchTag) into the popup's bundle —
// the popup only ever renders `density="compact"` and never calls this.
// Only the dashboard page (src/entrypoints/dashboard/App.tsx) imports this
// module.
import type { JSX } from 'react';
import type { Run } from '../../domain/types';
import { RepoTag, BranchTag } from '../../ui/Tags';
import { stageTextFor, type UseRunStagesResult } from './use-run-stages';

/** BuildsGroups `renderSecondary` for the dashboard's comfortable density: repo/branch tags + event · actor. */
export function renderComfortableSecondary(run: Run, allFullNames: string[]): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <RepoTag fullName={`${run.repo.owner}/${run.repo.name}`} allFullNames={allFullNames} />
      {run.branch && <BranchTag branch={run.branch} />}
      <span>
        {run.event} · {run.actor}
      </span>
    </div>
  );
}

/**
 * T035 (US6): like `renderComfortableSecondary` above, but appends the run's
 * current build stage (`jobName › stepName · index/total`, or the
 * "недоступен" label) when one is known. Returns a `renderSecondary`-shaped
 * function bound to a `stages` instance (`useRunStages`) so `BuildsGroups`
 * itself never has to import this module or `run-jobs`/`use-run-stages`
 * (rule 18/T039) — `BuildsSection` (src/entrypoints/dashboard/App.tsx) owns
 * the `useRunStages` call and passes the bound renderer down.
 */
export function renderComfortableSecondaryWithStage(
  stages: UseRunStagesResult
): (run: Run, allFullNames: string[]) => JSX.Element {
  return function renderComfortableSecondaryStaged(run, allFullNames) {
    const stage = stageTextFor(run, stages);
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <RepoTag fullName={`${run.repo.owner}/${run.repo.name}`} allFullNames={allFullNames} />
        {run.branch && <BranchTag branch={run.branch} />}
        <span>
          {run.event} · {run.actor}
        </span>
        {stage && (
          <span className="max-w-full truncate" title={stage}>
            · {stage}
          </span>
        )}
      </div>
    );
  };
}
