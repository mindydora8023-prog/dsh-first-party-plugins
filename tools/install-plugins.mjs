import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverPlugins } from './plugins.mjs';

const usage = `Usage: npm run install-plugins -- [options]
  --list                    List available plugins and requirements
  --profile <path>          Existing profile directory or its package.json
  --plugins <names>         Install comma-separated plugin IDs or package names
  --all                     Install all plugins
  --link                    Use absolute link: dependencies (the default)
  --uninstall <names>       Remove comma-separated plugins from the profile
  --rollback <backupPath>   Restore a backup (infers the profile from its backup name)
  --dry-run                 Preview changes without writing files
  --help                    Show this help

Run without --plugins or --all in a terminal to select plugins interactively.`;

export function linkSpec(directory, paths = path) {
  if (!paths.isAbsolute(directory)) throw new Error('Plugin path must be absolute');
  const normalized = paths.normalize(directory);
  return 'link:' + (paths.sep === '\\' ? normalized.replaceAll('\\', '/') : normalized);
}

function objectField(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function parseProfile(bytes, filename) {
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in ${filename}`);
  }
  return objectField(config, filename);
}

function sections(config) {
  const deps = objectField(config.dependencies === undefined ? {} : config.dependencies, 'dependencies');
  const dsh = objectField(config.dsh === undefined ? {} : config.dsh, 'dsh');
  const profile = objectField(dsh.profile === undefined ? {} : dsh.profile, 'dsh.profile');
  const bundles = profile.bundles === undefined ? [] : profile.bundles;
  if (!Array.isArray(bundles)) throw new Error('dsh.profile.bundles must be an array');
  return { deps, dsh, profile, bundles };
}

function editProfile(config, selected, uninstall) {
  const { deps, dsh, profile, bundles } = sections(config);
  const names = new Set(selected.map(({ manifest }) => manifest.name));
  const dependencies = { ...deps };
  for (const { manifest, directory } of selected) {
    if (uninstall) delete dependencies[manifest.name];
    else dependencies[manifest.name] = linkSpec(directory);
  }
  const updatedBundles = uninstall
    ? bundles.filter((name) => !names.has(name))
    : [...bundles, ...[...names].filter((name) => !bundles.includes(name))];

  const updated = { ...config };
  if (Object.keys(deps).length !== Object.keys(dependencies).length ||
      [...names].some((name) => deps[name] !== dependencies[name])) updated.dependencies = dependencies;
  if (updatedBundles.length !== bundles.length) {
    updated.dsh = { ...dsh, profile: { ...profile, bundles: updatedBundles } };
  }
  return updated;
}

function preview(before, after) {
  const previous = before ? sections(before) : null;
  const next = sections(after);
  const names = new Set([...Object.keys(previous?.deps ?? {}), ...Object.keys(next.deps)]);
  const changes = [...names].filter((name) => previous?.deps[name] !== next.deps[name]);
  return {
    dependencies: Object.fromEntries(changes.map((name) => [name, {
      before: Object.hasOwn(previous?.deps ?? {}, name) ? previous.deps[name] : null,
      after: Object.hasOwn(next.deps, name) ? next.deps[name] : null,
    }])),
    'dsh.profile.bundles': { before: previous?.bundles ?? null, after: next.bundles },
  };
}

function resolveProfile(input) {
  const requested = path.resolve(input);
  const file = fs.statSync(requested).isDirectory() ? path.join(requested, 'package.json') : requested;
  if (path.basename(file) !== 'package.json' || !fs.statSync(file).isFile()) {
    throw new Error('Provide a profile directory or an existing package.json file');
  }
  return fs.realpathSync(file);
}

function saveProfile(file, before, after) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let timestamp = Date.now();
  let backup = `${file}.bak.${timestamp}`;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(temporary, after, { flag: 'wx', mode: 0o600, flush: true });
    fs.chmodSync(temporary, mode);
    for (;;) {
      try {
        fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600, flush: true });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        backup = `${file}.bak.${++timestamp}`;
      }
    }
    if (!fs.readFileSync(file).equals(before)) throw new Error(`Profile changed during the operation: ${file}`);
    fs.renameSync(temporary, file);
    return backup;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function selectByName(plugins, names) {
  return [...new Set(names.split(',').map((name) => name.trim()))].map((name) => {
    const plugin = plugins.find(({ id, manifest }) => id === name || manifest.name === name);
    if (!plugin) throw new Error(`Unknown plugin: ${JSON.stringify(name)}. Use --list to see available plugins.`);
    return plugin;
  });
}

function listPlugins(plugins) {
  for (const { id, manifest } of plugins) {
    const dependencies = Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => `${name} ${spec}`);
    console.log(`${id} ${manifest.version} (${manifest.name})`);
    console.log(`  ${manifest.description}`);
    console.log(`  Node.js ${manifest.engines.node}; DSH ${manifest.engines.dsh ?? '(host required)'}; npm dependencies: ${dependencies.join(', ') || 'none'}`);
  }
}

async function promptForOptions(options, plugins, needsSelection) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(options.profile ? 'Specify --plugins or --all outside a terminal' : 'Specify --profile outside a terminal');
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  input.once('close', () => abort.abort());
  const ask = (question) => input.question(question, { signal: abort.signal });
  try {
    if (options.profile === undefined) {
      options.profile = (await ask('Profile directory or package.json: ')).trim().replace(/^"(.*)"$/, '$1');
      if (!options.profile) throw new Error('A profile path is required');
    }
    if (!needsSelection) return [];

    const selected = new Set();
    console.log('Enter numbers separated by commas to toggle plugins. Press Enter to finish.');
    for (;;) {
      for (const [index, { id, manifest }] of plugins.entries()) {
        console.log(`  ${selected.has(index) ? '[x]' : '[ ]'} ${index + 1}. ${id} ${manifest.version}`);
      }
      const answer = (await ask('Selection: ')).trim();
      if (!answer) return plugins.filter((_, index) => selected.has(index));
      const numbers = new Set(answer.split(',').map((value) => Number(value.trim())));
      if ([...numbers].some((number) => !Number.isInteger(number) || number < 1 || number > plugins.length)) {
        console.log(`Enter numbers from 1 to ${plugins.length}.`);
        continue;
      }
      for (const index of [...numbers].map((number) => number - 1)) {
        if (!selected.delete(index)) selected.add(index);
      }
    }
  } finally {
    input.close();
  }
}

async function main() {
  const { values: options } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    list: { type: 'boolean' },
    profile: { type: 'string' },
    plugins: { type: 'string' },
    all: { type: 'boolean' },
    link: { type: 'boolean' },
    uninstall: { type: 'string' },
    rollback: { type: 'string' },
    'dry-run': { type: 'boolean' },
  } });
  if (options.help) return console.log(usage);

  const actions = ['list', 'plugins', 'all', 'uninstall', 'rollback'].filter((name) => options[name] !== undefined);
  if (actions.length > 1) throw new Error('Use only one of --list, --plugins, --all, --uninstall or --rollback');
  if (options.link && (options.uninstall !== undefined || options.rollback !== undefined)) {
    throw new Error('--link applies only to installation');
  }
  const plugins = discoverPlugins();
  if (options.list) return listPlugins(plugins);
  for (const name of ['profile', 'rollback']) {
    if (options[name] !== undefined && !options[name].trim()) throw new Error(`--${name} requires a path`);
  }

  let backupPath;
  if (options.rollback !== undefined) {
    backupPath = path.resolve(options.rollback);
    if (options.profile === undefined) {
      if (!/^package\.json\.bak\.\d+$/.test(path.basename(backupPath))) {
        throw new Error('Specify --profile when restoring a renamed backup');
      }
      options.profile = path.join(path.dirname(backupPath), 'package.json');
    }
    if (!fs.statSync(backupPath).isFile()) throw new Error('Provide a backup file');
  }
  const uninstall = options.uninstall !== undefined;
  const names = options.uninstall ?? options.plugins;
  let selection = names !== undefined ? selectByName(plugins, names) : options.all ? plugins : [];
  const interactiveSelection = actions.length === 0;
  if (options.profile === undefined || interactiveSelection) {
    const prompted = await promptForOptions(options, plugins, interactiveSelection);
    if (interactiveSelection) selection = prompted;
  }
  const file = resolveProfile(options.profile);
  const dryRun = options['dry-run'];
  const apply = () => {
    const before = fs.readFileSync(file);
    let after;
    let original;
    let updated;
    if (backupPath) {
      after = fs.readFileSync(backupPath);
      updated = parseProfile(after, backupPath);
      sections(updated);
      if (dryRun) {
        try {
          original = parseProfile(before, file);
          sections(original);
        } catch {
          // A rollback can recover a corrupt profile.
          original = null;
        }
      }
    } else {
      original = parseProfile(before, file);
      updated = editProfile(original, selection, uninstall);
      after = updated.dependencies === original.dependencies && updated.dsh === original.dsh
        ? before : Buffer.from(JSON.stringify(updated, null, 2) + '\n');
    }
    if (dryRun) {
      console.log(`Dry run for ${file}`);
      console.log(JSON.stringify(preview(original, updated), null, 2));
      if (backupPath && !before.equals(after)) console.log('Rollback would restore the complete profile from the backup.');
    } else if (before.equals(after)) {
      console.log(`Profile already up to date: ${file}`);
    } else {
      const backup = saveProfile(file, before, after);
      console.log(`Updated ${file}\nBackup: ${backup}`);
    }
  };

  if (dryRun) return apply();
  const lock = `${file}.install-plugins.lock`;
  let handle;
  try {
    handle = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Profile is locked by an installer: ${lock}`);
    throw error;
  }
  try {
    apply();
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.name === 'AbortError' ? 'Operation cancelled.' : error.message);
    process.exitCode = 1;
  }
}
