// "Репо" tab (US2, FR-010..014) — thin wrapper around the shared
// src/features/repos/ReposSection.tsx (docs/specs/002-fullpage-dashboard/research.md
// R8): the popup renders it at density="compact" (unchanged markup/behavior).
import type { JSX } from 'react';
import { ReposSection } from '../../../features/repos/ReposSection';

export function Repos(): JSX.Element {
  return <ReposSection density="compact" />;
}
