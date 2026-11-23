/**
 * Bounded line windows over decoded UTF-8 text.
 *
 * Line accounting deliberately matches the host `read` tool so the model does
 * not have to hold two mental models:
 *   - line numbers are 1-based;
 *   - only a physical LF ends a line, and CRLF counts once;
 *   - a trailing LF creates no phantom final line;
 *   - an empty file has zero lines.
 *
 * Two independent caps apply, and they are reported differently because the
 * recovery differs:
 *   - `maxLineLength` clips an oversized line and marks it `truncatedInLine`;
 *     the window's offset stays on the first clipped line because advancing
 *     would skip the part that was not shown.
 *   - `maxBytes` stops the window early and sets `truncatedByBytes`; the next
 *     offset resumes at the first line that did not fit.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'

/**
 * 1-based physical line that first contains `literal`, or undefined.
 *
 * Only a LF starts a new line, matching `buildWindow`, so the offset handed to
 * that window is the line the model asked to see.
 *
 * @param {string} body - full decoded file text.
 * @param {string} literal - exact source text to find; empty never matches.
 * @returns {number|undefined} the line number, counting from 1.
 */
export function lineOfLiteral(body, literal) {
  const needle = String(literal)
  if (needle === '') return undefined
  const at = String(body).indexOf(needle)
  if (at < 0) return undefined
  let line = 1
  for (let index = 0; index < at; index += 1) {
    if (body.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * Build a numbered window over `body`.
 *
 * @param {string} body - full decoded file text.
 * @param {object} request - the window request.
 * @param {number} request.offset - 1-based first line.
 * @param {number} request.limit - maximum lines to emit.
 * @param {number} request.maxLineLength - clip one line beyond this many characters.
 * @param {number} request.maxBytes - stop the window beyond this many bytes.
 * @returns {object} `{lines, lineCount, nextOffset, complete, truncatedByBytes, truncatedInLine}`
 */
export function buildWindow(body, request) {
  const { offset, limit, maxLineLength, maxBytes } = request
  const lines = []
  let lineCount = 0
  let bytes = 0
  let truncatedByBytes = false
  let truncatedInLine

  // `start`/`end` bound one physical line inside `body`, excluding the LF.
  // A trailing CR (CRLF) is not part of the line text. Lines outside the
  // window are counted and never sliced.
  const emitSpan = (start, end) => {
    lineCount += 1
    if (truncatedByBytes) return
    if (lineCount < offset) return
    // Reaching the requested line limit is ordinary paging, NOT truncation: the
    // caller asked for this many lines and `nextOffset` says where to resume.
    // Conflating the two would mark every paged read as truncated.
    if (lines.length >= limit) return
    const textEnd = end > start && body.charCodeAt(end - 1) === 13 ? end - 1 : end
    const rawLength = textEnd - start
    const clipped = rawLength > maxLineLength
    let clipEnd = clipped ? start + maxLineLength : textEnd
    if (clipped && clipEnd > start && clipEnd < textEnd) {
      const code = body.charCodeAt(clipEnd - 1)
      if (code >= 0xd800 && code <= 0xdbff) clipEnd -= 1
    }
    const line = body.slice(start, clipEnd)
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const cost = lineBytes + (lines.length > 0 ? 1 : 0)
    if (bytes + cost > maxBytes) {
      truncatedByBytes = true
      return
    }
    bytes += cost
    lines.push({ line: lineCount, text: line })
    if (clipped && truncatedInLine === undefined) {
      const omitted = body.slice(clipEnd, textEnd)
      const bytesOmitted = Buffer.byteLength(omitted, 'utf8')
      truncatedInLine = {
        line: lineCount,
        charactersTotal: rawLength,
        charactersOmitted: textEnd - clipEnd,
        bytesTotal: lineBytes + bytesOmitted,
        bytesOmitted,
      }
    }
  }

  // Walk LF offsets instead of `split`. A paged read used to allocate one
  // string per physical line of the whole file, including the prefix before
  // `offset` and the tail after `limit`. Those lines are only counted.
  if (body.length > 0) {
    let start = 0
    while (start < body.length) {
      const nl = body.indexOf('\n', start)
      if (nl === -1) {
        emitSpan(start, body.length)
        break
      }
      emitSpan(start, nl)
      start = nl + 1
    }
  }

  // Keep `nextOffset` on the first clipped line so advancing does not skip the
  // missing suffix; otherwise resume at the first line that did not fit.
  const nextOffset = truncatedInLine !== undefined
    ? truncatedInLine.line
    : (lines.length === 0 ? offset : lines[lines.length - 1].line + 1)
  return {
    lines,
    lineCount,
    nextOffset,
    complete: !truncatedByBytes && truncatedInLine === undefined && nextOffset > lineCount,
    truncatedByBytes,
    truncatedInLine,
  }
}
