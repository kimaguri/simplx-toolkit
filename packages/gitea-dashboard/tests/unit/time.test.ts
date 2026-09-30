import { describe, expect, it } from 'vitest';
import { duration, relative } from '../../src/lib/time';

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('relative', () => {
  it('returns "только что" for less than a minute', () => {
    const iso = new Date(NOW.getTime() - 30 * 1000).toISOString();
    expect(relative(iso, NOW)).toBe('только что');
  });

  it('returns "только что" for 0 seconds', () => {
    expect(relative(NOW.toISOString(), NOW)).toBe('только что');
  });

  it('returns minutes for under an hour', () => {
    const iso = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(relative(iso, NOW)).toBe('5 мин назад');
  });

  it('returns minutes just under an hour (59 мин)', () => {
    const iso = new Date(NOW.getTime() - 59 * 60 * 1000).toISOString();
    expect(relative(iso, NOW)).toBe('59 мин назад');
  });

  it('returns hours for same-day differences', () => {
    const iso = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    expect(relative(iso, NOW)).toBe('3 ч назад');
  });

  it('returns "вчера" for the previous calendar day', () => {
    const iso = new Date('2026-09-14T18:00:00.000Z').toISOString();
    expect(relative(iso, NOW)).toBe('вчера');
  });

  it('returns day + month for older dates in the same year', () => {
    const iso = new Date('2026-09-12T09:00:00.000Z').toISOString();
    expect(relative(iso, NOW)).toBe('12 сен');
  });

  it('includes the year for dates in a different year', () => {
    const iso = new Date('2025-09-12T09:00:00.000Z').toISOString();
    expect(relative(iso, NOW)).toBe('12 сен 2025');
  });
});

describe('duration', () => {
  it('returns "—" when start is missing', () => {
    expect(duration(null, null, NOW)).toBe('—');
    expect(duration(undefined, undefined, NOW)).toBe('—');
  });

  it('formats seconds only', () => {
    const start = new Date(NOW.getTime() - 45 * 1000).toISOString();
    expect(duration(start, null, NOW)).toBe('45с');
  });

  it('formats minutes and seconds', () => {
    const start = new Date(NOW.getTime() - (3 * 60 + 5) * 1000).toISOString();
    expect(duration(start, null, NOW)).toBe('3м 05с');
  });

  it('formats hours and minutes', () => {
    const start = new Date(
      NOW.getTime() - (60 * 60 + 2 * 60) * 1000,
    ).toISOString();
    expect(duration(start, null, NOW)).toBe('1ч 02м');
  });

  it('uses "now" when end is missing', () => {
    const start = new Date(NOW.getTime() - 10 * 1000).toISOString();
    expect(duration(start, undefined, NOW)).toBe('10с');
  });

  it('uses the provided end instead of now', () => {
    const start = new Date(NOW.getTime() - 60 * 1000).toISOString();
    const end = new Date(NOW.getTime() - 30 * 1000).toISOString();
    expect(duration(start, end, NOW)).toBe('30с');
  });
});
