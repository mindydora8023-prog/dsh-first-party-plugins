import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builder = resolve(root, '..', '..', 'tools', 'build-client.mjs');

const result = spawnSync(process.execPath, [builder, '--root', root, '--check'], {
  cwd: root,
  stdio: 'inherit',
  timeout: 30000,
  windowsHide: true,
});
if (result.error) {
  console.error(`Client build check failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
