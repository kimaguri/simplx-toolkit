// Human-readable relative/duration time formatting.
// These are formatted output strings (not UI chrome labels), so the Russian
// units are hardcoded here rather than routed through t()/messages.json —
// i18n of these units is explicitly out of scope for this task.

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isPreviousCalendarDay(older: Date, newer: Date): boolean {
  const olderMidnight = new Date(
    older.getFullYear(),
    older.getMonth(),
    older.getDate(),
  );
  const newerMidnight = new Date(
    newer.getFullYear(),
    newer.getMonth(),
    newer.getDate(),
  );
  const diffDays = Math.round(
    (newerMidnight.getTime() - olderMidnight.getTime()) / (24 * HOUR_MS),
  );
  return diffDays === 1;
}

/**
 * Formats an ISO timestamp relative to `now` in Russian:
 * <1 min → «только что»; <1 h → «N мин назад»; same day → «N ч назад»;
 * previous calendar day → «вчера»; older → «D мес» (+ year if different).
 */
export function relative(iso: string, now: Date): string {
  const date = new Date(iso);
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < MINUTE_MS) {
    return 'только что';
  }
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes} мин назад`;
  }
  if (isSameCalendarDay(date, now)) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours} ч назад`;
  }
  if (isPreviousCalendarDay(date, now)) {
    return 'вчера';
  }

  const day = date.getDate();
  const month = MONTHS_SHORT[date.getMonth()];
  if (date.getFullYear() !== now.getFullYear()) {
    return `${day} ${month} ${date.getFullYear()}`;
  }
  return `${day} ${month}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Formats the elapsed time between `startIso` and `endIso` (or `now` when
 * `endIso` is missing) in Russian units: `45с`, `3м 05с`, `1ч 02м`.
 * Returns «—» when `startIso` is missing.
 */
export function duration(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: Date,
): string {
  if (!startIso) {
    return '—';
  }

  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : now;
  const totalSeconds = Math.max(
    0,
    Math.floor((end.getTime() - start.getTime()) / 1000),
  );

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}ч ${pad2(minutes)}м`;
  }
  if (minutes > 0) {
    return `${minutes}м ${pad2(seconds)}с`;
  }
  return `${seconds}с`;
}
