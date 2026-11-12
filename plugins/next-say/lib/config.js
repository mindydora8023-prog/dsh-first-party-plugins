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
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 1;

/** Defaults, and the clamp table for every numeric field. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 'auto' (one prediction per finished turn) or 'manual'. */
  mode: 'auto',
  /** Blank means "follow the session's own model". */
  provider: '',
  model: '',
  /** Character limit for the suggested message itself; also sets the token net. */
  maxSuggestionChars: 120,
  /** How many recent messages the auxiliary call may read. */
  contextMessages: 8,
  /** Character budget across those messages. */
  contextChars: 6000,
  /** Wall clock for one prediction, including the adapter's own retries. */
  timeoutMs: 12000,
  /** Local history prefix completion while typing; costs nothing. */
  historyEnabled: true,
  /** Shortest draft that may produce a history completion. */
  historyMinChars: 2,
  /** Pause everything for this long when the user asks for a break. */
  pausedUntil: 0,
});

/** Per-field bounds. A value outside its range is clamped, never rejected. */
const RANGES = Object.freeze({
  maxSuggestionChars: [20, 400],
  contextMessages: [2, 20],
  contextChars: [1000, 20000],
  timeoutMs: [2000, 60000],
  historyMinChars: [1, 8],
  pausedUntil: [0, Number.MAX_SAFE_INTEGER],
});

const MODES = new Set(['auto', 'manual']);

/**
 * Coerce one numeric field.
 *
 * An EMPTY value ( `''`, `null`, whitespace) is treated as "unset" and falls
 * back to the default, never as 0. `Number('')` is 0, and clamping 0 up to the
 * field's minimum would hand back a value that looks usable but breaks the
 * feature: timeout 2000 still fails every slow provider, and a context of 1000
 * characters can silently truncate the conversation to nothing useful. Both
 * failures are invisible, so "unset" must stay distinguishable from "smallest".
 */
function clampNumber(value, [min, max], fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object' || typeof value === 'boolean') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

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
  // A provider without a model (or the reverse) is an unusable half-route: it
  // would make every call fail. Treat it as "follow the session".
  if (next.provider === '' || next.model === '') {
    next.provider = '';
    next.model = '';
  }
  return next;
}

/** Whether the user asked for a pause that has not expired yet. */
export function isPaused(settings, now = Date.now()) {
  const until = Number(settings?.pausedUntil);
  return Number.isFinite(until) && until > now;
}

/** The absolute time a fresh pause should end at. */
export function pauseUntil(now, minutes = 10) {
  const span = (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
  return Math.floor(now + span);
}

/** Settings file path under the DSH home. */
export function settingsPath(home) {
  return join(home, 'next-say', 'settings.json');
}

/** Read settings, falling back to defaults on any malformed or missing file. */
export function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return normalizeSettings({});
  }
}

/**
 * Persist settings atomically.
 *
 * Write-then-rename: a crash mid-write leaves the previous good file instead of
 * a truncated one, which would otherwise reset every setting to defaults.
 */
export function writeSettings(file, patch) {
  const next = normalizeSettings({ ...readSettings(file), ...patch });
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The cleanup failure must not mask the original write failure.
    }
    throw error;
  }
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
