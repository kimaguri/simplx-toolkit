// Poller core: a mutex'd cycle over a registry of Sections, writing
// Snapshot + PollState to storage.
//
// Design: docs/specs/001-gitea-dashboard/plan.md "Structure Decision" (sections
// split into src/background/poller/{prs,runs,notes,badge}.ts so later tasks
// plug in without editing each other's code — this file only owns the
// registry/mutex/backoff/auth-pause mechanics), data-model.md ("Snapshot",
// "PollState", "Опрос"), contracts/extension-surface.md ("Alarms",
// "Словарь ошибок").
//
// Rules enforced here:
// - `runCycle` is mutex'd: a second concurrent call returns the same
//   in-flight promise, never running a parallel cycle.
// - A section that throws ApiError does not stop other sections; for
//   `prs`/`runs` (the sections with a dedicated Snapshot.sectionErrors slot)
//   the mapped SnapshotErrorKind is recorded there.
// - If every "network" section (prs, runs) fails with network/server, the
//   previous prs/runs/fetchedAt are kept and a top-level `snapshot.error` is
//   set instead of clobbering good data with an outage.
// - A 401 (ApiError kind 'auth') anywhere stops the cycle immediately,
//   pauses the poller (PollState.pausedForAuth) and sets error.kind 'auth'.
//   While paused, `runCycle` performs no fetch at all until `resume()`.
// - Backoff climbs 60→120→240→480→600s on network/server outages and resets
//   to 0 on a cycle that isn't a full outage; `runCycle` is a no-op while
//   `now < nextAllowedAt`.

import { ApiError, type ApiClient } from '../../api/client';
import {
  toSnapshotErrorKind,
  type Instance,
  type PollState,
  type Settings,
  type Snapshot,
  type SnapshotCounts,
  type SnapshotError,
  type SnapshotErrorKind,
} from '../../domain/types';
import * as storage from '../../lib/storage';

export type PollMode = 'base' | 'fast' | 'page-fast';

export interface SectionContext {
  instance: Instance;
  settings: Settings;
  client: ApiClient;
  prev: Snapshot | null;
  now: Date;
  mode: PollMode;
  /**
   * Accumulates the `Partial<Snapshot>` returned by every section that has
   * already run *this* cycle (mutated in place by `runCycle` after each
   * section). Lets a later-registered section (e.g. T043 `runs`, registered
   * after `prs`) read this-cycle data a prior section produced — e.g.
   * `runs` reads `merged.prs` for `myOpenPrs` and `merged.counts` so it can
   * add `activeMine`/`activeOthers`/`failedOthers` without clobbering the
   * `reviews` count `prs` just computed — instead of only seeing the
   * previous cycle's `prev` snapshot.
   */
  merged: Partial<Snapshot>;
}

/**
 * A pluggable unit of a poll cycle. Sections are registered by the tasks
 * that own them (T037 prs, T043 runs, T052 notes, T037/T043 badge) and
 * never need to know about each other.
 */
export interface Section {
  name: 'prs' | 'runs' | 'notes' | 'badge';
  /**
   * Whether this section runs during a `fast` cycle (FR-041: fast mode only
   * refreshes builds while "mine" are active). Defaults to `false` — a
   * section must opt in explicitly. `runsSection` sets this to `true`.
   */
  fast?: boolean;
  run(ctx: SectionContext): Promise<Partial<Snapshot>>;
}

export interface ClientFactoryArgs {
  baseUrl: string;
  token: string;
}

export interface PollerDeps {
  sections: Section[];
  clientFactory: (args: ClientFactoryArgs) => ApiClient;
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Additive post-cycle hook (T050): called every time a cycle writes
   * `snapshot:<id>` (success, network-outage-kept-prev, or the auth-pause
   * branch), with the snapshot that was in storage *before* this cycle and
   * the one just written. `src/entrypoints/background.ts` wires this to
   * `src/background/notifier.ts`'s `handleCycle` so notifications can diff
   * consecutive snapshots without re-reading storage (which would already
   * reflect `next` by then). Errors from the hook are not caught here —
   * callers are expected to handle their own failures so a notifier bug
   * doesn't look like a silent no-op.
   */
  onCycleComplete?: (prev: Snapshot | null, next: Snapshot, instance: Instance) => void | Promise<void>;
}

export interface Poller {
  runCycle(mode: PollMode): Promise<void>;
  isRunning(): boolean;
  /** Clears `pausedForAuth` (called on `settings-changed`, FR-044). */
  resume(): Promise<void>;
}

const BACKOFF_SEQUENCE_SEC = [60, 120, 240, 480, 600] as const;

