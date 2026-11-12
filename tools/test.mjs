import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const plugins = ['archived-sessions', 'session-meter'];
let failed = false;
for (const plugin of plugins) {
  const cwd = fileURLToPath(new URL('../plugins/' + plugin + '/', import.meta.url));
  const files = readdirSync(cwd + '/test').filter((name) => name.endsWith('.test.mjs')).sort().map((name) => 'test/' + name);
  const result = spawnSync(process.execPath, ['--test', ...files], {cwd, stdio:'inherit', timeout:60000, killSignal:'SIGKILL'});
  if (result.error || result.status !== 0) {
    console.error(plugin + ': failed or exceeded 60 seconds');
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
