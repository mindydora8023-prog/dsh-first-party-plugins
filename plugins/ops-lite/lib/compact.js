/**
 * Two-level completeness and the compact multi-file renderer.
 *
 * Adapted from dsh-ops `src/modes/native/ranges.ts` and `docs/file-batching.md`.
 *
 * WHY TWO LEVELS. A batch read has two independent ways to be incomplete, and
 * conflating them makes a partial result read as a finished one:
 *
 *   batch level   `nextIndex` + `pending`  -- which input entries were never touched
 *   file  level   `complete` + `nextOffset` -- how many lines of one file are unread
 *
 * A result can be complete at the batch level (`pending: 0`) and still need
 * per-file recovery, because every file was read but only partly. The reverse
 * also happens. Both facts are therefore always reported, and `isComplete()`
 * requires both.
 *
 * The compact form is only taken when every claim it omits was actually
 * verified -- see `compactRanges`. Anything uncertain falls back to the
 * diagnostic renderer, which keeps every fact.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import path from 'node:path'
import { encodeSourceLine, quote } from './escape.js'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Whether a whole batch is complete at BOTH levels.
 *
 * @param {object} batch - the aggregated result.
 * @returns {boolean} true only when nothing is pending and no file is partial.
 */
export function isComplete(batch) {
  if (!record(batch)) return false
  if (batch.failed !== 0) return false
  if (batch.pending !== 0) return false
  if (!Array.isArray(batch.items) || batch.items.length !== batch.total) return false
  return batch.items.every((item) => record(item) && item.complete === true && item.error === undefined)
}

/**
 * Measure one fully returned range, or refuse to compact it.
 *
 * Every early return here is a fact this function could not verify. Reporting
 * `undefined` means "use the diagnostic renderer", never "assume it was fine".
 *
 * @param {unknown} input - the caller's descriptor for this file.
 * @param {unknown} value - the worker's per-file result.
 * @returns {object|undefined} the verified range, or undefined if anything is off.
 */
function verifiedRange(input, value) {
  if (!record(input) || !record(value)) return
  if (value.status !== 'completed' || value.error !== undefined) return
  if (value.truncated !== false || value.truncatedBy !== undefined) return
  if (value.metadataWarnings !== undefined || value.truncatedInLine === true) return
  if (!integer(value.lineCount) || !integer(value.nextOffset)) return
  if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) return
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) return
  if (!Array.isArray(value.items)) return

  // The window actually used is taken from the per-file record when the caller
  // omitted it, because the record holds the value the read really applied.
  // Neither field is defaulted from thin air: a window nobody can name is not a
  // window this renderer may certify as whole.
  const offset = input.offset === undefined ? value.requestedOffset : input.offset
  const limit = input.limit === undefined ? value.requestedLimit : input.limit
  if (!integer(offset) || offset < 1) return
  if (!integer(limit) || limit < 1) return

  const expected = Math.max(0, Math.min(limit, value.lineCount - offset + 1))
  if (value.items.length !== expected) return
  if (value.nextOffset !== offset + expected) return
  if (value.complete !== (offset - 1 + expected >= value.lineCount)) return

  const lines = []
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index]
    if (!record(item)) return
    if (item.line !== offset + index || item.path !== value.path) return
    if (typeof item.text !== 'string' || item.view === 'hex') return
    lines.push({ line: offset + index, text: item.text })
  }
  return {
    path: value.path,
    revision: value.revision,
    total: value.lineCount,
    next: value.nextOffset,
    complete: value.complete === true,
    lines,
  }
}

/**
 * Render a multi-file read compactly, or signal that it cannot be done.
 *
 * The savings come from three shared facts: one `Base` line when every file
 * shares an absolute parent, one `revision` receipt per file instead of a
 * `Notice:` paragraph, and a `nextOffset` only when there is more to read.
 *
 * @param {object} input - the call arguments (`files` array).
 * @param {object} value - the aggregated result.
 * @returns {string[]|undefined} rendered lines, or undefined when the general
 *   diagnostic renderer must be used instead.
 */
export function compactRanges(input, value) {
  if (!record(input) || !record(value)) return
  if (!Array.isArray(input.files) || !Array.isArray(value.items)) return
  if (input.files.length === 0 || input.files.length !== value.items.length) return
  if (value.truncated !== false || value.failed !== 0 || value.pending !== 0) return
  if (value.total !== input.files.length || value.nextIndex !== input.files.length) return

  const observed = []
  for (let index = 0; index < value.items.length; index += 1) {
    const current = verifiedRange(input.files[index], value.items[index])
    if (current === undefined) return
    observed.push(current)
  }

  const parent = path.dirname(observed[0].path)
  const shared = observed.length > 1 && observed.every((item) => path.dirname(item.path) === parent)
  const output = shared ? [`[Base: ${quote(parent)}]`] : []

  for (const item of observed) {
    const span = item.lines.length > 0
      ? `${item.lines[0].line}-${item.lines[item.lines.length - 1].line}`
      : 'none'
    const shown = shared ? path.basename(item.path) : item.path
    output.push(`=== FILE: ${quote(shown)} (Lines ${span} of ${item.total}) ===`)
    if (item.lines.length === 0) {
      output.push(item.total === 0 ? '(empty file)' : '(no lines in this range)')
    } else {
      for (const line of item.lines) output.push(`${line.line}|${encodeSourceLine(line.text)}`)
    }
    output.push(item.complete
      ? `[revision=${item.revision}; end of file; complete=true]`
      : `[revision=${item.revision}; more lines; nextOffset=${item.next}]`)
  }
  output.push(`[Notice: ${observed.length}/${input.files.length} requested ranges returned; pending=0; complete=${isComplete(value)}.]`)
  return output
}
