/**
 * Guard: runtime state must never default into this plugin's source tree.
 *
 * WHY. Every plugin used to write `<pluginDir>/<name>-status.json`, and gmail also
 * wrote its IMAP cursor there. Measured 2026-10-26, seven plugins had left runtime
 * files in their source directories. Three concrete harms, all observed:
 *
 *   1. The directory is mirrored to a git repository, so the sync tool needed a
 *      shape-based `*-status.json` filter purely to keep runtime noise out.
 *   2. A test run could overwrite the file the LIVE host wrote. ops-lite proved it:
 *      its status file recorded a pid and a `%TEMP%` home, i.e. a test run had
 *      written it, because that plugin ignored `statusFile` and always used the
 *      source path.
 *   3. A `link:` plugin's source tree may be read-only or on a network share.
 *
 * This test pins the CONTRACT (state resolves outside the plugin directory, and
 * `statusFile: false` disables it) rather than one absolute path, so it holds on
 * any machine and in any CI.
 *
 * `DSH_PLUGIN_STATE_DIR` is asserted too: it is the documented escape hatch, and a
 * regression that ignored it would be silently untestable otherwise.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { readConfig } from '../lib/config.js';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A config object resolved for THIS plugin, as the host would build it. */
function config(overrides = {}) {
  return readConfig(overrides, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' });
}

test('the status file does not default into the plugin source tree', () => {
  const resolved = config();
  const statusFile = resolved.statusFile;
  assert.ok(statusFile !== false, 'the status file is on by default');

  // Trailing separator so a sibling directory with a shared prefix cannot pass.
  const pluginPrefix = PLUGIN_DIR.endsWith('/') || PLUGIN_DIR.endsWith('\\') ? PLUGIN_DIR : `${PLUGIN_DIR}\\`;
  const normalized = String(statusFile).replace(/\//g, '\\');
  const normalizedPlugin = pluginPrefix.replace(/\//g, '\\');
  assert.equal(
    normalized.startsWith(normalizedPlugin),
    false,
    `status file defaults into the source tree (${statusFile}); it must go to the per-user state directory`,
  );
});

test('statusFile: false still disables the write', () => {
  assert.equal(config({ statusFile: false }).statusFile, false);
});

test('an explicit statusFile is honoured verbatim', () => {
  const explicit = config({ statusFile: 'C:/explicit/state.json' });
  assert.equal(explicit.statusFile, 'C:/explicit/state.json');
});

test('DSH_PLUGIN_STATE_DIR moves the default location', () => {
  const previous = process.env['DSH_PLUGIN_STATE_DIR'];
  process.env['DSH_PLUGIN_STATE_DIR'] = 'C:/probe-state-root';
  try {
    // readConfig is pure, so a fresh call picks the variable up immediately.
    const moved = config();
    assert.match(String(moved.statusFile).replace(/\//g, '\\'), /^C:\\probe-state-root\\/);
  } finally {
    if (previous === undefined) delete process.env['DSH_PLUGIN_STATE_DIR'];
    else process.env['DSH_PLUGIN_STATE_DIR'] = previous;
  }
});
