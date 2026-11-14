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
 *   - `maxLineLength` clips ONE oversized line and marks it `truncatedInLine`;
 *     the window's offset stays on that line because advancing would skip the
 *     part that was not shown.
 *   - `maxBytes` stops the window early and sets `truncatedByBytes`; the next
 *     offset resumes at the first line that did not fit.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

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
    const line = body.slice(start, clipped ? start + maxLineLength : textEnd)
    const cost = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (bytes + cost > maxBytes) {
      truncatedByBytes = true
      return
    }
    bytes += cost
    lines.push({ line: lineCount, text: line })
    if (clipped) {
      truncatedInLine = {
        line: lineCount,
        charactersTotal: rawLength,
        charactersOmitted: rawLength - maxLineLength,
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

  // The first line that did not fit is where the next window resumes.
  const nextOffset = lines.length === 0 ? offset : lines[lines.length - 1].line + 1
  return {
    lines,
    lineCount,
    nextOffset,
    complete: !truncatedByBytes && nextOffset > lineCount,
    truncatedByBytes,
    truncatedInLine,
  }
}
