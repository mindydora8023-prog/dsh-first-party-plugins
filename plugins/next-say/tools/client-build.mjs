// Build helpers prefer the bundled DSH Python without changing the system PATH.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
  process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const python = process.env.PYTHON || (existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check' && arg !== '--locales-only')) {
  console.error('Usage: node tools/client-build.mjs [--check] [--locales-only]');
  process.exit(1);
}
function run(script, flags) {
  const child = spawnSync(python, [resolve(root, 'tools', script), ...flags], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
  if (child.error) console.error(`Python build failed: ${child.error.message}`);
  if (child.error || child.status !== 0) process.exit(child.status || 1);
}
const check = args.includes('--check');
run('make-locales.py', [check ? '--check' : '--write']);
if (!args.includes('--locales-only')) run('build-client.py', check ? ['--check'] : []);
