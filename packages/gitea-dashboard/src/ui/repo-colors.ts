// Repo colour override context (FR-119). No provider -> empty overrides, so
// RepoTag falls back to the name hash (popup unchanged). Dashboard-only
// provider: src/features/repos/RepoColorsProvider.tsx.
import { createContext, useContext, type ReactNode } from 'react';

export interface RepoColorsValue {
  overrides: Readonly<Record<string, number>>;
  /** Set a tone index, or `undefined` for "Авто". Absent without a provider. */
  setColor?: (fullName: string, tone: number | undefined) => void;
  /** Optional per-row slot for the Repo page (colour picker); dashboard only. */
  renderRowPicker?: (fullName: string) => ReactNode;
}

const EMPTY: RepoColorsValue = { overrides: {} };

export const RepoColorsContext = createContext<RepoColorsValue>(EMPTY);

export function useRepoColors(): RepoColorsValue {
  return useContext(RepoColorsContext);
}
