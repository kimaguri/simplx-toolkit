// Repo/branch/number tags (rev.2). shadcn Badge (variant="outline") with a
// small static palette of colored tones — Tailwind v4 needs literal class
// strings, so the palette below is a static lookup table, never built via
// string interpolation.
// Source of truth: docs/specs/002-fullpage-dashboard/research.md R10,
// docs/specs/002-fullpage-dashboard/tasks.md T032.
import type { JSX } from 'react';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { branchTone, repoLabel, resolveRepoTone, type BranchTone } from '../domain/labels';
import { useRepoColors } from './repo-colors';

// 8-tone repo palette (index from repoColorIndex). Each entry is a literal
// class string so Tailwind's compiler can see it statically.
export const REPO_TONE_CLASSES: readonly string[] = [
  'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20',
  'bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20',
  'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
  'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20',
  'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20',
  'bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20',
  'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/20',
  'bg-lime-500/10 text-lime-700 dark:text-lime-400 border-lime-500/20',
];

const BRANCH_TONE_CLASSES: Record<BranchTone, string> = {
  blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  neutral: 'bg-muted text-muted-foreground border-transparent',
};

export interface RepoTagProps {
  fullName: string;
  allFullNames: Iterable<string>;
}

/** Repo tag: short name unless it collides with another owner's repo of the same name. */
export function RepoTag({ fullName, allFullNames }: RepoTagProps): JSX.Element {
  const label = repoLabel(fullName, allFullNames);
  const { overrides } = useRepoColors();
  const toneClass = REPO_TONE_CLASSES[resolveRepoTone(fullName, overrides)];

  return (
    <Badge variant="outline" className={cn(toneClass)} title={fullName}>
      {label}
    </Badge>
  );
}

export interface BranchTagProps {
  branch: string;
}

/** Branch tag: blue for main/master, amber for test, neutral otherwise. */
export function BranchTag({ branch }: BranchTagProps): JSX.Element {
  const toneClass = BRANCH_TONE_CLASSES[branchTone(branch)];

  return (
    <Badge variant="outline" className={cn(toneClass)} title={branch}>
      {branch}
    </Badge>
  );
}

export interface NumberTagProps {
  number: number;
}

/** Muted monospace tag for a PR/issue number, e.g. "#42". */
export function NumberTag({ number }: NumberTagProps): JSX.Element {
  return (
    <Badge variant="outline" className="font-mono text-muted-foreground">
      #{number}
    </Badge>
  );
}
