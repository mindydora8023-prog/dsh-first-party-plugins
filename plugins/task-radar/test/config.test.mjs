/**
 * Config model tests: normalization of the two-channel config.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, inQuietHours, normalizeConfig } from '../lib/config.js';

test('normalizeConfig fills defaults on empty input', () => {
  const cfg = normalizeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.rootsOnly, true);
  assert.equal(cfg.events.finished, true);
  assert.equal(cfg.events.turnStart, false);
  assert.equal(cfg.toast.enabled, true);
  assert.equal(cfg.toast.persistent, false);
  assert.equal(cfg.toast.durationMs, 8000);
  assert.equal(cfg.system.enabled, false);
  assert.equal(cfg.page.enabled, true);
  assert.equal(cfg.quiet.enabled, false);
  assert.equal(cfg.schema, 2);
});

test('normalizeConfig clamps cooldownMs and summaryMaxChars', () => {
  const cfg = normalizeConfig({ cooldownMs: -5, summaryMaxChars: 0 });
  assert.equal(cfg.cooldownMs, DEFAULT_CONFIG.cooldownMs);
  assert.equal(cfg.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars);
  const cfg2 = normalizeConfig({ cooldownMs: 1234, summaryMaxChars: 80 });
  assert.equal(cfg2.cooldownMs, 1234);
  assert.equal(cfg2.summaryMaxChars, 80);
});

test('an explicit cooldownMs of 0 means "no cooldown" and is preserved', () => {
  assert.equal(normalizeConfig({ cooldownMs: 0 }).cooldownMs, 0);
});

test('numeric settings reject missing, blank, non-finite, and non-numeric inputs', () => {
  const invalid = [
    undefined, null, '', ' \t\r\n ', NaN, Infinity, -Infinity,
    '1e999', '-1e999', 'Infinity', 'NaN', '12px', true, false,
    [], [123], {}, new Number(123), 123n, Symbol('numeric'),
    { valueOf() { throw new Error('must not coerce objects'); } },
  ];
  for (const value of invalid) {
    const cfg = normalizeConfig({ cooldownMs: value, summaryMaxChars: value });
    assert.equal(cfg.cooldownMs, DEFAULT_CONFIG.cooldownMs);
    assert.equal(cfg.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars);
  }
});

test('numeric settings retain numeric strings, floor fractions, and preserve zero semantics', () => {
  const cases = [
    [0, 0, DEFAULT_CONFIG.summaryMaxChars],
    ['0', 0, DEFAULT_CONFIG.summaryMaxChars],
    [-0, 0, DEFAULT_CONFIG.summaryMaxChars],
    [' -0 ', 0, DEFAULT_CONFIG.summaryMaxChars],
    [' 123.9 ', 123, 123],
    ['1e3', 1000, 1000],
    [0.9, 0, 1],
    [-0.9, DEFAULT_CONFIG.cooldownMs, 1],
    [-100, DEFAULT_CONFIG.cooldownMs, 1],
    ['-100', DEFAULT_CONFIG.cooldownMs, 1],
  ];
  for (const [value, cooldownMs, summaryMaxChars] of cases) {
    const cfg = normalizeConfig({ cooldownMs: value, summaryMaxChars: value });
    assert.equal(cfg.cooldownMs, cooldownMs);
    assert.equal(cfg.summaryMaxChars, summaryMaxChars);
  }
});

test('summaries cap at 4096 characters and cooldowns cap at 24 hours', () => {
  const cases = [
    [4095.9, 86399999.9, 4095, 86399999],
    [4096, 86400000, 4096, 86400000],
    [4097, 86400001, 4096, 86400000],
    ['4097.9', '86400001.9', 4096, 86400000],
    [Number.MAX_VALUE, Number.MAX_VALUE, 4096, 86400000],
    ['1e308', '1e308', 4096, 86400000],
  ];
  for (const [summary, cooldown, expectedSummary, expectedCooldown] of cases) {
    const cfg = normalizeConfig({ summaryMaxChars: summary, cooldownMs: cooldown });
    assert.equal(cfg.summaryMaxChars, expectedSummary);
    assert.equal(cfg.cooldownMs, expectedCooldown);
  }
});

test('normalized numeric settings survive JSON persistence and repeated normalization', () => {
  const inputs = [
    {},
    { summaryMaxChars: '1e999', cooldownMs: '1e999' },
    { summaryMaxChars: Infinity, cooldownMs: -Infinity },
    { summaryMaxChars: Number.MAX_VALUE, cooldownMs: Number.MAX_VALUE },
    { summaryMaxChars: '4096.9', cooldownMs: '86400000.9' },
    { summaryMaxChars: -10, cooldownMs: 0 },
    { summaryMaxChars: 0, cooldownMs: '0' },
    { summaryMaxChars: [], cooldownMs: true },
    { summaryMaxChars: ' 80.9 ', cooldownMs: ' 1234.9 ', system: { enabled: false } },
  ];
  for (const input of inputs) {
    const cfg = normalizeConfig(input);
    assert.ok(Number.isInteger(cfg.summaryMaxChars));
    assert.ok(cfg.summaryMaxChars >= 1 && cfg.summaryMaxChars <= 4096);
    assert.ok(Number.isInteger(cfg.cooldownMs));
    assert.ok(cfg.cooldownMs >= 0 && cfg.cooldownMs <= 86400000);
    const stored = JSON.parse(JSON.stringify(cfg));
    assert.deepEqual(stored, cfg);
    assert.deepEqual(normalizeConfig(cfg), cfg);
    assert.deepEqual(normalizeConfig(stored), cfg);
  }
});

test('normalizeConfig round-trips the system channel toggle', () => {
  assert.equal(normalizeConfig({ system: { enabled: true } }).system.enabled, true);
  assert.equal(normalizeConfig({ system: { enabled: false } }).system.enabled, false);
});

test('normalizeConfig round-trips toast options and trims prefix', () => {
  const cfg = normalizeConfig({ toast: { enabled: false, persistent: false, iconPath: 'C:/x.png' }, titlePrefix: '  ' });
  assert.equal(cfg.toast.enabled, false);
  assert.equal(cfg.toast.persistent, false);
  assert.equal(cfg.toast.iconPath, 'C:/x.png');
  assert.equal(cfg.titlePrefix, DEFAULT_CONFIG.titlePrefix);
});

test('duration and quiet hours are clamped and round-trip', () => {
  const cfg = normalizeConfig({ toast: { durationMs: 1000 }, quiet: { enabled: true, start: '9:00', end: '25:00' } });
  assert.equal(cfg.toast.durationMs, 3000);
  assert.equal(cfg.quiet.start, '22:00');
  assert.equal(cfg.quiet.end, '08:00');
  const kept = normalizeConfig({ toast: { durationMs: 12000 }, quiet: { enabled: true, start: '22:00', end: '08:00' } });
  assert.equal(kept.toast.durationMs, 12000);
  assert.equal(inQuietHours(kept.quiet, new Date(2026, 0, 1, 23, 0)), true);
  assert.equal(inQuietHours(kept.quiet, new Date(2026, 0, 1, 7, 59)), true);
  assert.equal(inQuietHours(kept.quiet, new Date(2026, 0, 1, 8, 0)), false);
  assert.equal(inQuietHours(kept.quiet, new Date(2026, 0, 1, 12, 0)), false);
  assert.equal(inQuietHours({ enabled: false, start: '00:00', end: '23:59' }, new Date()), false);
});

test('normalizeConfig keeps event booleans, ignores junk', () => {
  const cfg = normalizeConfig({ events: { finished: false, error: 'no' } });
  assert.equal(cfg.events.finished, false);
  assert.equal(cfg.events.error, DEFAULT_CONFIG.events.error);
});
