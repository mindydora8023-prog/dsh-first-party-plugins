/**
 * Reversible escaping and byte-budgeted truncation for model-facing text.
 *
 * Two independent problems, both solved here because they share one property:
 * the model pays for the ESCAPED bytes, not the source bytes.
 *
 * 1. FORGERY. A source line is untrusted. If a line contains a raw CR, a
 *    U+2028 line separator, or the literal terminator of whatever wrapper the
 *    renderer uses, a careless renderer lets file content forge extra rows or
 *    close the block early -- everything after it silently degrades to prose.
 *    `encodeSourceLine` makes the encoding reversible and keeps every such
 *    character escaped, so one physical source line is always exactly one
 *    rendered row.
 *
 * 2. BUDGET. A 64 KiB limit counted on source characters can emit far more
 *    than 64 KiB once escaped (a tab becomes two characters), which is how a
 *    tool blows a model's context while believing it stayed under the cap.
 *    `capText` measures the JSON-encoded content blocks the host actually
 *    sends, then binary-searches the largest prefix that fits.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'

/** The default ceiling for one tool's model-visible text, in escaped bytes. */
export const DEFAULT_TEXT_BUDGET = 64 * 1024

/**
 * Escape a source line so it cannot forge structure and encodes reversibly.
 *
 * Backslashes are doubled, so "a real tab" (`\t`, escaped) and "the two source
 * characters backslash and t" (`\\t`) stay distinguishable. Quotes are left
 * literal: they carry no structural meaning in this format and doubling them
 * would cost bytes without preventing anything.
 *
 * @param {string} value - one physical source line, without its terminator.
 * @returns {string} the escaped line body.
 */
export function encodeSourceLine(value) {
  let out = ''
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (char === '\\') { out += '\\\\'; continue }
    if (char === '\t') { out += '\\t'; continue }
    if (code === undefined) continue
    // C0 controls (including CR/LF) and DEL must never appear raw.
    if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    // Unicode line/paragraph separators are treated as line breaks by some
    // consumers; escaping them keeps one source line one rendered row.
    if (code === 0x85 || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/**
 * Quote a path or heading with JSON escaping plus separator escaping.
 *
 * JSON.stringify leaves U+2028/U+2029 raw; they are line terminators to some
 * readers, so they are escaped here too.
 *
 * @param {string} value - the text to quote.
 * @returns {string} a quoted, single-row-safe string.
 */
export function quote(value) {
  return JSON.stringify(String(value)).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * The escaped byte cost of a text body as the host encodes it.
 *
 * The host sends content blocks as JSON, so the cost of a body is the cost of
 * `JSON.stringify([{type:'text',text}])` minus the fixed frame. Measuring the
 * whole array and subtracting the empty-body measurement keeps the frame's
 * cost out without hard-coding it.
 *
 * @param {string} text - the candidate body.
 * @returns {number} bytes the body contributes.
 */
export function escapedBytes(text) {
  return Buffer.byteLength(JSON.stringify([{ type: 'text', text }]), 'utf8')
    - Buffer.byteLength(JSON.stringify([{ type: 'text', text: '' }]), 'utf8')
}

/**
 * Truncate a body to a byte budget, appending a recovery notice when it cuts.
 *
 * The notice is part of the budget, not extra: a truncation warning that pushes
 * the result back over the limit has not solved anything. A binary search finds
 * the largest prefix that fits together with its notice, and a split surrogate
 * pair at the cut point is backed off by one so the output stays valid UTF-8.
 *
 * `recovery` must name a concrete next step. "Output truncated" alone leaves the
 * model guessing, and guessing is what produces repeated identical calls.
 *
 * @param {string} text - the full body.
 * @param {object} [options]
 * @param {number} [options.budget] - maximum escaped bytes; 512..1 MiB.
 * @param {string} [options.reason] - a short machine word for the notice.
 * @param {string} [options.recovery] - the concrete next step for the model.
 * @param {(text: string) => string} [options.measure] - override the byte measure.
 * @returns {string} the whole text, or a fitting prefix plus a notice.
 */
export function capText(text, options = {}) {
  const budget = options.budget ?? DEFAULT_TEXT_BUDGET
  if (!Number.isSafeInteger(budget) || budget < 512 || budget > 1024 * 1024) {
    throw new RangeError('text budget must be 512..1048576 bytes')
  }
  const measure = options.measure ?? escapedBytes
  if (measure(text) <= budget) return text

  const reason = options.reason ?? 'output-budget'
  const recovery = options.recovery ?? 'Repeat the same call with a smaller limit; do not advance past undisplayed content.'
  const notice = `\n[Notice: Display incomplete. TruncatedBy: ${reason}. ${recovery}]`

  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(text.slice(0, middle) + notice) <= budget) low = middle
    else high = middle - 1
  }
  // Never cut between the halves of a surrogate pair.
  const last = low > 0 ? text.charCodeAt(low - 1) : 0
  if (last >= 0xd800 && last <= 0xdbff) low -= 1
  return text.slice(0, low) + notice
}
