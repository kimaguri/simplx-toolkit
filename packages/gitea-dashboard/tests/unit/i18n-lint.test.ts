// @vitest-environment node
//
// Lints i18n hygiene (FR-073) across `src/**/*.{ts,tsx}`:
//   1. no stray Cyrillic characters outside comments/`t()` call arguments
//      (`src/lib/time.ts` is an explicit, documented exception — it formats
//      Russian-only relative/duration units, out of i18n scope);
//   2. every key referenced as a string literal (`t('key')`, `messageKey="key"`,
//      `messageKey: 'key'`, `labelKey: 'key'`, `labelKey="key"`) exists in
//      `public/_locales/ru/messages.json`;
//   3. no locale directory other than `ru` exists under `public/_locales`
//      (UI is always Russian — see owner decision in tasks.md T076);
//   4. every ru message has a non-empty `message` string.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(ROOT, 'src');
const LOCALES_DIR = path.join(ROOT, 'public/_locales');
const RU_MESSAGES_PATH = path.join(LOCALES_DIR, 'ru/messages.json');
const TIME_TS_PATH = path.join(SRC_DIR, 'lib/time.ts');

interface MessageEntry {
  message: string;
  description?: string;
}

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, predicate));
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = walk(
  SRC_DIR,
  (name) => name.endsWith('.ts') || name.endsWith('.tsx'),
).sort();
const TSX_FILES = SOURCE_FILES.filter((f) => f.endsWith('.tsx'));

/** Strips `//` and `/* *‍/` comments, then strips `t(...)` call arguments
 * (the key/subs passed to the i18n helper are allowed to contain anything,
 * including Cyrillic substitution values), leaving only "real" code/JSX
 * text for the Cyrillic scan. Best-effort, not a full parser. */
function stripCommentsAndTCalls(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments.replace(/\/\/.*$/gm, '');
  return noLineComments.replace(/\bt\([^)]*\)/g, 't()');
}

const CYRILLIC_RE = /[а-яёА-ЯЁ]/;

/** Matches keys used as string literals in the four supported forms. */
const KEY_LITERAL_RE =
  /\bt\(\s*['"]([A-Za-z0-9_]+)['"]|\bmessageKey\s*[:=]\s*['"]([A-Za-z0-9_]+)['"]|\blabelKey\s*[:=]\s*['"]([A-Za-z0-9_]+)['"]/g;

function extractKeyUsages(): Map<string, string[]> {
  const usages = new Map<string, string[]>();
  for (const file of SOURCE_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(ROOT, file);
    let match: RegExpExecArray | null;
    KEY_LITERAL_RE.lastIndex = 0;
    while ((match = KEY_LITERAL_RE.exec(content))) {
      const key = match[1] ?? match[2] ?? match[3];
      if (!key) continue;
      const locations = usages.get(key) ?? [];
      locations.push(relFile);
      usages.set(key, locations);
    }
  }
  return usages;
}

function loadMessages(filePath: string): Record<string, MessageEntry> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('i18n lint', () => {
  it('has no stray Cyrillic characters in src outside comments/t() args (time.ts excepted)', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      if (file === TIME_TS_PATH) continue;
      const stripped = stripCommentsAndTCalls(fs.readFileSync(file, 'utf8'));
      if (CYRILLIC_RE.test(stripped)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('confirms .tsx files are covered by the Cyrillic scan (sanity check)', () => {
    expect(TSX_FILES.length).toBeGreaterThan(0);
  });

  it('confirms src/features/** and src/entrypoints/dashboard/** are covered by the scan (sanity check)', () => {
    const featuresFiles = SOURCE_FILES.filter((f) =>
      f.includes(`${path.sep}src${path.sep}features${path.sep}`),
    );
    const dashboardFiles = SOURCE_FILES.filter((f) =>
      f.includes(`${path.sep}src${path.sep}entrypoints${path.sep}dashboard${path.sep}`),
    );
    expect(featuresFiles.length).toBeGreaterThan(0);
    expect(dashboardFiles.length).toBeGreaterThan(0);
  });

  it('has every string-literal key used in src present in ru/messages.json', () => {
    const usages = extractKeyUsages();
    const ru = loadMessages(RU_MESSAGES_PATH);
    const missing = [...usages.keys()]
      .filter((key) => !(key in ru))
      .sort();
    expect(missing).toEqual([]);
  });

  it('has no locale directories other than ru under public/_locales (UI is always Russian)', () => {
    // A "locale" is a directory containing messages.json — this is robust
    // against stray tooling artifacts (e.g. a claude-mem CLAUDE.md dropped
    // into an unrelated directory under public/_locales; see T081).
    const locales = fs
      .readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          fs.existsSync(path.join(LOCALES_DIR, e.name, 'messages.json')),
      )
      .map((e) => e.name)
      .sort();
    expect(locales).toEqual(['ru']);
  });

  it('has a non-empty message string for every ru/messages.json entry', () => {
    const ru = loadMessages(RU_MESSAGES_PATH);
    const empty = Object.entries(ru)
      .filter(([, entry]) => typeof entry.message !== 'string' || entry.message.trim() === '')
      .map(([key]) => key)
      .sort();
    expect(empty).toEqual([]);
  });
});
