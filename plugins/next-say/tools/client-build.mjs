// Pure-Node client bundle helper delegating to the workspace tools/build-client.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builderPath = existsSync(resolve(root, '..', 'tools', 'build-client.mjs'))
  ? resolve(root, '..', 'tools', 'build-client.mjs')
  : resolve(root, '..', '..', 'tools', 'build-client.mjs');
const {
  BuildError,
  describeDifference,
  processPlugin,
  renderLocalesModule,
} = await import(pathToFileURL(builderPath).href);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check' && arg !== '--locales-only')) {
  console.error('Usage: node tools/client-build.mjs [--check] [--locales-only]');
  process.exit(1);
}

const checkOnly = args.includes('--check');
const localesOnly = args.includes('--locales-only');

try {
  if (localesOnly) {
    const manifest = JSON.parse(readFileSync(join(root, 'client', 'bundle.json'), 'utf8'));
    const expected = renderLocalesModule(root, manifest.locales);
    const outPath = join(root, manifest.locales.output);
    if (checkOnly) {
      if (!existsSync(outPath)) {
        console.error(`${manifest.locales.output} is missing; run: node tools/client-build.mjs`);
        process.exit(1);
      }
      const actual = readFileSync(outPath, 'utf8');
      if (actual !== expected) {
        console.error(`${manifest.locales.output} is STALE: it does not match ${manifest.locales.source}.`);
        for (const msg of describeDifference(expected, actual)) console.error(msg);
        console.error('Run: node tools/client-build.mjs');
        process.exit(1);
      }
      console.log(`ok   next-say/${manifest.locales.output} is up to date (${Buffer.byteLength(expected, 'utf8')} bytes)`);
    } else {
      writeFileSync(outPath, expected, 'utf8');
      console.log(`built next-say/${manifest.locales.output} (${Buffer.byteLength(expected, 'utf8')} bytes)`);
    }
  } else {
    process.exitCode = processPlugin(root, { checkOnly, label: 'next-say' });
  }
} catch (error) {
  console.error(error instanceof BuildError ? error.message : String(error));
  process.exit(1);
}
