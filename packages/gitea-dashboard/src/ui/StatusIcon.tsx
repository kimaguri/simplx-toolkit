import type { JSX } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDot,
  Clock,
  Loader2,
  MinusCircle,
  PauseCircle,
  SkipForward,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { CiState, RunState } from '../domain/types';
import { t } from '../lib/i18n';

export type StatusIconState = RunState | CiState;

interface IconSpec {
  titleKey: string;
  icon: LucideIcon;
  color: string;
  spin?: boolean;
}

// One entry per distinct StatusIconState. RunState and CiState overlap on
// success/failure/skipped, which intentionally share the same icon + color.
const ICONS: Record<StatusIconState, IconSpec> = {
  waiting: { titleKey: 'statusWaiting', icon: Clock, color: 'text-muted-foreground' },
  blocked: { titleKey: 'statusBlocked', icon: PauseCircle, color: 'text-amber-500' },
  running: { titleKey: 'statusRunning', icon: Loader2, color: 'text-blue-500', spin: true },
  success: {
    titleKey: 'statusSuccess',
    icon: CheckCircle2,
    color: 'text-green-600 dark:text-green-500',
  },
  failure: { titleKey: 'statusFailure', icon: XCircle, color: 'text-destructive' },
  cancelled: { titleKey: 'statusCancelled', icon: Ban, color: 'text-muted-foreground' },
  skipped: { titleKey: 'statusSkipped', icon: SkipForward, color: 'text-muted-foreground' },
  error: { titleKey: 'statusError', icon: AlertCircle, color: 'text-destructive' },
  pending: { titleKey: 'statusPending', icon: CircleDot, color: 'text-muted-foreground' },
  warning: { titleKey: 'statusWarning', icon: AlertTriangle, color: 'text-amber-500' },
  none: { titleKey: 'statusNone', icon: MinusCircle, color: 'text-muted-foreground' },
};

export interface StatusIconProps {
  state: StatusIconState;
  size?: number;
}

/**
 * Accessible status icon built from lucide-react icons + Tailwind color
 * utility classes (tokens defined in src/styles/globals.css). The "running"
 * state gets `animate-spin` plus a `data-spin="true"` marker used by tests.
 */
export function StatusIcon({ state, size = 14 }: StatusIconProps): JSX.Element {
  const spec = ICONS[state];
  const title = t(spec.titleKey);
  const Icon = spec.icon;

  return (
    <Icon
      size={size}
      role="img"
      aria-label={title}
      className={cn(spec.color, spec.spin && 'animate-spin')}
      data-spin={spec.spin ? 'true' : undefined}
    >
      <title>{title}</title>
    </Icon>
  );
}
