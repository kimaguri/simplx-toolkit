// Icons for the "Репо" tab (US2, FR-010..014): lucide-react + the same
// pattern as src/ui/StatusIcon.tsx — currentColor via Tailwind utility
// classes (tokens in src/styles/globals.css) + an accessible <title> via
// t().
import type { JSX } from 'react';
import { Lock, Star } from 'lucide-react';
import { cn } from '../lib/utils';
import { t } from '../lib/i18n';

export interface LockIconProps {
  size?: number;
}

/** Private-repo indicator (was 🔒). */
export function LockIcon({ size = 12 }: LockIconProps): JSX.Element {
  const title = t('reposPrivate');

  return (
    <Lock size={size} role="img" aria-label={title} className="text-muted-foreground">
      <title>{title}</title>
    </Lock>
  );
}

export interface PinIconProps {
  pinned: boolean;
  size?: number;
}

/** Pin-state indicator (was ★/☆): filled + amber when pinned, outline + muted otherwise. */
export function PinIcon({ pinned, size = 14 }: PinIconProps): JSX.Element {
  const title = t(pinned ? 'reposPinned' : 'reposUnpinned');

  return (
    <Star
      size={size}
      role="img"
      aria-label={title}
      className={cn(pinned ? 'fill-current text-amber-500' : 'text-muted-foreground')}
    >
      <title>{title}</title>
    </Star>
  );
}
