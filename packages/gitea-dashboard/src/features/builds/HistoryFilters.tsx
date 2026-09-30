// "Сборки" history filters row (US4, FR-111): faceted Popover+Command
// filters (repo/workflow/branch/event/итог) with per-option counts, plus the
// "только мои" Switch. A local, builds-only faceted-filter primitive — kept
// separate from src/features/prs/* per the task brief (parallel US3 work
// owns that file).
import { useState } from 'react';
import type { JSX } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { Run, RunState } from '../../domain/types';
import { branchFacetValue, filterRuns } from '../../domain/history';
import type { RunHistoryFilter } from '../../domain/route';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Label } from '../../components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../components/ui/command';
import { cn } from '../../lib/utils';

type Dimension = 'repo' | 'wf' | 'branch' | 'event' | 'result';

const EMPTY_PR_INDEX: ReadonlyMap<string, string | undefined> = new Map();

function repoKey(run: Run): string {
  return `${run.repo.owner}/${run.repo.name}`;
}

type PrIndex = ReadonlyMap<string, string | undefined>;

/**
 * T056: the branch facet uses the PR's target branch (`baseRef`) for a PR
 * check run when it's known (`prIndex`), same as the branch column — so
 * selecting "test" in the facet actually matches "#81 -> test" rows.
 */
function valueOf(run: Run, dimension: Dimension, prIndex: PrIndex): string {
  switch (dimension) {
    case 'repo':
      return repoKey(run);
    case 'wf':
      return run.workflow;
    case 'branch':
      return branchFacetValue(run, prIndex);
    case 'event':
      return run.event;
    case 'result':
      return run.state;
  }
}

/** Unique values for `dimension` across all fetched `runs`, in first-seen order. */
function optionsFor(runs: Run[], dimension: Dimension, prIndex: PrIndex): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const run of runs) {
    const value = valueOf(run, dimension, prIndex);
    if (!seen.has(value)) {
      seen.add(value);
      options.push(value);
    }
  }
  return options;
}

/**
 * Count of runs matching `value` on `dimension`, among runs already narrowed
 * by every *other* active filter facet (mirrors src/domain/pr-filter.ts's
 * `facetCounts` semantics for the PR table, kept local here per the task
 * brief).
 */
function countFor(
  runs: Run[],
  filter: RunHistoryFilter,
  dimension: Dimension,
  value: string,
  prIndex: PrIndex
): number {
  const narrowed = filterRuns(runs, { ...filter, [dimension]: [] }, '', prIndex);
  return narrowed.filter((run) => valueOf(run, dimension, prIndex) === value).length;
}

function selectedSetFor(filter: RunHistoryFilter, dimension: Dimension): readonly string[] {
  switch (dimension) {
    case 'repo':
      return filter.repo;
    case 'wf':
      return filter.wf;
    case 'branch':
      return filter.branch;
    case 'event':
      return filter.event;
    case 'result':
      return filter.result;
  }
}

function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

interface FacetProps {
  dimension: Dimension;
  labelKey: string;
  runs: Run[];
  filter: RunHistoryFilter;
  onChange: (next: RunHistoryFilter) => void;
  formatOption?: (value: string) => string;
  prIndex: PrIndex;
}

function Facet({ dimension, labelKey, runs, filter, onChange, formatOption, prIndex }: FacetProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const options = optionsFor(runs, dimension, prIndex);
  const selected = selectedSetFor(filter, dimension);
  const label = t(labelKey);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          {label}
          {selected.length > 0 && <span className="tabular-nums">({selected.length})</span>}
          <ChevronDown size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={label} />
          <CommandList>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.includes(option);
                const count = countFor(runs, filter, dimension, option, prIndex);
                return (
                  <CommandItem
                    key={option}
                    onSelect={() => {
                      const nextValues = toggleValue(selected, option) as never;
                      onChange({ ...filter, [dimension]: nextValues });
                    }}
                  >
                    <div
                      className={cn(
                        'flex size-4 items-center justify-center rounded-sm border border-primary',
                        isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50'
                      )}
                    >
                      {isSelected && <Check size={12} />}
                    </div>
                    <span className="flex-1">{formatOption ? formatOption(option) : option}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface HistoryFiltersProps {
  runs: Run[];
  filter: RunHistoryFilter;
  onChange: (next: RunHistoryFilter) => void;
  workflowLabel: (file: string) => string;
  /** T056: PR index (buildPrIndex) so the branch facet uses baseRef for PR runs when known. */
  prIndex?: PrIndex;
}

const RESULT_LABEL_KEYS: Record<RunState, string> = {
  waiting: 'statusWaiting',
  blocked: 'statusBlocked',
  running: 'statusRunning',
  success: 'statusSuccess',
  failure: 'statusFailure',
  cancelled: 'statusCancelled',
  skipped: 'statusSkipped',
};

function hasActiveFacets(filter: RunHistoryFilter): boolean {
  return (
    filter.mine ||
    filter.repo.length + filter.wf.length + filter.branch.length + filter.event.length + filter.result.length > 0
  );
}

export function HistoryFilters({
  runs,
  filter,
  onChange,
  workflowLabel,
  prIndex = EMPTY_PR_INDEX,
}: HistoryFiltersProps): JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Facet
        dimension="repo"
        labelKey="historyFacetRepo"
        runs={runs}
        filter={filter}
        onChange={onChange}
        prIndex={prIndex}
      />
      <Facet
        dimension="wf"
        labelKey="historyFacetWorkflow"
        runs={runs}
        filter={filter}
        onChange={onChange}
        formatOption={workflowLabel}
        prIndex={prIndex}
      />
      <Facet
        dimension="branch"
        labelKey="historyFacetBranch"
        runs={runs}
        filter={filter}
        onChange={onChange}
        prIndex={prIndex}
      />
      <Facet
        dimension="event"
        labelKey="historyFacetEvent"
        runs={runs}
        filter={filter}
        onChange={onChange}
        prIndex={prIndex}
      />
      <Facet
        dimension="result"
        labelKey="historyFacetResult"
        runs={runs}
        filter={filter}
        onChange={onChange}
        formatOption={(value) => t(RESULT_LABEL_KEYS[value as RunState] ?? value)}
        prIndex={prIndex}
      />
      {hasActiveFacets(filter) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...filter, repo: [], wf: [], branch: [], event: [], result: [], mine: false })}
        >
          {t('historyClear')}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Switch
          id="history-mine"
          checked={filter.mine}
          onCheckedChange={(checked) => onChange({ ...filter, mine: checked === true })}
          aria-label={t('historyMineLabel')}
        />
        <Label htmlFor="history-mine">{t('historyMineLabel')}</Label>
      </div>
    </div>
  );
}
