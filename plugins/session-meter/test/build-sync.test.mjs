/** Build synchronization contracts for session-meter; mutations stay in temp fixtures. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = existsSync(resolve(ROOT, '..', 'tools', 'build-client.mjs'))
  ? resolve(ROOT, '..', 'tools', 'build-client.mjs')
  : resolve(ROOT, '..', '..', 'tools', 'build-client.mjs');

function runBuild(root, args) {
  const result = spawnSync(process.execPath, [BUILDER, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `build terminated: ${result.signal}`);
  return result;
}

function withFixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'session-meter-build-sync-'));
  try {
    for (const dir of ['client', 'lib']) mkdirSync(join(root, dir));
    for (const file of [
      'client/bundle.json',
      'client/locales.json',
      'client/template.js',
      'client/pricing.js',
      'client/live-prices.js',
      'client/cost.js',
      'client/ledger.js',
      'client/export.js',
      'client/ui.js',
      'lib/model-names.js',
      'lib/report.js',
    ]) {
      copyFileSync(join(ROOT, file), join(root, file));
    }
    const built = runBuild(root, []);
    assert.equal(built.status, 0, built.stderr);
    return work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshot(file) {
  return { bytes: readFileSync(file), mtimeMs: statSync(file).mtimeMs };
}

test('the checked-in session-meter bundle is up to date with its sources', () => {
  const output = join(ROOT, 'lib', 'client.js');
  const before = snapshot(output);
  const result = runBuild(ROOT, ['--check']);
  assert.deepEqual(snapshot(output), before, '--check must not modify lib/client.js');
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /up to date/);
});

test('--check reports staleness when a modular client source changes', () => {
  withFixture((root) => {
    const costFile = join(root, 'client', 'cost.js');
    const output = join(root, 'lib', 'client.js');
    const original = readFileSync(costFile, 'utf8');
    const before = snapshot(output);
    writeFileSync(costFile, `${original.trimEnd()}\n// staleness probe\n`, 'utf8');
    const stale = runBuild(root, ['--check']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE/);
    assert.deepEqual(snapshot(output), before);
    writeFileSync(costFile, original, 'utf8');
    const clean = runBuild(root, ['--check']);
    assert.equal(clean.status, 0);
  });
});
