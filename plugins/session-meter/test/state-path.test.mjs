/**
 * Guard: the session-meter status file must not default into the source tree.
 *
 * WHY THIS TEST EXISTS SEPARATELY. The shared `state-outside-tree.test.mjs` asserts
 * the same contract through `readConfig()`, but this plugin has no `lib/config.js`
 * -- its only knob is the `SESSION_METER_STATUS_FILE` environment variable. Rather
 * than reshape the plugin to satisfy a test helper, the same three guarantees are
 * pinned here against the real function the host uses.
 *
 * THE BUG THIS PREVENTS. Until 2026-10-27 the default was
 * `<pluginDir>/session-meter-status.json`. The 2026-10-26 state migration copied
 * that file into the per-user state directory but never re-pointed the writer, so
 * the live file stayed in the source tree and the copy froze at the moment of the
 * copy. Measured 2026-10-27 00:05: a running host rewrote the source-tree file.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { statusFilePath } from '../lib/index.js';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run `fn` with `DSH_PLUGIN_STATE_DIR` set, restoring the previous value after. */
function withStateRoot(value, fn) {
  const previous = process.env['DSH_PLUGIN_STATE_DIR'];
  process.env['DSH_PLUGIN_STATE_DIR'] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['DSH_PLUGIN_STATE_DIR'];
    else process.env['DSH_PLUGIN_STATE_DIR'] = previous;
  }
}

/** Run `fn` with `SESSION_METER_STATUS_FILE` unset, restoring the previous value. */
function withoutStatusOverride(fn) {
  const previous = process.env['SESSION_METER_STATUS_FILE'];
  delete process.env['SESSION_METER_STATUS_FILE'];
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.env['SESSION_METER_STATUS_FILE'] = previous;
  }
}

test('the status file does not default into the plugin source tree', () => {
  const actual = withoutStatusOverride(() => statusFilePath());

  // A trailing separator keeps a sibling directory with a shared prefix from passing.
  const pluginPrefix = PLUGIN_DIR.endsWith('\\') || PLUGIN_DIR.endsWith('/') ? PLUGIN_DIR : `${PLUGIN_DIR}\\`;
  const normalized = actual.replace(/\//g, '\\');
  const normalizedPlugin = pluginPrefix.replace(/\//g, '\\');

  assert.equal(
    normalized.startsWith(normalizedPlugin),
    false,
    `status file defaults into the source tree (${actual}); it must go to the per-user state directory`,
  );
});

test('the status file keeps its name so existing diagnostics stay findable', () => {
  const actual = withoutStatusOverride(() => statusFilePath());
  assert.match(actual.replace(/\//g, '\\'), /\\session-meter\\session-meter-status\.json$/);
});

test('DSH_PLUGIN_STATE_DIR moves the default location', () => {
  const actual = withoutStatusOverride(() => withStateRoot('C:/probe-state-root', () => statusFilePath()));
  assert.match(actual.replace(/\//g, '\\'), /^C:\\probe-state-root\\/);
});

test('SESSION_METER_STATUS_FILE is honoured verbatim', () => {
  // This is the documented escape hatch for putting diagnostics on another volume,
  // so it must win over the default and be used exactly as given.
  const previous = process.env['SESSION_METER_STATUS_FILE'];
  process.env['SESSION_METER_STATUS_FILE'] = 'C:/explicit/status.json';
  try {
    assert.equal(statusFilePath(), 'C:/explicit/status.json');
  } finally {
    if (previous === undefined) delete process.env['SESSION_METER_STATUS_FILE'];
    else process.env['SESSION_METER_STATUS_FILE'] = previous;
  }
});

test('an empty override falls back to the state directory instead of an empty path', () => {
  const previous = process.env['SESSION_METER_STATUS_FILE'];
  process.env['SESSION_METER_STATUS_FILE'] = '   ';
  try {
    const actual = statusFilePath();
    assert.notEqual(actual.trim(), '', 'an empty override must not produce an empty path');
    assert.match(actual.replace(/\//g, '\\'), /\\session-meter-status\.json$/);
  } finally {
    if (previous === undefined) delete process.env['SESSION_METER_STATUS_FILE'];
    else process.env['SESSION_METER_STATUS_FILE'] = previous;
  }
});
