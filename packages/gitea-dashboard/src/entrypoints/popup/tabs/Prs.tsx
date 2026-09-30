// "PR" tab (US3, FR-020..023, FR-072) — thin wrapper around the shared
// src/features/prs/PrsGroups.tsx (docs/specs/002-fullpage-dashboard/research.md
// R8): the popup renders it at density="compact" (unchanged markup/behavior).
import type { JSX } from 'react';
import type { Settings, Snapshot } from '../../../domain/types';
import { PrsGroups } from '../../../features/prs/PrsGroups';

export interface PrsProps {
  snapshot?: Snapshot | null;
  settings?: Settings;
  /** Active instance's normalized base URL, for the "ещё N" link (FR-072). */
  baseUrl?: string;
}

export function Prs({ snapshot, settings, baseUrl }: PrsProps = {}): JSX.Element {
  return (
    <PrsGroups snapshot={snapshot} settings={settings} baseUrl={baseUrl} density="compact" />
  );
}
