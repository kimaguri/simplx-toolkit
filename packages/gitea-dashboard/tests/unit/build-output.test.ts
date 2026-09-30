// @vitest-environment node
//
// T081: a local tooling plugin (claude-mem) writes stray `CLAUDE.md` files
// into arbitrary directories, including `public/**`. WXT copies `public/`
// verbatim into the build output, so those files (which may contain private
// session context) must never end up in `.output/chrome-mv3`. This test
// builds the extension once and inspects the real output directory.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT, '.output/chrome-mv3');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

beforeAll(() => {
  execSync('./node_modules/.bin/wxt build', {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 120_000,
  });
}, 120_000);

/**
 * Resolve a local module reference from a JS/HTML file: root-relative
 * ("/chunks/x.js") from an HTML `<script>`/`<link>`, or relative
 * ("./chunks/y.js") from another JS file's import.
 */
function resolveAssetPath(refPath: string, fromFile: string): string {
  if (refPath.startsWith('/')) {
    return path.join(OUTPUT_DIR, refPath.slice(1));
  }
  return path.resolve(path.dirname(fromFile), refPath);
}

/**
 * Walk the JS chunks actually loaded by `popup.html`: the entry script(s)
 * referenced from the HTML, plus every local `.js` module those files
 * statically/dynamically import, recursively (same traversal
 * `scripts/check-size.mjs` uses for the popup size budget) -- CSS assets are
 * deliberately excluded here: `src/styles/globals.css` is one Tailwind
 * source shared verbatim by popup/dashboard/options (see each entrypoint's
 * main.tsx), so the Tailwind Vite plugin always emits a
 * single physical stylesheet covering every utility class used anywhere in
 * the extension, including dashboard-only ones -- splitting that is a
 * separate, out-of-scope change (T039 only touches `BuildsGroups.tsx`,
 * `comfortable-row.tsx`, `dashboard/App.tsx`, and `wxt.config.ts`).
 */
function collectPopupJsChunks(): Map<string, string> {
  const popupHtml = path.join(OUTPUT_DIR, 'popup.html');
  const html = fs.readFileSync(popupHtml, 'utf8');
  const entryRefs = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)]
    .map((m) => m[1])
    .filter((ref): ref is string => ref !== undefined);

  const sources = new Map<string, string>(); // absPath -> source text
  const queue = entryRefs.map((ref) => resolveAssetPath(ref, popupHtml));

  while (queue.length > 0) {
    const absPath = queue.shift()!;
    if (sources.has(absPath)) continue;
    if (!fs.existsSync(absPath)) continue;

    const source = fs.readFileSync(absPath, 'utf8');
    sources.set(absPath, source);

    const importRefs = [
      ...source.matchAll(/\bfrom\s*["']([^"']+\.js)["']/g),
      ...source.matchAll(/\bimport\s*["']([^"']+\.js)["']/g),
      ...source.matchAll(/\bimport\(\s*["']([^"']+\.js)["']\s*\)/g),
    ]
      .map((m) => m[1])
      .filter((ref): ref is string => ref !== undefined);
    for (const ref of importRefs) {
      const resolved = resolveAssetPath(ref, absPath);
      if (!sources.has(resolved)) queue.push(resolved);
    }
  }

  return sources;
}

