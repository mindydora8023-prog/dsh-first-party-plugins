/**
 * ops-lite configuration: hard caps and toggles.
 *
 * Every bound exists so one tool call cannot flood the model's context. A
 * profile may tighten a value; raising one past the documented maximum is
 * clamped rather than trusted, because the maximum is a context-safety bound,
 * not a preference.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { statePath } from './state-dir.js'

/** Hard ceilings a profile cannot exceed. */
export const LIMITS = Object.freeze({
  maxFiles: 32,
  maxLimit: 2000,
  maxLineLength: 2000,
  maxOutputBytes: 50 * 1024,
  callMaxBytes: 200 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  textBudget: 64 * 1024,
})

const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

/** Clamp an integer config value into [min, max], falling back when unusable. */
function int(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.trunc(number)
  if (integer < min || integer > max) return integer < min ? min : max
  return integer
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/**
 * Validate and clamp the plugin config.
 *
 * Unknown keys are rejected rather than ignored: a typo that silently disables
 * a cap is worse than a failed load, and the error names the offending key.
 *
 * @param {object|undefined} raw - the `config` block from cordis.patch.yml.
 * @returns {object} the resolved configuration.
 */
export function readConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const known = new Set([
    'maxFiles', 'defaultLimit', 'maxLimit', 'maxLineLength',
    'maxOutputBytes', 'callMaxBytes', 'maxFileBytes', 'textBudget',
    'denyCredentialReads', 'promptGuidance', 'statusFile',
  ])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) throw new Error(`ops-lite: unknown configuration key "${key}"`)
  }

  return {
    maxFiles: int(source.maxFiles, LIMITS.maxFiles, 1, LIMITS.maxFiles),
    defaultLimit: int(source.defaultLimit, 400, 1, LIMITS.maxLimit),
    maxLimit: int(source.maxLimit, LIMITS.maxLimit, 1, LIMITS.maxLimit),
    maxLineLength: int(source.maxLineLength, LIMITS.maxLineLength, 80, LIMITS.maxLineLength),
    maxOutputBytes: int(source.maxOutputBytes, LIMITS.maxOutputBytes, 4096, 4 * 1024 * 1024),
    callMaxBytes: int(source.callMaxBytes, LIMITS.callMaxBytes, 8192, 16 * 1024 * 1024),
    maxFileBytes: int(source.maxFileBytes, LIMITS.maxFileBytes, 64 * 1024, 256 * 1024 * 1024),
    textBudget: int(source.textBudget, LIMITS.textBudget, 4096, 1024 * 1024),
    denyCredentialReads: bool(source.denyCredentialReads, true),
    promptGuidance: bool(source.promptGuidance, true),
    // Before 2026-10-26 this plugin ignored `statusFile` entirely and always wrote
    // into its own source directory, so a test run overwrote the file the live
    // host had written (its status file recorded a pid and a %TEMP% home). The
    // default now goes to the per-user state directory; `false` disables it.
    statusFile:
      source.statusFile === false
        ? false
        : text(source.statusFile, statePath('ops-lite', 'ops-lite-status.json')),
  }
}
