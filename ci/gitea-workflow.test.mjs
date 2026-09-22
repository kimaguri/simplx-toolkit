// LAB-263 T205: RED-first test for the Gitea PR gate workflow.
// Asserts .gitea/workflows/pr.yml exists, wires the simplx/dotgithub reusable
// checks correctly for this Go repo (no test/typecheck/lint/build commands —
// the Gitea job image has no Go toolchain, same gap as on GitHub today), and
// that we did not touch any GitHub-only release/publish files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const prYmlPath = path.join(repoRoot, '.gitea', 'workflows', 'pr.yml');

test('.gitea/workflows/pr.yml exists', () => {
  assert.equal(fs.existsSync(prYmlPath), true, 'pr.yml must exist');
});

test('pr.yml references the simplx/dotgithub reusable checks', () => {
  const text = fs.readFileSync(prYmlPath, 'utf8');
  assert.match(text, /uses:\s*simplx\/dotgithub\/\.gitea\/workflows\/pr-meta\.yml@main/);
  assert.match(text, /uses:\s*simplx\/dotgithub\/\.gitea\/workflows\/pr-quality\.yml@main/);
});

test('pr.yml triggers only on pull_request to main', () => {
  const text = fs.readFileSync(prYmlPath, 'utf8');
  assert.match(text, /on:\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main\]/);
});

test('pr.yml passes secrets: inherit to the meta call', () => {
  const text = fs.readFileSync(prYmlPath, 'utf8');
  const metaBlockMatch = text.match(/meta:\s*\n([\s\S]*?)(?:\n {2}\S|\n*$)/);
  assert.ok(metaBlockMatch, 'meta job block must exist');
  assert.match(metaBlockMatch[1], /secrets:\s*inherit/);
});

test('pr.yml quality call sets pnpm_version + install_cmd but no Go command overrides', () => {
  const text = fs.readFileSync(prYmlPath, 'utf8');
  const qualityBlockMatch = text.match(/quality:\s*\n([\s\S]*)/);
  assert.ok(qualityBlockMatch, 'quality job block must exist');
  const qualityBlock = qualityBlockMatch[1];

  const pnpmVersionMatch = qualityBlock.match(/pnpm_version:\s*["']?([^"'\n]+)["']?/);
  assert.ok(pnpmVersionMatch, 'pnpm_version must be set');
  assert.notEqual(pnpmVersionMatch[1].trim(), '');

  assert.match(qualityBlock, /install_cmd:\s*["']?true["']?/);

  for (const key of ['typecheck_cmd', 'lint_cmd', 'test_cmd', 'build_cmd']) {
    const re = new RegExp(`${key}:\\s*["']?\\S+["']?`);
    assert.equal(re.test(qualityBlock), false, `${key} must be empty or absent`);
  }
});

test('.gitea/workflows/ does not carry release or publish workflows', () => {
  const giteaDir = path.join(repoRoot, '.gitea', 'workflows');
  const entries = fs.existsSync(giteaDir) ? fs.readdirSync(giteaDir) : [];
  assert.equal(entries.includes('release.yml'), false);
  assert.equal(entries.includes('publish-simplx-mcp.yml'), false);
});

test('GitHub release/publish workflows and .goreleaser.yml are unchanged vs origin/main', () => {
  const unchangedPaths = [
    '.github/workflows/release.yml',
    '.github/workflows/publish-simplx-mcp.yml',
    '.goreleaser.yml',
  ];
  for (const relPath of unchangedPaths) {
    assert.doesNotThrow(
      () =>
        execFileSync('/usr/bin/git', ['diff', '--quiet', 'origin/main', '--', relPath], {
          cwd: repoRoot,
        }),
      `${relPath} must be byte-identical to origin/main`,
    );
  }
});
