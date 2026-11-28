/**
 * Guard: every shared module shipped by this plugin must match `shared/` byte
 * for byte.
 *
 * WHY. Copies under `lib/` (such as `define.js`, `state-dir.js`,
 * `credential-guard.js`, `fs-access.js`, `escape.js`, `json-store.js`,
 * `http-utils.js`) are copied from the workspace `plugins/shared/` directory.
 * A `link:` plugin cannot reliably import
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
const monorepo = existsSync(join(WORKSPACE_ROOT, '..', 'tools', 'test.mjs'));

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
    if (!monorepo && !existsSync(SHARED_DIR)) {
      t.skip('workspace shared/ is not present (standalone checkout)');
      return;
    }
    assert.ok(existsSync(sourcePath), `missing plugins/${sourceRel}`);
    const source = readFileSync(sourcePath);
    const copy = readFileSync(join(PLUGIN_ROOT, copyRel));
    assert.ok(
      copy.equals(source),
      `${copyRel} has drifted from plugins/${sourceRel}. Copy the canonical file to regenerate it.`,
    );
  });
}
