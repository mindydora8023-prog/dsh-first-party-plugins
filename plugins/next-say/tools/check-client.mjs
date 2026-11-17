import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function pythonCommand() {
  const fromEnv = process.env.DSH_PYTHON || process.env.PYTHON;
  if (fromEnv) return fromEnv;
  const bundled = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const python = pythonCommand();
for (const name of ['make-locales.py', 'build-client.py']) {
  const script = fileURLToPath(new URL(name, import.meta.url));
  const result = spawnSync(python, ['-B', script, '--check'], {
    cwd: root,
    stdio: 'inherit',
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`Python check failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
