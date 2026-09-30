// Pure label/tone helpers for the "теги" work (rev.2).
// Source of truth: docs/specs/002-fullpage-dashboard/research.md R10,
// docs/specs/002-fullpage-dashboard/tasks.md T032. No browser APIs here.

/** Number of distinct repo color tones (see src/ui/Tags.tsx palette). */
export const REPO_TONE_COUNT = 8;

/**
 * The short repo label: just the name, unless another owner in
 * `allFullNames` has a repo with the same name — then the full
 * `owner/name` is kept to disambiguate.
 */
export function repoLabel(fullName: string, allFullNames: Iterable<string>): string {
  const name = fullName.split('/')[1] ?? fullName;

  for (const other of allFullNames) {
    if (other === fullName) continue;
    const otherSlash = other.indexOf('/');
    if (otherSlash === -1) continue;
    const otherName = other.slice(otherSlash + 1);
    if (otherName === name) {
      return fullName;
    }
  }

  return name;
}

/**
 * FNV-1a hash of a string, reduced to the 0..REPO_TONE_COUNT-1 palette
 * range. Deterministic and stable for the same input.
 */
export function repoColorIndex(fullName: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)

  for (let i = 0; i < fullName.length; i++) {
    hash ^= fullName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }

  // FNV-1a leaves low bits weakly mixed for near-uniform inputs (e.g.
  // "owner0/repo0", "owner1/repo1", ...); XOR-fold the high bits in before
  // reducing to the palette range for a better distribution.
  const unsigned = hash >>> 0;
  const mixed = (unsigned ^ (unsigned >>> 15)) >>> 0;
  return mixed % REPO_TONE_COUNT;
}

/**
 * Effective repo tone: the user's override when it is a valid palette index,
 * otherwise the deterministic name hash (FR-119).
 */
export function resolveRepoTone(
  fullName: string,
  overrides: Readonly<Record<string, number>> | undefined
): number {
  const o = overrides?.[fullName];
  if (typeof o === 'number' && Number.isInteger(o) && o >= 0 && o < REPO_TONE_COUNT) return o;
  return repoColorIndex(fullName);
}

export type BranchTone = 'blue' | 'amber' | 'neutral';

/**
 * Branch name → visual tone. Exact, case-insensitive matches only:
 * main/master → blue, test → amber, anything else → neutral.
 */
export function branchTone(branch: string): BranchTone {
  const lower = branch.toLowerCase();
  if (lower === 'main' || lower === 'master') return 'blue';
  if (lower === 'test') return 'amber';
  return 'neutral';
}