describe('build output (chrome-mv3)', () => {
  it('contains no CLAUDE.md file anywhere', () => {
    const claudeMdFiles = walkFiles(OUTPUT_DIR)
      .filter((f) => path.basename(f) === 'CLAUDE.md')
      .map((f) => path.relative(OUTPUT_DIR, f));
    expect(claudeMdFiles).toEqual([]);
  });

  it('has messages.json in every _locales/* directory', () => {
    const localesDir = path.join(OUTPUT_DIR, '_locales');
    const localeDirs = fs
      .readdirSync(localesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const locale of localeDirs) {
      const messagesPath = path.join(localesDir, locale, 'messages.json');
      expect(fs.existsSync(messagesPath)).toBe(true);
    }
  });

  it('contains only the ru locale', () => {
    const localesDir = path.join(OUTPUT_DIR, '_locales');
    const localeDirs = fs
      .readdirSync(localesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(localeDirs).toEqual(['ru']);
  });

  // T002: the dashboard.html unlisted page must appear in the build output,
  // and must not add any manifest permissions/keys beyond the baseline
  // recorded from the manifest before this feature's page was added.
  describe('dashboard.html (T002)', () => {
    const BASELINE_TOP_LEVEL_KEYS = [
      'manifest_version',
      'name',
      'description',
      'version',
      'icons',
      'default_locale',
      'permissions',
      'host_permissions',
      'optional_host_permissions',
      'action',
      'commands',
      'omnibox',
      'options_ui',
      'background',
    ].sort();

    function readManifest() {
      const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }

    it('is present in the build output', () => {
      const dashboardHtmlPath = path.join(OUTPUT_DIR, 'dashboard.html');
      expect(fs.existsSync(dashboardHtmlPath)).toBe(true);
    });

    it('does not change permissions', () => {
      const manifest = readManifest();
      expect(manifest.permissions).toEqual(['storage', 'alarms', 'notifications']);
    });

    it('does not change host_permissions', () => {
      const manifest = readManifest();
      expect(manifest.host_permissions).toEqual([]);
    });

    it('does not change optional_host_permissions', () => {
      const manifest = readManifest();
      expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    });

    it('does not add any new top-level manifest keys', () => {
      const manifest = readManifest();
      expect(Object.keys(manifest).sort()).toEqual(BASELINE_TOP_LEVEL_KEYS);
    });

    it('does not change action.default_title', () => {
      const manifest = readManifest();
      expect(manifest.action.default_title).toBe('__MSG_actionTitle__');
    });
  });

  // T039: after T034 (comfortable-density RepoTag/BranchTag) and T037
  // (dashboard sidebar), the popup's JS chunks must not carry dashboard-only
  // code (the popup only ever renders `density="compact"` and has no
  // sidebar/table). `BuildsGroups.tsx` must not import `src/ui/Tags`
  // directly -- the dashboard passes a `renderSecondary` renderer from
  // `src/features/builds/comfortable-row.tsx` instead (popup passes none).
  describe('popup JS chunks (T039)', () => {
    const MARKERS = [
      'bg-sky-500/10', // src/ui/Tags.tsx REPO_TONE_CLASSES (RepoTag/BranchTag)
      'data-slot="sidebar', // shadcn sidebar (T037, dashboard-only)
      '@tanstack', // TanStack Table (PrsTable, dashboard-only)
      'cmdk', // shadcn command palette dep (sidebar, dashboard-only)
      'toggle-group', // shadcn ToggleGroup (BuildsSection/PrsSection view switch, dashboard-only)
    ];

    for (const marker of MARKERS) {
      it(`no popup-loaded JS chunk contains ${JSON.stringify(marker)}`, () => {
        const chunks = collectPopupJsChunks();
        const offenders = [...chunks.entries()]
          .filter(([, source]) => source.includes(marker))
          .map(([absPath]) => path.relative(OUTPUT_DIR, absPath));
        expect(offenders).toEqual([]);
      });
    }
  });

  // T040: the popup now loads its own stylesheet (src/styles/popup.css,
  // scanned only against popup-reachable sources) instead of the shared
  // src/styles/globals.css (74 KB, covering dashboard-only sidebar/cmdk/tag
  // classes too). This reads the CSS asset(s) actually `<link>`ed from
  // popup.html and asserts dashboard-only utility classes are gone.
  //
  // Custom property *declarations/uses* for the shared shadcn `--sidebar*`
  // design tokens (defined once in src/styles/theme.css, shared by both
  // stylesheets) are expected to remain -- those are plain CSS variables,
  // not utility classes, and stripping them out first is how this test
  // tells a real "sidebar" component leak apart from the shared token.
  describe('popup CSS assets (T040)', () => {
    function collectPopupCssAssets(): Map<string, string> {
      const popupHtml = path.join(OUTPUT_DIR, 'popup.html');
      const html = fs.readFileSync(popupHtml, 'utf8');
      const hrefs = [...html.matchAll(/href="([^"]+\.css)"/g)]
        .map((m) => m[1])
        .filter((ref): ref is string => ref !== undefined);
      const assets = new Map<string, string>();
      for (const href of hrefs) {
        const absPath = resolveAssetPath(href, popupHtml);
        assets.set(absPath, fs.readFileSync(absPath, 'utf8'));
      }
      return assets;
    }

    it('links at least one stylesheet', () => {
      expect(collectPopupCssAssets().size).toBeGreaterThan(0);
    });

    it('contains no cmdk (shadcn command palette / sidebar) selectors', () => {
      const assets = collectPopupCssAssets();
      const offenders = [...assets.entries()]
        .filter(([, css]) => css.includes('cmdk'))
        .map(([absPath]) => path.relative(OUTPUT_DIR, absPath));
      expect(offenders).toEqual([]);
    });

    it('contains no sidebar utility classes/attributes (only the shared --sidebar* tokens)', () => {
      const assets = collectPopupCssAssets();
      const offenders = [...assets.entries()]
        .filter(([, css]) => css.replaceAll(/--sidebar[\w-]*/g, '').includes('sidebar'))
        .map(([absPath]) => path.relative(OUTPUT_DIR, absPath));
      expect(offenders).toEqual([]);
    });

    it('contains no bg-sky-500 (RepoTag/BranchTag, dashboard-only) utility', () => {
      const assets = collectPopupCssAssets();
      const offenders = [...assets.entries()]
        .filter(([, css]) => css.includes('bg-sky-500'))
        .map(([absPath]) => path.relative(OUTPUT_DIR, absPath));
      expect(offenders).toEqual([]);
    });
  });
});
