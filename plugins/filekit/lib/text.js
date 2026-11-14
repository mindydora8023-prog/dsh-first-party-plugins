/**
 * Bounded line windows and model-facing rendering.
 *
 * Semantics intentionally match the host `read` tool so the model's mental
 * model does not fork:
 *   - line numbers are 1-based;
 *   - only a physical LF ends a line and CRLF counts once, so a final LF adds
 *     no trailing empty line;
 *   - an empty file has zero lines;
 *   - a single very long line is truncated at `maxLineLength` characters
 *     instead of failing the whole read;
 *   - the window is also capped by bytes, and a byte cap reports how to resume.
 */

/** @typedef {{ number: number, text: string }} Line */

/**
 * Split decoded file text into bounded, numbered lines covering [offset, offset+limit).
 * @param {string} body full decoded file text.
 * @param {{offset:number, limit:number, maxLineLength:number, maxBytes:number}} req
 * @param {string} displayPath path shown in errors and output.
 * @returns {{lines: Line[], totalLines:number, truncatedByBytes:boolean}}
 */
export function buildWindow(body, req, displayPath) {
  const { offset, limit, maxLineLength, maxBytes } = req
  const out = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false

  // `start`/`end` bound one physical line inside `body`, excluding the LF.
  // A trailing CR (CRLF) is not part of the line text. Lines outside the
  // window are counted and never sliced, so a late page of a large file does
  // not allocate the prefix it skipped.
  const emitSpan = (start, end) => {
    totalLines += 1
    if (truncatedByBytes) return
    if (totalLines < offset) return
    if (out.length >= limit) return
    const textEnd = end > start && body.charCodeAt(end - 1) === 13 ? end - 1 : end
    let line = body.slice(start, textEnd)
    if (line.length > maxLineLength) {
      line = `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    }
    const bytes = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0)
    if (outputBytes + bytes > maxBytes) {
      truncatedByBytes = true
      return
    }
    outputBytes += bytes
    out.push({ number: totalLines, text: line })
  }

  // A trailing LF is not a new line: the walk stops when `start` lands on the
  // end, which is what `split` + dropping the empty tail used to do.
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

  if (!truncatedByBytes && offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(
      `offset ${offset} is out of range for "${displayPath}" (${totalLines} lines)`,
    )
  }
  return { lines: out, totalLines, truncatedByBytes }
}

/**
 * Escape one source line so file content cannot forge structure.
 *
 * The `<content>` wrapper below is a delimiter, and a source line containing a
 * literal `</content>` would close it early: everything after that point would
 * silently degrade to prose instead of numbered rows. Escaping makes one
 * physical source line always exactly one rendered row.
 *
 * Backslashes are doubled so a real tab (`\t`, escaped) and the two source
 * characters backslash and t (`\\t`) stay distinguishable. Quotes stay literal:
 * they carry no structural meaning here.
 *
 * Wrapper tags are neutralized by escaping their opening `<` only. That keeps
 * ordinary source text -- including comparison operators and HTML -- completely
 * unchanged, so the cost is paid only by lines that actually contain a tag.
 *
 * @param {string} value one physical source line, without its terminator.
 * @returns {string} the escaped line body.
 */
export function encodeSourceLine(value) {
  let out = ''
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (char === '\\') { out += '\\\\'; continue }
    if (char === '\t') { out += '\\t'; continue }
    if (code === undefined) continue
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  // Neutralize the wrapper's own tags so content cannot open or close a block.
  // Done after the loop: the inserted backslash must not be doubled again.
  return out.replace(/<(\/?)(content|path|type)>/g, '\\u003c$1$2>')
}

/**
 * Render a read outcome as one OpenCode-style line-numbered body.
 * @param {string} displayPath
 * @param {{offset:number, lines:Line[], totalLines:number, truncatedByBytes:boolean}} outcome
 * @returns {string}
 */
export function formatWindow(displayPath, outcome) {
  const endLine = outcome.lines.length > 0
    ? outcome.lines[outcome.lines.length - 1].number
    : Math.max(0, outcome.offset - 1)
  let footer
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map((l) => `${l.number}: ${encodeSourceLine(l.text)}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${encodeSourceLine(displayPath)}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/** Decode UTF-8 strictly; a BOM is stripped, invalid bytes are an explicit error. */
export function decodeUtf8(buffer, displayPath) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  // Binary sniffing: a NUL byte in the leading sample means "not text".
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  if (sample.includes(0)) {
    throw new Error(
      `cannot read "${displayPath}": binary content (NUL byte found). `
        + 'Use a document reader (docx/pdf/csv) or the host hex reader instead.',
    )
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new Error(
      `cannot read "${displayPath}": the file is not valid UTF-8. `
        + 'Open it with a document reader or the host hex view instead of lossy text replacement.',
    )
  }
  return text
}
