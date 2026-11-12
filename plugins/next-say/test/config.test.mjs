/**
 * Tests for settings coercion and persistence.
 *
 * The failure mode these exist for: a numeric field posted as an empty string
 * becoming 0, which makes timeout=0 (every call times out immediately) or
 * contextChars=0 (there is never anything to predict). The feature then looks
 * broken with no error anywhere -- exactly the bug a comparable plugin shipped.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULTS,
  applyPatch,
  isPaused,
  normalizeSettings,
  pauseUntil,
  readSettings,
  settingsPath,
  writeSettings,
} from '../lib/config.js';

/** One throwaway directory per test, removed afterwards. */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'next-say-test-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeSettings fills every default from an empty document', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULTS);
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  assert.deepEqual(normalizeSettings([]), DEFAULTS);
  assert.deepEqual(normalizeSettings('nope'), DEFAULTS);
});

test('a cleared numeric field never becomes an instant-failure value', () => {
  // The page ignores an empty input, but the Host must be safe even if one
  // arrives: Number('') is 0, and 0 would disable the feature silently.
  const settings = normalizeSettings({ timeoutMs: '', contextChars: '', maxSuggestionChars: '', historyMinChars: '' });
  assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(settings.contextChars, DEFAULTS.contextChars);
  assert.equal(settings.maxSuggestionChars, DEFAULTS.maxSuggestionChars);
  assert.equal(settings.historyMinChars, DEFAULTS.historyMinChars);
  assert.ok(settings.timeoutMs > 0);
});

test('out-of-range numbers are clamped, not rejected', () => {
  const settings = normalizeSettings({
    timeoutMs: 1,
    contextChars: 5,
    contextMessages: 999,
    maxSuggestionChars: 9999,
    historyMinChars: 0,
  });
  assert.equal(settings.timeoutMs, 2000);
  assert.equal(settings.contextChars, 1000);
  assert.equal(settings.contextMessages, 20);
  assert.equal(settings.maxSuggestionChars, 400);
  assert.equal(settings.historyMinChars, 1);
});

test('unknown enum values fall back to the default mode', () => {
  assert.equal(normalizeSettings({ mode: 'turbo' }).mode, 'auto');
  assert.equal(normalizeSettings({ mode: 'manual' }).mode, 'manual');
});

test('booleans are coerced strictly', () => {
  assert.equal(normalizeSettings({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeSettings({ enabled: 1 }).enabled, false);
  assert.equal(normalizeSettings({ enabled: true }).enabled, true);
  assert.equal(normalizeSettings({ historyEnabled: 'true' }).historyEnabled, false);
});

test('a half route is treated as follow-the-session', () => {
  // provider without model would make every call fail; better to inherit.
  const settings = normalizeSettings({ provider: 'deepseek', model: '' });
  assert.equal(settings.provider, '');
  assert.equal(settings.model, '');
});

test('a complete route survives, trimmed', () => {
  const settings = normalizeSettings({ provider: '  deepseek  ', model: ' deepseek-v4.1-flash ' });
  assert.equal(settings.provider, 'deepseek');
  assert.equal(settings.model, 'deepseek-v4.1-flash');
});

test('unknown keys are dropped', () => {
  const settings = normalizeSettings({ bogus: true, other: 'x', enabled: true });
  assert.ok(!('bogus' in settings));
  assert.ok(!('other' in settings));
});

test('applyPatch only accepts known keys', () => {
  const base = normalizeSettings({});
  const next = applyPatch(base, { enabled: false, bogus: 'ignored' });
  assert.equal(next.enabled, false);
  assert.ok(!('bogus' in next));
  // Untouched fields keep their value.
  assert.equal(next.timeoutMs, base.timeoutMs);
});

test('applyPatch tolerates junk patches', () => {
  const base = normalizeSettings({});
  for (const patch of [null, undefined, [], 'x', 42]) {
    assert.deepEqual(applyPatch(base, patch), base);
  }
});

/* ------------------------------------------------------------ persistence */

test('settings round-trip through the file', () => withTempDir((dir) => {
  const file = settingsPath(dir);
  assert.equal(file, join(dir, 'next-say', 'settings.json'));

  // The directory does not exist yet: writing must create it.
  const written = writeSettings(file, { enabled: false, timeoutMs: 20000 });
  assert.equal(written.enabled, false);
  assert.equal(written.timeoutMs, 20000);

  const reread = readSettings(file);
  assert.equal(reread.enabled, false);
  assert.equal(reread.timeoutMs, 20000);
  assert.deepEqual(reread, written);
}));

test('a corrupt file falls back to defaults instead of throwing', () => withTempDir((dir) => {
  const file = settingsPath(dir);
  mkdirSync(join(dir, 'next-say'), { recursive: true });
  writeFileSync(file, '{ this is not json', 'utf8');
  assert.deepEqual(readSettings(file), DEFAULTS);
}));

test('a missing file falls back to defaults', () => withTempDir((dir) => {
  assert.deepEqual(readSettings(settingsPath(dir)), DEFAULTS);
}));

test('writing leaves no temporary file behind', () => withTempDir((dir) => {
  const file = settingsPath(dir);
  writeSettings(file, { timeoutMs: 15000 });
  const contents = readFileSync(file, 'utf8');
  assert.match(contents, /"timeoutMs": 15000/);
  // Write-then-rename must not leave the intermediate file: its absence is the
  // proof that the rename (not a plain write) completed.
  assert.throws(() => readFileSync(`${file}.${process.pid}.tmp`, 'utf8'), /ENOENT/);
}));

test('the file on disk is always the normalized shape', () => withTempDir((dir) => {
  const file = settingsPath(dir);
  mkdirSync(join(dir, 'next-say'), { recursive: true });
  writeFileSync(file, JSON.stringify({ timeoutMs: -5, mode: 'nonsense' }), 'utf8');
  const reread = readSettings(file);
  assert.equal(reread.timeoutMs, 2000);
  assert.equal(reread.mode, 'auto');
}));

/* ----------------------------------------------------------------- pause */

test('pause is time-bounded and expires on its own', () => {
  const now = 1_000_000;
  const until = pauseUntil(now, 10);
  assert.equal(until, now + 10 * 60 * 1000);
  assert.equal(isPaused({ pausedUntil: until }, now), true);
  assert.equal(isPaused({ pausedUntil: until }, until), false);
  assert.equal(isPaused({ pausedUntil: until }, until + 1), false);
});

test('an unset or nonsensical pause is not a pause', () => {
  for (const value of [0, -1, undefined, null, Number.NaN, 'soon']) {
    assert.equal(isPaused({ pausedUntil: value }, Date.now()), false);
  }
});

test('pauseUntil defaults to ten minutes for a bad argument', () => {
  assert.equal(pauseUntil(0, 0), 10 * 60 * 1000);
  assert.equal(pauseUntil(0, -3), 10 * 60 * 1000);
  assert.equal(pauseUntil(0, 'x'), 10 * 60 * 1000);
  assert.equal(pauseUntil(0, 1), 60 * 1000);
});
