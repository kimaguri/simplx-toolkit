// Dashboard-only provider of per-repo colour overrides (FR-119).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import {
  getInstances,
  getRepoColors,
  onInstancesChanged,
  onRepoColorsChanged,
  setRepoColors,
  type RepoColors,
} from '../../lib/storage';
import { RepoColorsContext, type RepoColorsValue } from '../../ui/repo-colors';
import { RepoColorPicker } from './RepoColorPicker';

export function RepoColorsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<RepoColors>({});
  const latest = useRef<RepoColors>({});
  latest.current = overrides;

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    let generation = 0;

    async function load(activeInstanceId: string | undefined): Promise<void> {
      const mine = ++generation;
      off?.();
      off = undefined;
      // Drop the old instance's state immediately so setColor can never
      // write it under the new instance's key (or vice versa).
      latest.current = {};
      setOverrides({});
      setInstanceId(activeInstanceId);
      if (!activeInstanceId) return;
      const stored = await getRepoColors(activeInstanceId);
      if (cancelled || mine !== generation) return;
      latest.current = stored;
      setOverrides(stored);
      off = onRepoColorsChanged(activeInstanceId, setOverrides);
    }

    let currentId: string | undefined;
    void getInstances().then(({ activeInstanceId }) => {
      if (cancelled) return;
      currentId = activeInstanceId;
      void load(activeInstanceId);
    });
    const offInstances = onInstancesChanged(({ activeInstanceId }) => {
      if (cancelled || activeInstanceId === currentId) return;
      currentId = activeInstanceId;
      void load(activeInstanceId);
    });
    return () => {
      cancelled = true;
      offInstances();
      off?.();
    };
  }, []);

  const setColor = useCallback(
    (fullName: string, tone: number | undefined) => {
      if (!instanceId) return;
      const next = { ...latest.current };
      if (tone === undefined) delete next[fullName];
      else next[fullName] = tone;
      latest.current = next;
      setOverrides(next);
      void setRepoColors(instanceId, next);
    },
    [instanceId]
  );

  const value = useMemo<RepoColorsValue>(
    () => ({
      overrides,
      setColor,
      renderRowPicker: (fullName) => <RepoColorPicker fullName={fullName} />,
    }),
    [overrides, setColor]
  );

  return <RepoColorsContext.Provider value={value}>{children}</RepoColorsContext.Provider>;
}
