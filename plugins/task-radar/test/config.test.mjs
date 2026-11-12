/**
 * Config model tests: normalization of the two-channel config.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js';

test('normalizeConfig fills defaults on empty input', () => {
  const cfg = normalizeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.rootsOnly, true);
  assert.equal(cfg.events.finished, true);
  assert.equal(cfg.events.turnStart, false);
  assert.equal(cfg.toast.enabled, true);
  assert.equal(cfg.system.enabled, true);
});

test('normalizeConfig clamps cooldownMs and summaryMaxChars', () => {
  const cfg = normalizeConfig({ cooldownMs: -5, summaryMaxChars: 0 });
  assert.equal(cfg.cooldownMs, DEFAULT_CONFIG.cooldownMs);
  assert.equal(cfg.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars);
  const cfg2 = normalizeConfig({ cooldownMs: 1234, summaryMaxChars: 80 });
  assert.equal(cfg2.cooldownMs, 1234);
  assert.equal(cfg2.summaryMaxChars, 80);
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

test('normalizeConfig keeps event booleans, ignores junk', () => {
  const cfg = normalizeConfig({ events: { finished: false, error: 'no' } });
  assert.equal(cfg.events.finished, false);
  assert.equal(cfg.events.error, DEFAULT_CONFIG.events.error);
});
