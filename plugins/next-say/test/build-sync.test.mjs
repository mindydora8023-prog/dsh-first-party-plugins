/**
 * Guard: lib/client.js must match the template and the modules it inlines.
 *
 * Why this test exists. The bundle is built by a MANUAL python step
 * (tools/build-client.py), and forgetting it fails silently. The browser loads
 * exactly one file per plugin -- lib/client.js -- so editing lib/match.js or
 * lib/ghost.js without rebuilding leaves the OLD implementation shipping, while
 * every other test keeps passing because those tests import the source modules
 * directly. Nothing in the suite would have noticed.
 *
 * So this test renders the bundle in memory (`--check`) and compares it with the
 * checked-in file, writing nothing. It also pins the failure mode: when a source
 * module changes, `--check` must report the staleness and exit non-zero rather
 * than quietly returning success.
 *
 * Interpreter selection uses DSH_PYTHON, then PYTHON, then python on PATH. When neither is available the test
 * SKIPS rather than failing, because a machine without python cannot run the
 * build at all -- but a skip is visible in the counts, unlike a silent pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'build-client.py');
const OUTPUT = join(ROOT, 'lib', 'client.js');
const MATCH = join(ROOT, 'lib', 'match.js');
const GHOST = join(ROOT, 'lib', 'ghost.js');

/** Explicit interpreter path or executable name, then PATH. */
function pythonPath() {
  return process.env.DSH_PYTHON || process.env.PYTHON || 'python';
}

/**
 * Run the build script and capture its output.
 * @returns {{available: boolean, status?: number|null, stdout?: string, stderr?: string}}
 */
function runBuild(args, script = SCRIPT) {
  const result = spawnSync(pythonPath(), ['-B', script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    // A hung python would otherwise stall the suite with no message.
    timeout: 30000,
  });
  if (result.error) {
    // ENOENT means no python at all, which is a skip, not a failure.
    if (result.error.code === 'ENOENT') return { available: false };
    throw result.error;
  }
  if (result.status === null) return { available: false };
  return {
    available: true,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

const probe = runBuild(['--check']);
const skipReason = probe.available ? '' : 'python is not available on this machine';

test('the checked-in bundle is up to date with its sources', (t) => {
  if (!probe.available) {
    t.skip(skipReason);
    return;
  }
  assert.equal(
    probe.status,
    0,
    'tools/build-client.py --check failed, so lib/client.js is stale.\n' +
      `stdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
  );
  assert.match(probe.stdout, /up to date/);
});

test('--check writes nothing', (t) => {
  if (!probe.available) {
    t.skip(skipReason);
    return;
  }
  // Snapshot, re-run, compare. A check that rewrote the file would hide the very
  // staleness it is supposed to report.
  const before = readFileSync(OUTPUT, 'utf8');
  const again = runBuild(['--check']);
  const after = readFileSync(OUTPUT, 'utf8');
  assert.equal(again.status, 0);
  assert.equal(after, before, '--check must not modify lib/client.js');
});

test('--check reports staleness when an inlined source changes', (t) => {
  if (!probe.available) {
    t.skip(skipReason);
    return;
  }
  // Append a harmless comment to a module the bundle inlines. The rendered
  // output must change, so --check has to notice. Restored in `finally`.
  const original = readFileSync(MATCH, 'utf8');
  try {
    writeFileSync(MATCH, `${original.trimEnd()}\n// staleness probe\n`, 'utf8');
    const stale = runBuild(['--check']);
    assert.equal(stale.status, 1, 'a changed source must make --check exit 1');
    assert.match(stale.stderr, /STALE/);
    assert.match(stale.stderr, /first difference at line \d+/);
    assert.match(stale.stderr, /Run: python tools\/build-client\.py/);
  } finally {
    writeFileSync(MATCH, original, 'utf8');
  }

  // And the guard must clear again, or the assertion above would be vacuous.
  const clean = runBuild(['--check']);
  assert.equal(clean.status, 0, 'restoring the source must make --check pass again');
});

test('locale checks catch generator edits without rewriting the output', (t) => {
  if (!probe.available) return t.skip(skipReason);
  const script = join(ROOT, 'tools', 'make-locales.py');
  const locales = join(ROOT, 'lib', 'locales.js');
  const original = readFileSync(script, 'utf8');
  const before = readFileSync(locales);
  assert.equal(runBuild(['--check'], script).status, 0);
  try {
    const changed = original.replace('Next-say suggestions', 'Next-say suggestions changed');
    assert.notEqual(changed, original);
    writeFileSync(script, changed, 'utf8');
    const stale = runBuild(['--check'], script);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE/);
    assert.deepEqual(readFileSync(locales), before);
  } finally {
    writeFileSync(script, original, 'utf8');
  }
  assert.equal(runBuild(['--check'], script).status, 0);
});

test('client check detects CRLF byte changes', (t) => {
  if (!probe.available) return t.skip(skipReason);
  const original = readFileSync(OUTPUT);
  try {
    writeFileSync(OUTPUT, original.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    assert.equal(runBuild(['--check']).status, 1);
  } finally {
    writeFileSync(OUTPUT, original);
  }
});

test('a missing inlined source is a clean build error, not a traceback', (t) => {
  if (!probe.available) {
    t.skip(skipReason);
    return;
  }
  // Renaming a module the template inlines is the realistic version of this: a
  // refactor that forgets the marker. The build must fail cleanly.
  const aside = `${GHOST}.aside`;
  try {
    renameSync(GHOST, aside);
    const broken = runBuild(['--check']);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /missing/);
    assert.ok(!broken.stderr.includes('Traceback'), 'a build failure must not print a traceback');
  } finally {
    if (existsSync(aside)) renameSync(aside, GHOST);
    rmSync(`${GHOST}.aside`, { force: true });
  }
});
