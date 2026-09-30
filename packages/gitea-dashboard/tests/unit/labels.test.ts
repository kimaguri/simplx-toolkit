// Contract: docs/specs/002-fullpage-dashboard/research.md R10, tasks.md T032.
// Pure domain functions for repo/branch tags — no browser APIs.
import { describe, expect, it } from 'vitest';
import { branchTone, repoColorIndex, repoLabel } from '../../src/domain/labels';

describe('repoLabel', () => {
  it('returns the name without the owner when no other owner has the same name', () => {
    const all = ['acme/api', 'acme/web', 'other/tools'];
    expect(repoLabel('acme/api', all)).toBe('api');
  });

  it('returns owner/name when another owner has the same repo name (collision)', () => {
    const all = ['acme/api', 'other/api'];
    expect(repoLabel('acme/api', all)).toBe('acme/api');
    expect(repoLabel('other/api', all)).toBe('other/api');
  });

  it('does not treat the same fullName appearing once as a collision', () => {
    const all = ['acme/api'];
    expect(repoLabel('acme/api', all)).toBe('api');
  });

  it('ignores malformed entries without a slash', () => {
    const all = ['acme/api', 'not-a-repo'];
    expect(repoLabel('acme/api', all)).toBe('api');
  });
});

describe('repoColorIndex', () => {
  it('is stable for the same fullName', () => {
    const a = repoColorIndex('acme/api');
    const b = repoColorIndex('acme/api');
    expect(a).toBe(b);
  });

  it('is within the 0..7 palette range', () => {
    for (const name of ['acme/api', 'acme/web', 'other/tools', 'x/y', 'zzz/qqq']) {
      const idx = repoColorIndex(name);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(7);
    }
  });

  it('distributes 20 distinct names over at least 5 of the 8 tones', () => {
    const names = Array.from({ length: 20 }, (_, i) => `owner${i}/repo${i}`);
    const tones = new Set(names.map((n) => repoColorIndex(n)));
    expect(tones.size).toBeGreaterThanOrEqual(5);
  });
});

describe('branchTone', () => {
  it('returns blue for main/master (case-insensitive)', () => {
    expect(branchTone('main')).toBe('blue');
    expect(branchTone('Master')).toBe('blue');
    expect(branchTone('MAIN')).toBe('blue');
  });

  it('returns amber for test (case-insensitive)', () => {
    expect(branchTone('test')).toBe('amber');
    expect(branchTone('Test')).toBe('amber');
  });

  it('returns neutral for anything else (exact-name match only)', () => {
    expect(branchTone('develop')).toBe('neutral');
    expect(branchTone('feature/x')).toBe('neutral');
    expect(branchTone('mainline')).toBe('neutral');
    expect(branchTone('testing')).toBe('neutral');
  });
});
