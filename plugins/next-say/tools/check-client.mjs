import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.DSH_PYTHON || process.env.PYTHON || 'python';
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
