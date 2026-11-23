/** Pure-Node locale generation contracts. Every write stays inside a unique fixture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = existsSync(resolve(ROOT, '..', 'tools', 'build-client.mjs'))
  ? resolve(ROOT, '..', 'tools', 'build-client.mjs')
  : resolve(ROOT, '..', '..', 'tools', 'build-client.mjs');
const { renderLocalesModule } = await import(pathToFileURL(BUILDER).href);

function run(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `child terminated: ${result.signal}`);
  return result;
}

function runBuilder(root, args = []) {
  return run(process.execPath, [BUILDER, '--root', root, ...args], root);
}

function withFixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'next-say-locales-sync-'));
  try {
    mkdirSync(join(root, 'client'));
    mkdirSync(join(root, 'lib'));
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
      const p = join(dir, item.name);
      const stat = statSync(p);
      entries.push([relative, stat.mtimeMs, item.isDirectory() ? null : readFileSync(p).toString('base64')]);
      if (item.isDirectory()) visit(p, `${relative}/`);
    }
  }
  visit(root);
  return entries;
}

test('the checked-in locales are up to date without writing them', () => {
  const output = join(ROOT, 'lib', 'locales.js');
  const before = { bytes: readFileSync(output), mtimeMs: statSync(output).mtimeMs };
  const checked = runBuilder(ROOT, ['--check']);
  const after = { bytes: readFileSync(output), mtimeMs: statSync(output).mtimeMs };
  assert.deepEqual(after, before, '--check must not write the checked-in locales');
  assert.equal(checked.status, 0, `stdout: ${checked.stdout}\nstderr: ${checked.stderr}`);
  assert.match(checked.stdout, /lib\/locales\.js is up to date/);
});

test('--check of synchronized locales writes no files or timestamps', () => {
  withFixture((root, output) => {
    const built = runBuilder(root);
    assert.equal(built.status, 0, built.stderr);
    utimesSync(output, new Date(1000000), new Date(1000000));
    const before = snapshot(root);
    const checked = runBuilder(root, ['--check']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(snapshot(root), before);
  });
});

test('--check reports stale locales without repairing them', () => {
  withFixture((root, output) => {
    const built = runBuilder(root);
    assert.equal(built.status, 0, built.stderr);
    writeFileSync(output, '// stale fixture\n', 'ascii');
    const before = snapshot(root);
    const checked = runBuilder(root, ['--check']);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /STALE/);
    assert.deepEqual(snapshot(root), before);
  });
});

test('--check reports missing locales without creating them', () => {
  withFixture((root, output) => {
    const before = snapshot(root);
    const checked = runBuilder(root, ['--check']);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /lib\/locales\.js is missing/);
    assert.ok(!existsSync(output));
    assert.deepEqual(snapshot(root), before);
  });
});

test('render round-trips quotes, controls, Unicode and non-BMP characters in JavaScript', () => {
  withFixture((root) => {
    const key = 'key"\\\n\u{1f511}';
    const value = 'double " single \' slash \\ controls \u0000\b\t\n\f\r\u001f Chinese \u4e2d\u6587 emoji \u{1f600} separators \u2028\u2029';
    writeFileSync(
      join(root, 'client', 'locales.json'),
      JSON.stringify({ zh: { [key]: value }, en: { [key]: value } }, null, 2),
      'utf8',
    );
    const rendered = renderLocalesModule(root, {
      source: 'client/locales.json',
      output: 'lib/locales.js',
      exportName: 'LOCALES',
    });
    assert.ok(!/[^\x00-\x7f]|\r/.test(rendered), 'render must be pure ASCII with LF newlines');
    assert.match(rendered, /\\ud83d\\ude00/);
    const evaluate = 'import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(m.LOCALES)))';
    const imported = run(
      process.execPath,
      ['--input-type=module', '-e', evaluate, `data:text/javascript;base64,${Buffer.from(rendered).toString('base64')}`],
      root,
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), { zh: { [key]: value }, en: { [key]: value } });
  });
});

test('zh and en locale dictionaries have identical key sets including manualBudget', () => {
  const dict = JSON.parse(readFileSync(join(ROOT, 'client', 'locales.json'), 'utf8'));
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());
  assert.equal(typeof dict.zh.manualBudget, 'string');
  assert.equal(typeof dict.en.manualBudget, 'string');
  assert.ok(dict.zh.manualBudget.length > 0 && dict.en.manualBudget.length > 0);
});
