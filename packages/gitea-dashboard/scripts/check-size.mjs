#!/usr/bin/env node
// Node built-ins only.
//
// Checks the built extension's popup bundle size (SC-010): the sum of all
// JS+CSS assets loaded by popup.html (including chunks statically imported
// by those JS files, recursively) must not exceed a limit (default 400 KiB,
// SC-010 revised for the React 19 + shadcn/ui + Tailwind v4 stack;
// overridable via CHECK_SIZE_LIMIT_KB for testing the failure path).
//
// Also prints background.js size and the options page total for info only
// (these do not affect the exit code).

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '..', '.output', 'chrome-mv3');

const DEFAULT_LIMIT_KB = 400;
const LIMIT_BYTES = (() => {
  const override = process.env.CHECK_SIZE_LIMIT_KB;
  const kb = override ? Number(override) : DEFAULT_LIMIT_KB;
  if (!Number.isFinite(kb) || kb <= 0) {
    throw new Error(`Invalid CHECK_SIZE_LIMIT_KB value: ${override}`);
  }
  return kb * 1024;
})();

/** Extract statically-referenced JS/CSS asset paths from an HTML file. */
function extractHtmlAssets(html) {
  const assets = [];
  const re = /(?:src|href)="([^"]+\.(?:js|css))"/g;
  let m;
  while ((m = re.exec(html))) {
    assets.push(m[1]);
  }
  return assets;
}

/**
 * Extract statically/dynamically imported local module paths from a JS file's
 * source text: `from "./chunks/x.js"`, `import "./x.js"`, `import("./x.js")`.
 */
function extractJsImports(source) {
  const imports = [];
  const patterns = [
    /\bfrom\s*["']([^"']+\.js)["']/g,
    /\bimport\s*["']([^"']+\.js)["']/g,
    /\bimport\(\s*["']([^"']+\.js)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) {
      imports.push(m[1]);
    }
  }
  return imports;
}

/** Resolve an asset path referenced from HTML (root-relative, e.g. "/chunks/x.js") or from a JS file (relative, e.g. "./chunks/y.js"). */
function resolveAssetPath(refPath, fromFile) {
  if (refPath.startsWith('/')) {
    return join(OUTPUT_DIR, refPath.slice(1));
  }
  return resolve(dirname(fromFile), refPath);
}

/**
 * Walk all assets reachable from an entry HTML file: direct <script>/<link>
 * references, plus JS files those scripts statically/dynamically import,
 * followed recursively. Returns a Map<absPath, sizeBytes>.
 */
async function collectAssets(htmlPath) {
  const html = await readFile(htmlPath, 'utf8');
  const entryRefs = extractHtmlAssets(html);

  const visited = new Map(); // absPath -> size
  const queue = entryRefs.map((ref) => resolveAssetPath(ref, htmlPath));

  while (queue.length > 0) {
    const absPath = queue.shift();
    if (visited.has(absPath)) continue;

    let size;
    try {
      const st = await stat(absPath);
      size = st.size;
    } catch {
      // Asset referenced but missing on disk; skip (shouldn't happen post-build).
      continue;
    }
    visited.set(absPath, size);

    if (absPath.endsWith('.js')) {
      const source = await readFile(absPath, 'utf8');
      for (const ref of extractJsImports(source)) {
        const resolved = resolveAssetPath(ref, absPath);
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  return visited;
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function relPath(absPath) {
  return absPath.startsWith(OUTPUT_DIR) ? absPath.slice(OUTPUT_DIR.length + 1) : absPath;
}

async function main() {
  const popupHtml = join(OUTPUT_DIR, 'popup.html');
  const optionsHtml = join(OUTPUT_DIR, 'options.html');
  const backgroundJs = join(OUTPUT_DIR, 'background.js');

  const popupAssets = await collectAssets(popupHtml);
  const optionsAssets = await collectAssets(optionsHtml);

  let popupTotal = 0;
  console.log('Popup bundle (JS+CSS loaded by popup.html):');
  console.log('----------------------------------------------------');
  for (const [path, size] of popupAssets) {
    popupTotal += size;
    console.log(`  ${relPath(path).padEnd(40)} ${formatKb(size)}`);
  }
  console.log('----------------------------------------------------');
  console.log(`  TOTAL${' '.repeat(35)} ${formatKb(popupTotal)}`);
  console.log('');

  let optionsTotal = 0;
  for (const size of optionsAssets.values()) optionsTotal += size;

  let backgroundSize = 0;
  try {
    backgroundSize = (await stat(backgroundJs)).size;
  } catch {
    // no background.js; leave at 0
  }

  console.log('Info only (does not affect exit code):');
  console.log(`  background.js total: ${formatKb(backgroundSize)}`);
  console.log(`  options.html total:  ${formatKb(optionsTotal)}`);
  console.log('');
  console.log(`Limit: ${formatKb(LIMIT_BYTES)} (SC-010${process.env.CHECK_SIZE_LIMIT_KB ? ', CHECK_SIZE_LIMIT_KB override' : ''})`);

  if (popupTotal > LIMIT_BYTES) {
    console.error(`FAIL: popup bundle ${formatKb(popupTotal)} exceeds limit ${formatKb(LIMIT_BYTES)}`);
    process.exit(1);
  }

  console.log(`OK: popup bundle ${formatKb(popupTotal)} is within limit ${formatKb(LIMIT_BYTES)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
