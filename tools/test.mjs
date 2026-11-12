import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const base = fileURLToPath(new URL('../plugins/', import.meta.url));
const plugins = readdirSync(base).filter((name) => existsSync(join(base, name, 'package.json'))).sort();
let failed = false;
const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 };
for (const plugin of plugins) {
  const cwd = join(base, plugin);
  const testDir = join(cwd, 'test');
  const files = existsSync(testDir) ? readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => 'test/' + name) : [];
  if (files.length === 0) {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const entries = [...new Set([pkg.main, typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : null, typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : null].filter(Boolean))];
    for (const entry of entries) {
      const check = spawnSync(process.execPath, ['--check', entry], {cwd, encoding: 'utf8', timeout: 10000});
      if (check.error || check.status !== 0) { console.error(check.stderr || check.error); failed = true; }
    }
    console.log(plugin + ': syntax checked; no behavior test suite');
    continue;
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {cwd, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024});
  const output = (result.stdout || '') + (result.stderr || '');
  const summary = {};
  for (const key of Object.keys(totals)) {
    const match = output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'));
    summary[key] = match ? Number(match[1]) : 0;
    totals[key] += summary[key];
  }
  console.log(plugin + ': ' + JSON.stringify(summary));
  if (result.error || result.status !== 0 || summary.tests === 0) {
    console.error(output);
    if (result.error) console.error(result.error.message);
    failed = true;
  }
}
console.log('TOTAL ' + JSON.stringify(totals));
process.exitCode = failed ? 1 : 0;
