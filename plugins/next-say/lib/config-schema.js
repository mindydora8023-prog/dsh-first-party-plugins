/**
 * Shared settings schema and pure helpers for dsh-plugin-next-say.
 *
 * Kept free of Node built-ins so both the Host (`lib/config.js`) and the
 * browser bundle (`client/bundle.json` -> `lib/client.js`) share one single
 * source of truth for defaults, ranges, clamping, and pause math.
 *
 * Source is kept pure ASCII (workspace convention).
 */

export const SCHEMA_VERSION = 1;

/** Defaults, and the clamp table for every numeric field. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 'auto' (one prediction per finished turn) or 'manual'. */
  mode: 'auto',
  /** Blank uses the model from the session's last request. */
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
  /** Max model calls per UTC day; 0 means unlimited. */
  dailyCallBudget: 0,
});

/** Alias consumed by the client half and its tests. */
export const DEFAULT_SETTINGS = DEFAULTS;

/** Per-field bounds. A value outside its range is clamped, never rejected. */
export const RANGES = Object.freeze({
  maxSuggestionChars: [20, 400],
  contextMessages: [2, 20],
  contextChars: [1000, 20000],
  timeoutMs: [2000, 60000],
  historyMinChars: [1, 8],
  pausedUntil: [0, Number.MAX_SAFE_INTEGER],
  dailyCallBudget: [0, 100000],
});

/**
 * Coerce one numeric field against a `[min, max]` range.
 * Empty values (`''`, `null`, `undefined`, whitespace) fall back instead of
 * becoming `0`, which would clamp to an unusable minimum.
 */
export function clampNumber(value, range, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object' || typeof value === 'boolean') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  if (range === undefined) return rounded;
  if (rounded < range[0]) return range[0];
  if (rounded > range[1]) return range[1];
  return rounded;
}

/** Clamp a named numeric setting to its schema range. */
export function clampTo(key, value) {
  return clampNumber(value, RANGES[key], DEFAULT_SETTINGS[key]);
}

/** Whether the user asked for a pause that has not expired yet. */
export function isPaused(settings, now = Date.now()) {
  const until = Number(settings && settings.pausedUntil);
  return Number.isFinite(until) && until > now;
}

/** The absolute time a fresh pause should end at. */
export function pauseUntil(now, minutes = 10) {
  const span = (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
  return Math.floor(now + span);
}
