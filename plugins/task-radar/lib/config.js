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
    persistent: true,
  }),
  /** Browser OS-level system notification (Action Center / Notification Center). */
  system: Object.freeze({ enabled: true }),
});

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value) {
  return typeof value === 'string' ? value.slice(0, STR_LIMIT) : '';
}

function objectAt(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

/**
 * Clamp the cooldown, but keep an explicit 0 meaningful (0 = no cooldown).
 * `... || DEFAULT` used to swallow 0 into the default 4000ms; a negative or
 * non-numeric value still falls back to the default.
 */
function cooldown(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CONFIG.cooldownMs;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIG.cooldownMs;
  return Math.floor(n);
}

/** Merge an arbitrary stored/input value over the defaults and sanitize it. */
export function normalizeConfig(value) {
  const source = objectAt(value);
  const events = objectAt(source.events);
  const toast = objectAt(source.toast);
  const system = objectAt(source.system);
  return {
    enabled: bool(source.enabled, DEFAULT_CONFIG.enabled),
    rootsOnly: bool(source.rootsOnly, DEFAULT_CONFIG.rootsOnly),
    cooldownMs: cooldown(source.cooldownMs),
    summaryMaxChars: Math.max(1, Math.floor(Number(source.summaryMaxChars) || DEFAULT_CONFIG.summaryMaxChars)),
    titlePrefix: str(source.titlePrefix).trim().slice(0, 32) || DEFAULT_CONFIG.titlePrefix,
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
    },
    system: {
      enabled: bool(system.enabled, DEFAULT_CONFIG.system.enabled),
    },
  };
}
