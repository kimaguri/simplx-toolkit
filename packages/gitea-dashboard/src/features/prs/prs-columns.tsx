// Column definitions for the PR "table" view (US3, spec.md scenario 1),
// canonical shadcn data-table pattern on top of TanStack Table v9
// (`useTable`/`tableFeatures`/`createColumnHelper` — v9's API, see
// node_modules/@tanstack/react-table/skills/getting-started/SKILL.md).
// No sorting/filtering feature is registered here: PrsTable.tsx already
// filters/sorts `data` via src/domain/pr-filter.ts before it reaches the
// table, so `features` only needs the (always-on) core row model.
import type { JSX } from 'react';
import {
  createColumnHelper,
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
} from '@tanstack/react-table';
import { t } from '../../lib/i18n';
import { relative } from '../../lib/time';
import type { PullRequest } from '../../domain/types';
import { Badge } from '../../components/ui/badge';
import { StatusIcon } from '../../ui/StatusIcon';
import { NumberTag, RepoTag } from '../../ui/Tags';

// T045: pagination is the only registered feature (sorting/filtering stay in pr-filter.ts).
export const features = tableFeatures({
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const columnHelper = createColumnHelper<typeof features, PullRequest>();

/**
 * "Обновлён" cell: relative time text, full ISO date in a native `title`
 * attribute (brief: tooltip-free, no Radix Tooltip needed here).
 */
function UpdatedCell({ pr }: { pr: PullRequest }): JSX.Element {
  return <span title={new Date(pr.updatedAt).toISOString()}>{relative(pr.updatedAt, new Date())}</span>;
}

/**
 * Builds the PR table columns. `allFullNames` is the set of `owner/name`
 * full names among the *currently shown* rows (T034/US5) — passed in fresh
 * per render so the "Репозиторий" column's `RepoTag` only drops the owner
 * when there's no name collision among what's actually on screen.
 */
export function createPrColumns(allFullNames: Iterable<string>) {
  return columnHelper.columns([
  columnHelper.accessor((pr) => pr.ci.state, {
    id: 'ci',
    header: () => t('prsColCi'),
    cell: (info) => <StatusIcon state={info.row.original.ci.state} />,
  }),
  columnHelper.accessor((pr) => pr.title, {
    id: 'title',
    header: () => t('prsColTitle'),
    cell: (info) => {
      const pr = info.row.original;
      return (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{pr.title}</span>
          {pr.draft && <Badge variant="outline">{t('prsDraftBadge')}</Badge>}
          {pr.mergeable === false && <Badge variant="destructive">{t('prsConflictBadge')}</Badge>}
        </div>
      );
    },
  }),
  columnHelper.accessor((pr) => `${pr.repo.owner}/${pr.repo.name}`, {
    id: 'repo',
    header: () => t('prsColRepo'),
    cell: (info) => {
      const pr = info.row.original;
      const fullName = `${pr.repo.owner}/${pr.repo.name}`;
      return (
        <div className="flex items-center gap-1.5">
          <NumberTag number={pr.number} />
          <RepoTag fullName={fullName} allFullNames={allFullNames} />
        </div>
      );
    },
  }),
  columnHelper.accessor((pr) => pr.author, {
    id: 'author',
    header: () => t('prsColAuthor'),
    cell: (info) => info.row.original.author,
  }),
  columnHelper.accessor((pr) => pr.updatedAt, {
    id: 'updated',
    header: () => t('prsColUpdated'),
    cell: (info) => <UpdatedCell pr={info.row.original} />,
  }),
  ]);
}
