/**
 * Build sync guard: ensures generated `lib/locales.js` and `lib/client.js`
 * stay byte-identical to `client/` sources rendered by `tools/build-client.mjs`.
 *
 * ASCII only.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const builderPath = existsSync(resolve(pluginRoot, '..', 'tools', 'build-client.mjs'))
  ? resolve(pluginRoot, '..', 'tools', 'build-client.mjs')
  : resolve(pluginRoot, '..', '..', 'tools', 'build-client.mjs');
const { describeDifference, renderPluginBundle } = await import(pathToFileURL(builderPath).href);

test('generated client bundle and locales match client/ sources', () => {
  const { files } = renderPluginBundle(pluginRoot);
  assert.ok(files.length >= 2, 'expected locales and client outputs');
  for (const item of files) {
    const abs = join(pluginRoot, item.rel);
    assert.equal(existsSync(abs), true, `${item.rel} is missing`);
    const actual = readFileSync(abs, 'utf8');
    assert.equal(
      actual,
      item.content,
      `${item.rel} is stale:\n${describeDifference(item.content, actual).join('\n')}\nRun: node tools/build-client.mjs task-radar`,
    );
  }
});
