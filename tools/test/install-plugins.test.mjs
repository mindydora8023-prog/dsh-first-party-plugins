import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkSpec } from '../install-plugins.mjs';
import { discoverPlugins } from '../plugins.mjs';

const cli = fileURLToPath(new URL('../install-plugins.mjs', import.meta.url));
const plugins = discoverPlugins();
const filekit = 'dsh-plugin-filekit';
const nextSay = 'dsh-plugin-next-say';
const existing = {
  name: 'test-profile',
  dependencies: { unrelated: '1.2.3' },
  scripts: { start: 'dsh' },
  dsh: {
    enabled: true,
    profile: { bundles: ['unrelated', 'another-bundle'], settings: { theme: 'dark' } },
  },
};

function fixture(t, config = existing) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'dsh profile \u8def\u5f84-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'package.json');
  const original = typeof config === 'string' ? config : JSON.stringify(config) + '\r\n';
  fs.writeFileSync(file, original);
  return {
    directory, file, original,
    text: () => fs.readFileSync(file, 'utf8'),
    config: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    files: () => fs.readdirSync(directory).sort(),
    backups: () => fs.readdirSync(directory).filter((name) => name.startsWith('package.json.bak.')),
  };
}

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', input: '', timeout: 10000, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  return result;
}

function success(...args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function specFor(name) {
  return linkSpec(plugins.find(({ manifest }) => manifest.name === name).directory);
}

test('lists the eight shipped manifests and their requirements', () => {
  const output = success('--list');
  assert.equal(plugins.length, 8);
  assert.equal(output.match(/^  Node\.js .+ DSH .+ npm dependencies: none$/gm).length, 8);
  for (const { id, manifest } of plugins) {
    assert.ok(output.includes(`${id} ${manifest.version} (${manifest.name})`));
    assert.ok(output.includes(manifest.description));
    if (manifest.engines.dsh) assert.ok(output.includes(manifest.engines.dsh));
  }
});

test('installation merges into an existing profile and backs up its original bytes', (t) => {
  const profile = fixture(t);
  const output = success('--profile', profile.directory, '--plugins', `filekit, ${nextSay}`, '--link');
  assert.deepEqual(profile.config(), {
    ...existing,
    dependencies: { ...existing.dependencies, [filekit]: specFor(filekit), [nextSay]: specFor(nextSay) },
    dsh: { ...existing.dsh, profile: { ...existing.dsh.profile, bundles: [...existing.dsh.profile.bundles, filekit, nextSay] } },
  });
  const [backup] = profile.backups();
  assert.match(backup, /^package\.json\.bak\.\d+$/);
  assert.equal(profile.backups().length, 1);
  assert.ok(output.includes(path.join(profile.directory, backup)));
  assert.equal(fs.readFileSync(path.join(profile.directory, backup), 'utf8'), profile.original);
});

test('installing all creates missing sections and repeated installation leaves all bytes untouched', (t) => {
  const profile = fixture(t, { name: 'empty-profile', dsh: { enabled: false } });
  success('--profile', profile.file, '--all');
  const after = profile.text();
  const backups = profile.backups();
  assert.deepEqual(profile.config(), {
    name: 'empty-profile',
    dependencies: Object.fromEntries(plugins.map(({ manifest }) => [manifest.name, specFor(manifest.name)])),
    dsh: { enabled: false, profile: { bundles: plugins.map(({ manifest }) => manifest.name) } },
  });
  assert.match(success('--profile', profile.file, '--all'), /already up to date/);
  assert.equal(profile.text(), after);
  assert.deepEqual(profile.backups(), backups);
});

test('installation replaces only the selected dependency and does not duplicate an existing bundle', (t) => {
  const config = {
    ...existing,
    dependencies: { ...existing.dependencies, [filekit]: '0.1.0', [nextSay]: '0.2.0' },
    dsh: { ...existing.dsh, profile: { ...existing.dsh.profile, bundles: [filekit, ...existing.dsh.profile.bundles, nextSay] } },
  };
  const profile = fixture(t, config);
  success('--profile', profile.file, '--plugins', `filekit,${filekit},filekit`);
  assert.deepEqual(profile.config(), { ...config, dependencies: { ...config.dependencies, [filekit]: specFor(filekit) } });
});

test('uninstall removes selected dependencies and every matching bundle only', (t) => {
  const profile = fixture(t, {
    ...existing,
    dependencies: { ...existing.dependencies, [filekit]: '0.4.0', [nextSay]: specFor(nextSay) },
    dsh: { ...existing.dsh, profile: { ...existing.dsh.profile, bundles: [filekit, ...existing.dsh.profile.bundles, filekit, nextSay] } },
  });
  success('--profile', profile.directory, '--uninstall', 'filekit');
  assert.deepEqual(profile.config(), {
    ...existing,
    dependencies: { ...existing.dependencies, [nextSay]: specFor(nextSay) },
    dsh: { ...existing.dsh, profile: { ...existing.dsh.profile, bundles: [...existing.dsh.profile.bundles, nextSay] } },
  });
  assert.equal(profile.backups().length, 1);
  assert.match(success('--profile', profile.directory, '--uninstall', filekit), /already up to date/);
  assert.equal(profile.backups().length, 1);
});

test('rollback infers the profile, restores its exact bytes and backs up the discarded version', (t) => {
  const profile = fixture(t, '\uFEFF' + JSON.stringify(existing, null, '\t').replaceAll('\n', '\r\n') + '\r\n');
  success('--profile', profile.file, '--plugins', 'filekit');
  const installed = profile.text();
  const [backup] = profile.backups();
  success('--rollback', path.join(profile.directory, backup));
  assert.equal(profile.text(), profile.original);
  const [newBackup] = profile.backups().filter((name) => name !== backup);
  assert.equal(fs.readFileSync(path.join(profile.directory, newBackup), 'utf8'), installed);
});

test('rollback can recover an invalid profile and rejects an invalid backup', (t) => {
  const profile = fixture(t);
  success('--profile', profile.file, '--plugins', 'filekit');
  const [backup] = profile.backups();
  fs.writeFileSync(profile.file, '{broken');
  const renamed = path.join(profile.directory, 'copied-backup.json');
  fs.copyFileSync(path.join(profile.directory, backup), renamed);
  fs.writeFileSync(path.join(profile.directory, backup), 'null');
  const invalid = run('--rollback', path.join(profile.directory, backup));
  assert.equal(invalid.status, 1);
  assert.equal(profile.text(), '{broken');
  assert.equal(profile.backups().length, 1);
  success('--profile', profile.file, '--rollback', renamed);
  assert.equal(profile.text(), profile.original);
});

test('install dry-run shows the dependency and bundle changes without writing anything', (t) => {
  const profile = fixture(t);
  const output = success('--profile', profile.file, '--plugins', 'filekit', '--dry-run');
  const changes = JSON.parse(output.slice(output.indexOf('\n') + 1));
  assert.deepEqual(changes, {
    dependencies: { [filekit]: { before: null, after: specFor(filekit) } },
    'dsh.profile.bundles': { before: existing.dsh.profile.bundles, after: [...existing.dsh.profile.bundles, filekit] },
  });
  assert.equal(profile.text(), profile.original);
  assert.deepEqual(profile.files(), ['package.json']);
});

test('uninstall and rollback dry-runs keep the profile and its backups untouched', (t) => {
  const profile = fixture(t);
  success('--profile', profile.file, '--plugins', 'filekit');
  const [backup] = profile.backups();
  const installed = profile.text();
  const uninstall = success('--profile', profile.file, '--uninstall', 'filekit', '--dry-run');
  assert.deepEqual(JSON.parse(uninstall.slice(uninstall.indexOf('\n') + 1)).dependencies, {
    [filekit]: { before: specFor(filekit), after: null },
  });
  assert.match(success('--rollback', path.join(profile.directory, backup), '--dry-run'), /restore the complete profile/);
  assert.equal(profile.text(), installed);
  assert.deepEqual(profile.files(), ['package.json', backup]);
  assert.equal(fs.readFileSync(path.join(profile.directory, backup), 'utf8'), profile.original);
});

test('unknown names, malformed lists and conflicting flags are rejected before any change', (t) => {
  const profile = fixture(t);
  for (const args of [
    ['--plugins', 'filekit,../github'], ['--plugins', 'filekit,'], ['--uninstall', 'constructor'],
    ['--plugins', 'filekit', '--all'],
  ]) {
    const result = run('--profile', profile.file, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown plugin|Use only one/);
  }
  assert.equal(profile.text(), profile.original);
  assert.deepEqual(profile.files(), ['package.json']);
});

test('non-interactive use requires a profile and an explicit selection', (t) => {
  const profile = fixture(t);
  const missingProfile = run('--all');
  const missingSelection = run('--profile', profile.file);
  assert.equal(missingProfile.status, 1);
  assert.match(missingProfile.stderr, /Specify --profile/);
  assert.equal(missingSelection.status, 1);
  assert.match(missingSelection.stderr, /Specify --plugins or --all/);
  assert.deepEqual(profile.files(), ['package.json']);
});

test('unsupported configuration shapes are rejected without overwriting existing settings', (t) => {
  const profile = fixture(t, { ...existing, dsh: { profile: { bundles: 'existing-bundle' } } });
  const result = run('--profile', profile.file, '--all');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dsh.profile.bundles must be an array/);
  assert.equal(profile.text(), profile.original);
  assert.deepEqual(profile.files(), ['package.json']);
});

test('another installer holding the profile lock prevents writes', (t) => {
  const profile = fixture(t);
  const lock = `${profile.file}.install-plugins.lock`;
  fs.writeFileSync(lock, '');
  const result = run('--profile', profile.file, '--all');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Profile is locked/);
  assert.equal(profile.text(), profile.original);
  assert.deepEqual(profile.files(), ['package.json', path.basename(lock)]);
});

test('absolute link specs handle POSIX, Windows drives and UNC paths', () => {
  assert.equal(linkSpec('/some path/plugins/filekit', path.posix), 'link:/some path/plugins/filekit');
  assert.equal(linkSpec('/with\\backslash/filekit', path.posix), 'link:/with\\backslash/filekit');
  assert.equal(linkSpec('X:\\some path\\plugins/filekit', path.win32), 'link:X:/some path/plugins/filekit');
  assert.equal(linkSpec('\\\\server\\share\\plugins\\filekit', path.win32), 'link://server/share/plugins/filekit');
  assert.throws(() => linkSpec('plugins/filekit', path.posix), /must be absolute/);
  assert.throws(() => linkSpec('X:plugins\\filekit', path.win32), /must be absolute/);
});
