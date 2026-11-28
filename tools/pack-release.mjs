import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { discoverPlugins, root } from './plugins.mjs';

const destination = path.join(root, 'dist', 'releases');
const packArgs = ['pack', '--json', '--ignore-scripts', '--offline'];

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packPlugin({ id, directory, manifest }, staging) {
  const windows = process.platform === 'win32';
  // On Windows npm is a batch shim. Keep its command line static and pass paths separately.
  const result = spawnSync(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/c', 'npm', ...packArgs] : packArgs, {
    cwd: directory,
    env: { ...process.env, npm_config_pack_destination: staging, npm_config_cache: path.join(staging, 'cache') },
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${id}: npm pack failed\n${result.error?.message ?? (result.stderr || result.stdout)}`);
  }

  const [pkg] = JSON.parse(result.stdout);
  if (pkg?.name !== manifest.name || pkg?.version !== manifest.version ||
      !/^[a-z0-9][a-z0-9._-]*\.tgz$/i.test(pkg.filename)) {
    throw new Error(`${id}: unexpected npm pack metadata`);
  }
  const files = new Set(pkg.files.map(({ path: file }) => file));
  for (const required of ['package.json', 'LICENSE', 'README.md', manifest.main, manifest.dsh?.bundle?.patch]) {
    if (required && !files.has(required.replace(/^\.\//, ''))) {
      throw new Error(`${id}: npm pack omitted ${required}`);
    }
  }
  const file = path.join(staging, pkg.filename);
  return {
    id,
    name: pkg.name,
    version: pkg.version,
    filename: pkg.filename,
    size: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

function packRelease(checkOnly) {
  if (!checkOnly) fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(checkOnly ? tmpdir() : path.dirname(destination), 'dsh-release-'));
  try {
    const plugins = discoverPlugins().map((plugin) => packPlugin(plugin, staging));
    if (plugins.length === 0 || new Set(plugins.map(({ filename }) => filename)).size !== plugins.length) {
      throw new Error('Expected one archive per plugin');
    }
    const metadata = {
      'SHA256SUMS.txt': plugins.map(({ filename, sha256: hash }) => `${hash}  ${filename}\n`).join(''),
      'manifest.json': JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + '\n',
    };

    if (checkOnly) {
      for (const { filename, sha256: hash } of plugins) {
        if (sha256(path.join(destination, filename)) !== hash) throw new Error(`${filename} differs from npm pack`);
      }
      for (const [filename, expected] of Object.entries(metadata)) {
        if (fs.readFileSync(path.join(destination, filename), 'utf8') !== expected) throw new Error(`${filename} is out of date`);
      }
    } else {
      for (const [filename, contents] of Object.entries(metadata)) fs.writeFileSync(path.join(staging, filename), contents);
      fs.mkdirSync(destination, { recursive: true });
      for (const filename of [...plugins.map((plugin) => plugin.filename), ...Object.keys(metadata)]) {
        fs.renameSync(path.join(staging, filename), path.join(destination, filename));
      }
    }
    console.log(`${checkOnly ? 'Verified' : 'Packed'} ${plugins.length} plugin archives in ${destination}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  packRelease(values.check);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
