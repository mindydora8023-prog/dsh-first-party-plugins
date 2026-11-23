/**
 * Guard: every shared module shipped by this plugin must match `shared/` byte
 * for byte.
 *
 * WHY. Copies under `lib/` (such as `define.js`, `state-dir.js`,
 * `credential-guard.js`, `fs-access.js`, `escape.js`, `json-store.js`,
 * `http-utils.js`) are generated from the workspace `shared/` directory by
 * `node tools/sync-shared-code.mjs`. A `link:` plugin cannot reliably import
 * from the workspace root, so each plugin carries its own copy and this test
 * guarantees zero drift.
 *
 * Skips when the workspace `shared/` directory is absent (standalone checkout).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PLUGIN_ROOT, '..');
const SHARED_DIR = join(WORKSPACE_ROOT, 'shared');
const LIB_DIR = join(PLUGIN_ROOT, 'lib');

const SHARED_FILES = [
  'define.js',
  'state-dir.js',
  'credential-guard.js',
  'fs-access.js',
  'escape.js',
  'json-store.js',
  'http-utils.js',
];

function discoverPairs() {
  if (!existsSync(LIB_DIR)) return [];
  const present = new Set(readdirSync(LIB_DIR));
  return SHARED_FILES.filter((name) => present.has(name)).map((name) => [`shared/${name}`, `lib/${name}`]);
}

const pairs = discoverPairs();

test('plugin ships at least one shared module when shared-sync guard is installed', () => {
  assert.ok(pairs.length > 0, 'no shared/*.js module found under lib/; remove or populate shared-sync guard');
});

for (const [sourceRel, copyRel] of pairs) {
  test(`${copyRel} matches ${sourceRel}`, (t) => {
    const sourcePath = join(WORKSPACE_ROOT, sourceRel);
    if (!existsSync(SHARED_DIR) || !existsSync(sourcePath)) {
      t.skip('workspace shared/ is not present (standalone checkout)');
      return;
    }
    const source = readFileSync(sourcePath, 'utf8');
    const copy = readFileSync(join(PLUGIN_ROOT, copyRel), 'utf8');
    assert.equal(
      copy,
      source,
      `${copyRel} has drifted from ${sourceRel}. Do not hand-edit the copy: ` +
        'run `node tools/sync-shared-code.mjs` in the workspace root to regenerate it.',
    );
  });
}
