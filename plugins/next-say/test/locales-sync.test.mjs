/** Locale generation contracts. Every write stays inside a unique fixture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function pythonCommand() {
  const fromEnv = process.env.DSH_PYTHON || process.env.PYTHON;
  if (fromEnv) return fromEnv;
  const bundled = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON = pythonCommand();
const availability = spawnSync(PYTHON, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
if (availability.error && availability.error.code !== 'ENOENT') throw availability.error;
const skip = availability.error?.code === 'ENOENT' ? 'python is not available on this machine' : false;
if (!skip) assert.equal(availability.status, 0, availability.stderr);

function run(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `child terminated: ${result.signal}`);
  return result;
}

function generate(root, args = []) {
  return run(PYTHON, [join(root, 'tools', 'make-locales.py'), ...args], root);
}

function withFixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'next-say-locales-sync-'));
  try {
    mkdirSync(join(root, 'tools'));
    mkdirSync(join(root, 'lib'));
    copyFileSync(join(ROOT, 'tools', 'make-locales.py'), join(root, 'tools', 'make-locales.py'));
    return work(root, join(root, 'lib', 'locales.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshot(root) {
  const entries = [];
  function visit(dir, prefix = '') {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + item.name;
      const path = join(dir, item.name);
      const stat = statSync(path);
      entries.push([relative, stat.mtimeMs, item.isDirectory() ? null : readFileSync(path).toString('base64')]);
      if (item.isDirectory()) visit(path, `${relative}/`);
    }
  }
  visit(root);
  return entries;
}

function seed(root) {
  const written = generate(root, ['--write']);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, '');
}

test('the checked-in locales are up to date without writing them', { skip }, () => {
  const output = join(ROOT, 'lib', 'locales.js');
  const before = { bytes: readFileSync(output), mtimeMs: statSync(output).mtimeMs };
  const checked = generate(ROOT, ['--check']);
  const after = { bytes: readFileSync(output), mtimeMs: statSync(output).mtimeMs };
  assert.deepEqual(after, before, '--check must not write the checked-in locales');
  assert.equal(checked.status, 0, `stdout: ${checked.stdout}\nstderr: ${checked.stderr}`);
  assert.match(checked.stdout, /up to date/);
});

test('default stdout and explicit --write share the same render', { skip }, () => {
  withFixture((root, output) => {
    const before = snapshot(root);
    const printed = generate(root);
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(snapshot(root), before, 'default mode must only write stdout');
    assert.ok(!existsSync(output));
    assert.match(printed.stdout, /export const LOCALES/);
    assert.ok(!/[^\x00-\x7f]|\r/.test(printed.stdout), 'render must be ASCII with LF newlines');
    seed(root);
    assert.equal(readFileSync(output, 'utf8'), printed.stdout);
    const checked = generate(root, ['--check']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /up to date/);
  });
});

test('--check of synchronized locales writes no files or timestamps', { skip }, () => {
  withFixture((root, output) => {
    seed(root);
    utimesSync(output, new Date(1000000), new Date(1000000));
    const before = snapshot(root);
    const checked = generate(root, ['--check']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(snapshot(root), before);
  });
});

test('--check reports stale locales without repairing them', { skip }, () => {
  withFixture((root, output) => {
    seed(root);
    writeFileSync(output, '// stale fixture\n', 'ascii');
    const before = snapshot(root);
    const checked = generate(root, ['--check']);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /STALE.*lib\/locales\.js/);
    assert.match(checked.stderr, /make-locales\.py --write/);
    assert.deepEqual(snapshot(root), before);
  });
});

test('--check reports missing locales without creating them', { skip }, () => {
  withFixture((root, output) => {
    const before = snapshot(root);
    const checked = generate(root, ['--check']);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /lib\/locales\.js is missing/);
    assert.ok(!checked.stderr.includes('Traceback'));
    assert.ok(!existsSync(output));
    assert.deepEqual(snapshot(root), before);
  });
});

test('render round-trips quotes, controls, Unicode and non-BMP characters in JavaScript', { skip }, () => {
  withFixture((root) => {
    const key = 'key"\\\n\u{1f511}';
    const value = 'double " single \' slash \\ controls \u0000\b\t\n\f\r\u001f Chinese \u4e2d\u6587 emoji \u{1f600} separators \u2028\u2029';
    const script = [
      'import json, runpy, sys',
      'module = runpy.run_path(sys.argv[1])',
      'table = json.loads(sys.argv[2])',
      'module["ZH"].clear(); module["ZH"].update(table)',
      'module["EN"].clear(); module["EN"].update(table)',
      'sys.stdout.buffer.write(module["render"]().encode("ascii"))',
    ].join('\n');
    const before = snapshot(root);
    const rendered = run(PYTHON, ['-c', script, join(root, 'tools', 'make-locales.py'), JSON.stringify({ [key]: value })], root);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(!/[^\x00-\x7f]/.test(rendered.stdout));
    assert.match(rendered.stdout, /\\ud83d\\ude00/);
    const evaluate = 'import(process.argv[1]).then(m => process.stdout.write(JSON.stringify({locales:m.LOCALES,count:m.KEY_COUNT})))';
    const imported = run(process.execPath, ['--input-type=module', '-e', evaluate,
      `data:text/javascript;base64,${Buffer.from(rendered.stdout).toString('base64')}`], root);
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), { locales: { zh: { [key]: value }, en: { [key]: value } }, count: 1 });
    assert.deepEqual(snapshot(root), before, 'render/import must leave the fixture untouched');
  });
});
