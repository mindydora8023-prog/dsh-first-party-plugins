/**
 * Persisted settings for dsh-plugin-next-say.
 *
 * The settings page writes through the Host route, so the file is the single
 * source of truth and survives a restart. Every value is coerced and clamped on
 * read AND on write: a hand-edited file, an older schema, or a POST with a
 * cleared number field must never produce a value that silently disables the
 * feature (the failure mode "timeout=0 means every call times out instantly,
 * context=0 means there is never anything to predict").
 *
 * Source is kept pure ASCII (workspace convention).
 */
import { join } from 'node:path';
import { readJsonFileBoundedSync, writeJsonAtomicSync, writeJsonAtomic } from './json-store.js';
import {
  SCHEMA_VERSION,
  DEFAULTS,
  RANGES,
  clampNumber,
  isPaused,
  pauseUntil,
} from './config-schema.js';

export { SCHEMA_VERSION, DEFAULTS, RANGES, isPaused, pauseUntil };

const MODES = new Set(['auto', 'manual']);

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Coerce any candidate document into a complete, in-range settings object.
 * Unknown keys are dropped so an old file cannot smuggle stale fields forward.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const next = {
    enabled: source.enabled === undefined ? DEFAULTS.enabled : source.enabled === true,
    mode: MODES.has(source.mode) ? source.mode : DEFAULTS.mode,
    provider: text(source.provider, DEFAULTS.provider).trim(),
    model: text(source.model, DEFAULTS.model).trim(),
  };
  for (const [key, range] of Object.entries(RANGES)) {
    next[key] = clampNumber(source[key], range, DEFAULTS[key]);
  }
  next.historyEnabled = source.historyEnabled === undefined
    ? DEFAULTS.historyEnabled
    : source.historyEnabled === true;
  // A prediction override needs both fields. An incomplete pair inherits the session route.
  if (next.provider === '' || next.model === '') {
    next.provider = '';
    next.model = '';
  }
  return next;
}

/** Settings file path under the DSH home. */
export function settingsPath(home) {
  return join(home, 'next-say', 'settings.json');
}

/** Read settings, falling back to defaults on any malformed or missing file. */
export function readSettings(file) {
  return normalizeSettings(readJsonFileBoundedSync(file, { fallback: {} }));
}

/**
 * Persist settings atomically using the shared Windows-safe atomic JSON writer.
 */
export function writeSettings(file, patch) {
  const next = normalizeSettings({ ...readSettings(file), ...patch });
  writeJsonAtomicSync(file, next, { spaces: 2 });
  return next;
}

/** Async queued atomic settings writer for non-blocking routes. */
export async function writeSettingsAsync(file, patch) {
  const next = normalizeSettings({ ...readSettings(file), ...patch });
  await writeJsonAtomic(file, next, { spaces: 2 });
  return next;
}

/**
 * Apply one settings-page patch.
 *
 * Listing the fields explicitly (rather than spreading arbitrary JSON) keeps the
 * file to its known shape even when the page posts extra keys.
 */
export function applyPatch(current, patch) {
  const source = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = { ...current };
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(source, key)) merged[key] = source[key];
  }
  return normalizeSettings(merged);
}
