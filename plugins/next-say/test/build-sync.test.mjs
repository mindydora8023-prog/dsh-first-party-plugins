/** Build synchronization contracts; mutation probes use isolated copies only. */
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
  const root = mkdtempSync(join(tmpdir(), 'next-say-build-sync-'));
  try {
    for (const dir of ['client', 'lib']) mkdirSync(join(root, dir));
    for (const file of [
      'client/bundle.json',
      'client/locales.json',
      'client/template.js',
      'client/http.js',
      'client/hooks.js',
      'client/ghost-painter.js',
      'client/settings-page.js',
      'lib/config-schema.js',
      'lib/match.js',
      'lib/ghost.js',
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

function snapshot(path) {
  return { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs };
}

test('the checked-in bundle is up to date with its sources', () => {
  const output = join(ROOT, 'lib', 'client.js');
  const before = snapshot(output);
  const result = runBuild(ROOT, ['--check']);
  assert.deepEqual(snapshot(output), before, '--check must not write the checked-in bundle');
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /up to date/);
});

test('--check writes nothing', () => {
  withFixture((root) => {
    const output = join(root, 'lib', 'client.js');
    const before = snapshot(output);
    const result = runBuild(root, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(output), before, '--check must not modify lib/client.js');
  });
});

test('--check reports staleness when an inlined source changes', () => {
  withFixture((root) => {
    const match = join(root, 'lib', 'match.js');
    const output = join(root, 'lib', 'client.js');
    const original = readFileSync(match, 'utf8');
    const before = snapshot(output);
    writeFileSync(match, `${original.trimEnd()}\n// staleness probe\n`, 'utf8');
    const stale = runBuild(root, ['--check']);
    assert.equal(stale.status, 1, 'a changed source must make --check exit 1');
    assert.match(stale.stderr, /STALE/);
    assert.match(stale.stderr, /first difference at line \d+/);
    assert.match(stale.stderr, /Run: node tools\/build-client\.mjs/);
    assert.deepEqual(snapshot(output), before, 'stale --check must not modify the bundle');
    writeFileSync(match, original, 'utf8');
    const clean = runBuild(root, ['--check']);
    assert.equal(clean.status, 0, 'restoring the source must make --check pass again');
  });
});

test('a missing inlined source is a clean build error, not a stack trace', () => {
  withFixture((root) => {
    rmSync(join(root, 'lib', 'ghost.js'));
    const broken = runBuild(root, ['--check']);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /missing/);
    assert.ok(!broken.stderr.includes('Traceback'), 'a build failure must not print a traceback');
  });
});