// Sections with a dedicated `Snapshot.sectionErrors` slot and that count
// toward the "did the whole cycle lose network" decision.
const NETWORK_SECTION_NAMES: ReadonlySet<Section['name']> = new Set(['prs', 'runs']);

const DEFAULT_POLL_STATE: PollState = {
  mode: 'base',
  backoffSec: 0,
  pausedForAuth: false,
};

const DEFAULT_COUNTS: SnapshotCounts = {
  reviews: 0,
  activeMine: 0,
  activeOthers: 0,
  failedOthers: 0,
};

function nextBackoffSec(current: number): number {
  const idx = BACKOFF_SEQUENCE_SEC.indexOf(current as (typeof BACKOFF_SEQUENCE_SEC)[number]);
  const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, BACKOFF_SEQUENCE_SEC.length - 1);
  return BACKOFF_SEQUENCE_SEC[nextIdx] ?? BACKOFF_SEQUENCE_SEC[0];
}

async function loadActiveInstance(): Promise<Instance | undefined> {
  const { instances, activeInstanceId } = await storage.getInstances();
  return instances.find((instance) => instance.id === activeInstanceId);
}

export function createPoller(deps: PollerDeps): Poller {
  const nowFn = deps.now ?? (() => new Date());
  let inFlight: Promise<void> | null = null;
  let inFlightMode: PollMode | null = null;
  // A 'base' cycle requested while a 'fast' cycle is in flight can't just
  // ride the fast promise: fast mode skips non-fast sections (e.g. prs,
  // notes), so those wouldn't get refreshed. Instead we queue exactly one
  // base cycle to run right after the in-flight fast cycle finishes.
  // Concurrent base requests during that same fast cycle all share this one
  // queued promise (coalesced) rather than each queuing their own.
  let queuedBase: Promise<void> | null = null;
  // Backoff "wake up" time per instance. Kept in memory (not persisted) —
  // acceptable because it only needs to survive within one service-worker
  // lifetime; a restart simply lets the next alarm try immediately, which
  // is safe (worst case: one extra request before backoff resumes).
  const nextAllowedAtMs = new Map<string, number>();

  async function resume(): Promise<void> {
    const instance = await loadActiveInstance();
    if (!instance) return;
    const pollState = (await storage.getPollState(instance.id)) ?? DEFAULT_POLL_STATE;
    if (!pollState.pausedForAuth) return;
    await storage.setPollState(instance.id, { ...pollState, pausedForAuth: false });
  }

  async function doCycle(mode: PollMode): Promise<void> {
    const now = nowFn();

    const instance = await loadActiveInstance();
    if (!instance) return;

    const pollState = (await storage.getPollState(instance.id)) ?? DEFAULT_POLL_STATE;
    if (pollState.pausedForAuth) {
      return;
    }

    const wakeAt = nextAllowedAtMs.get(instance.id);
    if (wakeAt !== undefined && now.getTime() < wakeAt) {
      return;
    }

    const token = await storage.getToken(instance.id);
    if (!token) return;

    const settings = await storage.getSettings();
    const prev = (await storage.getSnapshot(instance.id)) ?? null;
    const client = deps.clientFactory({ baseUrl: instance.baseUrl, token });
    // `PollState.mode` only knows base/fast; page-fast is a flavour of fast.
    const pollStateMode: PollState['mode'] = mode === 'base' ? 'base' : 'fast';
    const merged: Partial<Snapshot> = {};
    const ctx: SectionContext = { instance, settings, client, prev, now, mode, merged };
    const sectionErrors: NonNullable<Snapshot['sectionErrors']> = {};
    let sawAuthError = false;
    let sawSuccess = false;
    let networkAttempted = 0;
    const networkFailedKinds: SnapshotErrorKind[] = [];

    for (const section of deps.sections) {
      if (mode !== 'base' && !section.fast) {
        continue;
      }
      const isNetworkSection = NETWORK_SECTION_NAMES.has(section.name);
      try {
        const partial = await section.run(ctx);
        Object.assign(merged, partial);
        sawSuccess = true;
        if (isNetworkSection) {
          networkAttempted += 1;
        }
      } catch (err) {
        if (!(err instanceof ApiError)) {
          throw err;
        }
        if (err.kind === 'auth') {
          sawAuthError = true;
          break; // stop the cycle immediately — nothing further runs.
        }

        const kind = toSnapshotErrorKind(err.kind);
        const sectionError: SnapshotError = { kind, at: now.toISOString() };
        if (section.name === 'prs' || section.name === 'runs') {
          sectionErrors[section.name] = sectionError;
        }
        if (isNetworkSection) {
          networkAttempted += 1;
          if (kind === 'network' || kind === 'server') {
            networkFailedKinds.push(kind);
          }
        }
      }
    }

    if (sawAuthError) {
      const authSnapshot: Snapshot = {
        fetchedAt: prev?.fetchedAt ?? now.toISOString(),
        prs: prev?.prs ?? [],
        runs: prev?.runs ?? [],
        counts: prev?.counts ?? DEFAULT_COUNTS,
        redUntil: prev?.redUntil,
        error: { kind: 'auth', at: now.toISOString() },
        sectionErrors: prev?.sectionErrors,
      };
      await storage.setSnapshot(instance.id, authSnapshot);
      await storage.setPollState(instance.id, { ...pollState, pausedForAuth: true });
      await deps.onCycleComplete?.(prev, authSnapshot, instance);
      return;
    }

    const networkFullyFailed =
      networkAttempted > 0 && networkFailedKinds.length === networkAttempted;

    let snapshot: Snapshot;
    if (networkFullyFailed) {
      const kind: SnapshotErrorKind = networkFailedKinds.every((k) => k === 'server')
        ? 'server'
        : 'network';
      snapshot = {
        fetchedAt: prev?.fetchedAt ?? now.toISOString(),
        prs: prev?.prs ?? [],
        runs: prev?.runs ?? [],
        counts: prev?.counts ?? DEFAULT_COUNTS,
        redUntil: prev?.redUntil,
        error: { kind, at: now.toISOString() },
        sectionErrors: Object.keys(sectionErrors).length > 0 ? sectionErrors : undefined,
        prTotals: prev?.prTotals,
      };
    } else {
      snapshot = {
        // page-fast only refreshes active runs: it must not make the rest of
        // the snapshot look fresh (staleness indicators, startup check).
        fetchedAt: mode === 'page-fast' && prev ? prev.fetchedAt : now.toISOString(),
        prs: merged.prs ?? prev?.prs ?? [],
        runs: merged.runs ?? prev?.runs ?? [],
        counts: merged.counts ?? prev?.counts ?? DEFAULT_COUNTS,
        redUntil: merged.redUntil ?? prev?.redUntil,
        sectionErrors: Object.keys(sectionErrors).length > 0 ? sectionErrors : undefined,
        prTotals: merged.prTotals ?? prev?.prTotals,
        notes: merged.notes ?? prev?.notes,
      };
    }
    await storage.setSnapshot(instance.id, snapshot);
    await deps.onCycleComplete?.(prev, snapshot, instance);

    if (networkFullyFailed) {
      const backoffSec = nextBackoffSec(pollState.backoffSec);
      nextAllowedAtMs.set(instance.id, now.getTime() + backoffSec * 1000);
      await storage.setPollState(instance.id, { ...pollState, mode: pollStateMode, backoffSec });
    } else if (sawSuccess) {
      nextAllowedAtMs.delete(instance.id);
      await storage.setPollState(instance.id, {
        ...pollState,
        mode: pollStateMode,
        backoffSec: 0,
        lastOkAt: now.toISOString(),
      });
    } else {
      await storage.setPollState(instance.id, { ...pollState, mode: pollStateMode });
    }
  }

  return {
    runCycle(mode: PollMode): Promise<void> {
      // The queued base cycle runs after inFlight was cleared; it is still an
      // in-flight cycle (base covers every section), so share it instead of
      // starting a parallel cycle that would read the same `prev`.
      if (!inFlight && queuedBase) {
        return queuedBase;
      }
      if (inFlight) {
        // Same mode: share the in-flight promise as before. A 'fast'
        // request while a 'base' cycle is in flight also shares it — base
        // runs every section, so it already covers whatever fast would do.
        if (mode === inFlightMode || mode !== 'base') {
          return inFlight;
        }
        // mode === 'base' while a 'fast' cycle is in flight: queue one base
        // cycle after it (coalescing further base requests into the same
        // queued promise) so non-fast sections still get refreshed.
        if (queuedBase) {
          return queuedBase;
        }
        const afterCurrent = inFlight;
        const queued = afterCurrent
          .then(
            () => doCycle('base'),
            () => doCycle('base')
          )
          .finally(() => {
            queuedBase = null;
          });
        queuedBase = queued;
        return queued;
      }
      const promise = doCycle(mode).finally(() => {
        inFlight = null;
        inFlightMode = null;
      });
      inFlight = promise;
      inFlightMode = mode;
      return promise;
    },
    isRunning(): boolean {
      return inFlight !== null || queuedBase !== null;
    },
    resume,
  };
}
