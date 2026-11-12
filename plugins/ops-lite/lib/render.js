/**
 * Model-facing rendering for ops_read_files and the results behind it.
 *
 * Rendering rules, in priority order:
 *
 * 1. A failure is never rendered as a success. `renderFailure` always prints the
 *    status, the effect state and the retry advice, because those three decide
 *    whether the model may act again.
 * 2. Compact output is a rendering CHOICE, not a data claim. When the compact
 *    renderer cannot verify what it would omit, this falls back to the
 *    diagnostic renderer which keeps every fact.
 * 3. A truncation notice always carries a concrete recovery step, routed by what
 *    kind of call it was: re-reading a window is safe, re-running a mutation is
 *    not.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { capText, encodeSourceLine, quote, DEFAULT_TEXT_BUDGET } from './escape.js'
import { compactRanges, isComplete } from './compact.js'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const label = (value) => String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, (char) => JSON.stringify(char).slice(1, -1))
const field = (value) => (typeof value === 'string' ? label(value) : JSON.stringify(value))

/** Render `key=value; ...` for the keys that are present. */
function facts(value, keys) {
  if (!record(value)) return ''
  return keys.filter((key) => value[key] !== undefined).map((key) => `${key}=${field(value[key])}`).join('; ')
}

/**
 * The completeness line. Always names both levels so neither can be mistaken
 * for the other.
 * @param {object} value - the aggregated result.
 * @returns {string} one notice line.
 */
function completenessNotice(value) {
  const parts = []
  const shown = Array.isArray(value.items) ? value.items.length : 0
  parts.push(`${shown} item${shown === 1 ? '' : 's'} displayed`)
  parts.push(`complete=${isComplete(value)}`)
  parts.push(`batch: total=${field(value.total)}; pending=${field(value.pending)}; nextIndex=${field(value.nextIndex)}`)
  parts.push(`files: failed=${field(value.failed)}`)
  const extra = facts(value, ['truncatedBy', 'skipped', 'omitted', 'continuation'])
  if (extra !== '') parts.push(extra)
  return `[Notice: ${parts.join('; ')}.]`
}

/**
 * Render one file in the diagnostic form: every fact, no compaction.
 * @param {object} item - one per-file result.
 * @returns {string[]} rendered lines.
 */
function diagnosticFile(item) {
  const output = []
  const shown = typeof item.path === 'string' ? item.path : '(path unavailable)'
  const numbers = Array.isArray(item.items) ? item.items.map((entry) => entry.line).filter(count) : []
  const span = numbers.length > 0 ? `${numbers[0]}-${numbers[numbers.length - 1]}` : 'none'
  const total = count(item.lineCount) ? item.lineCount : '?'
  output.push(`=== FILE: ${label(shown)} (Lines ${span} of ${total}) ===`)
  const observed = facts(item, ['revision', 'bytes', 'lineCount', 'complete', 'nextOffset'])
  if (observed !== '') output.push(`[Observed: ${observed}.]`)
  if (record(item.error)) {
    output.push(`[Failure: code=${field(item.error.code)}; effectState=${field(item.error.effectState)}; `
      + `retry=${field(item.error.retry)}${item.error.message === undefined ? '' : `; ${field(item.error.message)}`}.]`)
    if (typeof item.error.nextAction === 'string') output.push(`Next: ${label(item.error.nextAction)}`)
  }
  if (Array.isArray(item.items)) {
    for (const entry of item.items) {
      if (!record(entry)) continue
      const line = count(entry.line) ? entry.line : '?'
      output.push(`${line} | ${encodeSourceLine(entry.text ?? '')}`)
    }
  }
  if (item.truncatedInLine === true) {
    output.push(`[Notice: Line ${field(item.truncatedInLineAt ?? '?')} in ${label(shown)} is incomplete; `
      + `${facts(item, ['bytesTotal', 'bytesOmitted'])}. Use a smaller range or binary view; the next line offset `
      + 'does not recover its missing suffix.]')
  }
  if (!Array.isArray(item.items) || item.items.length === 0) {
    output.push(item.lineCount === 0 ? '(empty file)' : '(no lines in this range)')
  }
  return output
}

/**
 * Render a structured failure.
 * @param {object} value - a failure record from `outcome.js`.
 * @returns {string} the rendered body.
 */
export function renderFailure(value) {
  const error = value.error
  const lines = [`${label(value.status ?? 'error')}: ${label(error.code)}`]
  const details = [`effectState=${field(error.effectState)}`, `retry=${field(error.retry)}`]
  const extra = facts(error, ['phase', 'reason'])
  if (extra !== '') details.push(extra)
  lines.push(`[Notice: ${details.join('; ')}.]`)
  if (typeof error.nextAction === 'string') lines.push(`Next: ${label(error.nextAction)}`)
  if (typeof error.message === 'string') lines.push(label(error.message))
  return lines.join('\n')
}

/**
 * Render a read result for the model.
 *
 * @param {object} args - the call arguments.
 * @param {object} value - the result value.
 * @param {object} [options]
 * @param {number} [options.budget] - escaped-byte budget.
 * @returns {string} the rendered body.
 */
export function renderReadFiles(args, value, options = {}) {
  if (record(value) && record(value.error)) {
    return capText(renderFailure(value), { ...options, reason: 'result-budget', recovery: READ_RECOVERY })
  }

  const compact = record(value) ? compactRanges(args, value) : undefined
  let lines = compact
  if (lines === undefined) {
    lines = []
    if (record(value) && Array.isArray(value.items)) {
      for (const item of value.items) if (record(item)) lines.push(...diagnosticFile(item))
    }
    lines.push(record(value) ? completenessNotice(value) : '[Notice: No structured result was returned.]')
  }
  return capText(lines.join('\n'), { ...options, reason: 'output-budget', recovery: READ_RECOVERY })
}

/** Recovery advice for a read: repeating a smaller range is always safe. */
export const READ_RECOVERY = 'Repeat the same file entry with a smaller limit or a byte range; '
  + 'do not advance past undisplayed content.'

/** Recovery advice for a mutation: never replay a possible write. */
export const WRITE_RECOVERY = 'Inspect the current file state before another mutation; '
  + 'do not repeat the write to recover undisplayed receipts.'

export { DEFAULT_TEXT_BUDGET, quote }
