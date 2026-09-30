// Toolbar for the PR "table" view (US3, spec.md scenarios 2/3/5/6):
// search box (with a global `/` shortcut), faceted repo/author/ci
// filters (shadcn "Tasks" pattern: Popover + Command, per-option counts
// from src/domain/pr-filter.ts's facetCounts), draft all/only/exclude,
// conflict-only toggle, "N из M" and "Сбросить" (only while a filter is
// active). Pure presentational — all state lives in PrsTable.tsx.
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { PlusCircle } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { PrFacetCounts } from '../../domain/pr-filter';
import type { PrTableFilter } from '../../domain/route';
import type { PullRequest } from '../../domain/types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Separator } from '../../components/ui/separator';

function repoKey(pr: PullRequest): string {
  return `${pr.repo.owner}/${pr.repo.name}`;
}

const CI_LABEL_KEYS: Record<string, string> = {
  success: 'statusSuccess',
  failure: 'statusFailure',
  error: 'statusError',
  pending: 'statusPending',
  warning: 'statusWarning',
  skipped: 'statusSkipped',
  none: 'statusNone',
};

type DraftFilterValue = 'all' | 'only' | 'exclude';

const DRAFT_OPTIONS: readonly { value: DraftFilterValue; labelKey: string }[] = [
  { value: 'all', labelKey: 'prsDraftFilterAll' },
  { value: 'only', labelKey: 'prsDraftFilterOnly' },
  { value: 'exclude', labelKey: 'prsDraftFilterExclude' },
];

interface FacetOption {
  value: string;
  label: string;
}

interface FacetFilterProps {
  titleKey: string;
  options: readonly FacetOption[];
  selected: readonly string[];
  counts: Map<string, number>;
  onToggle: (value: string) => void;
}

/** shadcn "Tasks" example's faceted filter: Popover + Command, per-option counts. */
function FacetFilter({ titleKey, options, selected, counts, onToggle }: FacetFilterProps): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircle size={14} />
          {t(titleKey)}
          {selected.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Badge variant="secondary">{selected.length}</Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={t('prsFilterSearchPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('prsFilterNoResults')}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.includes(option.value);
                const count = counts.get(option.value) ?? 0;
                return (
                  <CommandItem key={option.value} onSelect={() => onToggle(option.value)}>
                    <Checkbox checked={isSelected} className="mr-2" />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{count}</span>
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

export interface PrsFiltersProps {
  /** All PRs in the section (unfiltered) — source of facet option lists. */
  prs: readonly PullRequest[];
  filter: PrTableFilter;
  counts: PrFacetCounts;
  onFilterChange: (next: PrTableFilter, opts?: { replace?: boolean }) => void;
  onReset: () => void;
  hasActiveFilter: boolean;
  shownCount: number;
  totalCount: number;
}

export function PrsFilters({
  prs,
  filter,
  counts,
  onFilterChange,
  onReset,
  hasActiveFilter,
  shownCount,
  totalCount,
}: PrsFiltersProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);

  // Global `/` focuses the search box, unless a form field already has
  // focus (typing "/" in the search box itself must not re-trigger this).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== '/') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const repoOptions: FacetOption[] = Array.from(new Set(prs.map(repoKey)))
    .sort()
    .map((value) => ({ value, label: value }));
  const authorOptions: FacetOption[] = Array.from(new Set(prs.map((pr) => pr.author)))
    .sort()
    .map((value) => ({ value, label: value }));
  const ciOptions: FacetOption[] = Array.from(new Set(prs.map((pr) => pr.ci.state)))
    .sort()
    .map((value) => ({ value, label: t(CI_LABEL_KEYS[value] ?? value) }));

  function toggleFacet(facet: 'repo' | 'author' | 'ci', value: string): void {
    const current = filter[facet] as string[];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    onFilterChange({ ...filter, [facet]: next } as PrTableFilter);
  }

  const draftValue: DraftFilterValue = filter.draft ?? 'all';

  function setDraft(value: DraftFilterValue): void {
    onFilterChange({ ...filter, draft: value === 'all' ? undefined : value });
  }

  function toggleConflict(): void {
    onFilterChange({ ...filter, conflict: filter.conflict === 'only' ? undefined : 'only' });
  }

  const draftLabelKey = DRAFT_OPTIONS.find((option) => option.value === draftValue)?.labelKey ?? 'prsDraftFilterAll';

  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
      <Input
        ref={searchRef}
        value={filter.q}
        onChange={(event) => onFilterChange({ ...filter, q: event.currentTarget.value }, { replace: true })}
        placeholder={t('prsFilterSearchPlaceholder')}
        aria-label={t('prsFilterSearchPlaceholder')}
        className="h-8 w-32"
      />
      <FacetFilter
        titleKey="prsFacetRepo"
        options={repoOptions}
        selected={filter.repo}
        counts={counts.repo}
        onToggle={(value) => toggleFacet('repo', value)}
      />
      <FacetFilter
        titleKey="prsFacetAuthor"
        options={authorOptions}
        selected={filter.author}
        counts={counts.author}
        onToggle={(value) => toggleFacet('author', value)}
      />
      <FacetFilter
        titleKey="prsFacetCi"
        options={ciOptions}
        selected={filter.ci}
        counts={counts.ci}
        onToggle={(value) => toggleFacet('ci', value)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-8">
            {t('prsDraftFilterLabel')}: {t(draftLabelKey)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {DRAFT_OPTIONS.map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => setDraft(option.value)}>
              {t(option.labelKey)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant={filter.conflict === 'only' ? 'secondary' : 'outline'}
        size="sm"
        className="h-8"
        onClick={toggleConflict}
      >
        {t('prsConflictFilterLabel')}
      </Button>
      {hasActiveFilter && (
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={onReset}>
          {t('prsFiltersReset')}
        </Button>
      )}
      <span className="ml-auto whitespace-nowrap text-sm text-muted-foreground">
        {t('prsFiltersCount', [String(shownCount), String(totalCount)])}
      </span>
    </div>
  );
}
