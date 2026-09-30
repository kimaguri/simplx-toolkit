// Colour-dot button + shadcn Popover palette (8 tones + «Авто») for one repo
// row on the Repo page (FR-119). Dashboard only.
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { resolveRepoTone, REPO_TONE_COUNT } from '../../domain/labels';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useRepoColors } from '../../ui/repo-colors';

// Literal classes (Tailwind v4 static scan), same order as REPO_TONE_CLASSES.
const DOT_CLASSES: readonly string[] = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-orange-500',
  'bg-teal-500',
  'bg-fuchsia-500',
  'bg-lime-500',
];

export function RepoColorPicker({ fullName }: { fullName: string }): JSX.Element {
  const { overrides, setColor } = useRepoColors();
  const [open, setOpen] = useState(false);
  const current = resolveRepoTone(fullName, overrides);

  function choose(tone: number | undefined): void {
    setColor?.(fullName, tone);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('repoColorButton')}
          onClick={(event) => event.stopPropagation()}
        >
          <span className={cn('size-3 rounded-full', DOT_CLASSES[current])} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {Array.from({ length: REPO_TONE_COUNT }, (_, tone) => (
            <Button
              key={tone}
              type="button"
              variant={overrides[fullName] === tone ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={t('repoColorTone', String(tone + 1))}
              data-testid={`repo-color-tone-${tone}`}
              onClick={() => choose(tone)}
            >
              <span className={cn('size-3 rounded-full', DOT_CLASSES[tone])} />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => choose(undefined)}
          >
            {t('repoColorAuto')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
