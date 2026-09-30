// "Сборки" tab (US4, FR-030..033, FR-072) — thin wrapper around the shared
// src/features/builds/BuildsGroups.tsx (docs/specs/002-fullpage-dashboard/research.md
// R8): the popup renders it at density="compact" (unchanged markup/behavior).
//
// NOTE (T046): App.tsx does not yet pass `snapshot`/`capabilities` props to
// tabs (it only reads the snapshot for the top-level Stale/auth banner — see
// src/entrypoints/popup/App.tsx). This component accepts them as props;
// wiring `<Builds snapshot={snapshot} capabilities={activeInstance?.capabilities} />`
// into App.tsx is left to whoever owns that file next (T026), per the task
// brief — this task must not edit App.tsx.
import type { JSX } from 'react';
import type { Capabilities, Snapshot } from '../../../domain/types';
import { BuildsGroups } from '../../../features/builds/BuildsGroups';

export interface BuildsProps {
  snapshot?: Snapshot;
  capabilities?: Capabilities;
}

export function Builds({ snapshot, capabilities }: BuildsProps): JSX.Element {
  return <BuildsGroups snapshot={snapshot} capabilities={capabilities} density="compact" />;
}
