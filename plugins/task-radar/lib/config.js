/**
 * Short normalization helpers conservatively attributed to c-ling/dsh-plugin-notify.
 * Copyright (c) 2026 chenchao. MIT; see ../THIRD_PARTY_NOTICES.md.
 * This attribution does not claim that the complete config module was copied.
 * Config model for dsh-plugin-task-radar.
 *
 * Two channels, one flat object, merged over DEFAULT_CONFIG and sanitized on
 * every read and write:
 *   toast   native Windows toast (host side)
 *   system  browser OS notification (client side; rides the journal)
 *   page    in-window card that can open the session (client side)
 *   quiet   local-time window that suppresses every channel
 *
 * Events: turnStart / finished / aborted / error / waiting.
 *
 * ASCII only by workspace convention; user-visible Chinese lives in the client
 * locale dictionary (lib/client.js) as \u escapes.
 */

export const TURN_KINDS = Object.freeze(['finished', 'aborted', 'error', 'waiting', 'turnStart']);

export const KIND_LABELS = Object.freeze({
  turnStart: 'Turn started',
  finished: 'Turn finished',
  aborted: 'Turn aborted',
  error: 'Turn error',
  waiting: 'Waiting for you',
});

const STR_LIMIT = 4096;
// Keep notification summaries compact and cooldowns within one day.
const SUMMARY_MAX_CHARS = 4096;
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
const DURATION_MIN_MS = 3000;
const DURATION_MAX_MS = 30000;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** Only notify for root sessions (the user's own), not subagents. */
  rootsOnly: true,
  /** Minimum gap between two notifications of the same kind+session, ms. */
  cooldownMs: 4000,
  /** Truncate the captured user-instruction summary to this many chars. */
  summaryMaxChars: 48,
  /** Title prefix shown in every channel. */
  titlePrefix: 'dsh',
  events: Object.freeze({
    turnStart: false,
    finished: true,
    aborted: true,
    error: true,
    waiting: true,
  }),
  toast: Object.freeze({
    enabled: true,
    /** Absolute path to a custom PNG; empty string falls back to the bundled icon. */
    iconPath: '',
    /** Keep toasts on screen until dismissed (scenario=reminder). */
    persistent: false,
    /** Used when persistent is false. Windows toast duration, milliseconds. */
    durationMs: 8000,
  }),
  /** Browser OS-level system notification (Action Center / Notification Center). */
  system: Object.freeze({ enabled: false }),
  /** In-window card. Clicking it opens the session; it does not need OS permission. */
  page: Object.freeze({ enabled: true }),
  /** Generic HTTP webhook: POST a JSON notification to a URL you control. */
  webhook: Object.freeze({ enabled: false, url: '' }),
  /** Local-time quiet window. End may be earlier than start (crosses midnight). */
  quiet: Object.freeze({
    enabled: false,
    start: '22:00',
    end: '08:00',
  }),
});

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value) {
  return typeof value === 'string' ? value.slice(0, STR_LIMIT) : '';
}

/** Keep only a trimmed absolute http(s) URL; anything else becomes ''. */
function httpUrl(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, STR_LIMIT) : '';
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : '';
}

function objectAt(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

/** Accept only finite numbers or non-blank numeric strings, without coercing objects. */
function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Keep an explicit 0 meaningful (0 = no cooldown); negative values use the default. */
function cooldown(value) {
  const n = finiteNumber(value);
  if (n === undefined || n < 0) return DEFAULT_CONFIG.cooldownMs;
  return Math.max(0, Math.min(COOLDOWN_MAX_MS, Math.floor(n)));
}

/** Preserve the legacy zero fallback and negative-summary lower bound. */
function summaryLimit(value) {
  const n = finiteNumber(value);
  if (n === undefined || n === 0) return DEFAULT_CONFIG.summaryMaxChars;
  return Math.max(1, Math.min(SUMMARY_MAX_CHARS, Math.floor(n)));
}

function durationMs(value) {
  const n = finiteNumber(value);
  if (n === undefined || n <= 0) return DEFAULT_CONFIG.toast.durationMs;
  return Math.max(DURATION_MIN_MS, Math.min(DURATION_MAX_MS, Math.floor(n)));
}

function clock(value, fallback) {
  return typeof value === 'string' && CLOCK_RE.test(value.trim()) ? value.trim() : fallback;
}

/** True when local minutes-of-day fall inside [start, end), including a window that crosses midnight. */
export function inQuietHours(quiet, date) {
  const window = objectAt(quiet);
  if (window.enabled !== true) return false;
  const start = clock(window.start, DEFAULT_CONFIG.quiet.start);
  const end = clock(window.end, DEFAULT_CONFIG.quiet.end);
  if (start === end) return false;
  const when = date instanceof Date ? date : new Date();
  const minutes = when.getHours() * 60 + when.getMinutes();
  const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  const endMin = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
  return startMin < endMin
    ? minutes >= startMin && minutes < endMin
    : minutes >= startMin || minutes < endMin;
}

/** Merge an arbitrary stored/input value over the defaults and sanitize it. */
export function normalizeConfig(value) {
  const source = objectAt(value);
  const events = objectAt(source.events);
  const toast = objectAt(source.toast);
  const system = objectAt(source.system);
  const page = objectAt(source.page);
  const webhook = objectAt(source.webhook);
  const quiet = objectAt(source.quiet);
  return {
    enabled: bool(source.enabled, DEFAULT_CONFIG.enabled),
    rootsOnly: bool(source.rootsOnly, DEFAULT_CONFIG.rootsOnly),
    cooldownMs: cooldown(source.cooldownMs),
    summaryMaxChars: summaryLimit(source.summaryMaxChars),
    titlePrefix: str(source.titlePrefix).trim().slice(0, 32) || DEFAULT_CONFIG.titlePrefix,
    schema: 2,
    events: {
      turnStart: bool(events.turnStart, DEFAULT_CONFIG.events.turnStart),
      finished: bool(events.finished, DEFAULT_CONFIG.events.finished),
      aborted: bool(events.aborted, DEFAULT_CONFIG.events.aborted),
      error: bool(events.error, DEFAULT_CONFIG.events.error),
      waiting: bool(events.waiting, DEFAULT_CONFIG.events.waiting),
    },
    toast: {
      enabled: bool(toast.enabled, DEFAULT_CONFIG.toast.enabled),
      iconPath: str(toast.iconPath),
      persistent: bool(toast.persistent, DEFAULT_CONFIG.toast.persistent),
      durationMs: durationMs(toast.durationMs),
    },
    system: {
      enabled: bool(system.enabled, DEFAULT_CONFIG.system.enabled),
    },
    page: {
      enabled: bool(page.enabled, DEFAULT_CONFIG.page.enabled),
    },
    webhook: {
      enabled: bool(webhook.enabled, DEFAULT_CONFIG.webhook.enabled),
      url: httpUrl(webhook.url),
    },
    quiet: {
      enabled: bool(quiet.enabled, DEFAULT_CONFIG.quiet.enabled),
      start: clock(quiet.start, DEFAULT_CONFIG.quiet.start),
      end: clock(quiet.end, DEFAULT_CONFIG.quiet.end),
    },
  };
}
