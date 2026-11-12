/**
 * Bounded CSV / TSV parsing.
 *
 * Two jobs:
 *   1. Parse RFC4180-style text into rows: quoted fields, doubled quotes inside
 *      a quoted field, embedded newlines inside quotes, and CRLF or LF record
 *      terminators.
 *   2. Produce a bounded, model-facing window: a header row, a slice of data
 *      rows, per-cell length caps, and byte accounting, so a 50 MB export can be
 *      inspected one page at a time without flooding the context.
 *
 * Encoding: UTF-8 by default; UTF-16LE/BE accepted explicitly. A BOM sets the
 * default when `encoding` is omitted.
 */

/** Detect the field delimiter from the first logical line, outside quotes. */
export function detectDelimiter(text, requested) {
  if (requested === ',' || requested === '\t' || requested === ';' || requested === '|') return requested
  const head = text.slice(0, Math.min(text.length, 8192))
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 }
  let quoted = false
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if (ch === '"') {
      if (quoted && head[i + 1] === '"') { i += 1; continue }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (ch === '\n') break
    if (Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch] += 1
  }
  let best = ','
  let bestCount = -1
  for (const [delim, count] of Object.entries(counts)) {
    if (count > bestCount) { best = delim; bestCount = count }
  }
  return bestCount > 0 ? best : ','
}

/**
 * Parse delimited text into rows of raw cell strings.
 * @param {string} text
 * @param {string} delimiter single-character delimiter
 * @param {{maxRows?:number, maxCells?:number}} caps stop early on huge inputs
 * @returns {{rows:string[][], truncated:boolean}}
 */
export function parseDelimited(text, delimiter, caps = {}) {
  const maxRows = Number.isFinite(caps.maxRows) ? caps.maxRows : 100000
  const maxCells = Number.isFinite(caps.maxCells) ? caps.maxCells : 2000000
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let cells = 0
  let i = 0
  const n = text.length

  const endCell = () => { row.push(cell); cell = ''; cells += 1 }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
        quoted = false; i += 1; continue
      }
      cell += ch; i += 1; continue
    }
    if (ch === '"') { quoted = true; i += 1; continue }
    if (ch === delimiter) { endCell(); i += 1; continue }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1
      endRow(); i += 1
      if (rows.length >= maxRows || cells >= maxCells) return { rows, truncated: true }
      continue
    }
    if (ch === '\n') {
      endRow(); i += 1
      if (rows.length >= maxRows || cells >= maxCells) return { rows, truncated: true }
      continue
    }
    cell += ch; i += 1
  }
  // Final row unless the text ended exactly on a record terminator.
  if (cell.length > 0 || row.length > 0) endRow()
  return { rows, truncated: false }
}

function truncateCell(value, max) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...(cell truncated, ${value.length} chars)`
}

/**
 * Render one cell as a single physical line.
 *
 * A quoted CSV cell may legitimately contain newlines. Emitting them raw would
 * split one numbered data row into several unnumbered output lines, so the row
 * numbering the model relies on for `offset` paging would no longer line up.
 * Escape them instead, reversibly and visibly.
 */
function oneLineCell(value, max) {
  const flat = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return truncateCell(flat, max)
}

/**
 * Render a bounded table window.
 * @param {string[][]} rows parsed rows (row 0 is the header when hasHeader)
 * @param {{offset:number, limit:number, hasHeader:boolean, maxCellLength:number, maxBytes:number}} req
 * @returns {{text:string, returned:number, totalDataRows:number, truncatedByBytes:boolean}}
 */
export function formatTable(rows, req) {
  const { offset, limit, hasHeader, maxCellLength, maxBytes } = req
  const header = hasHeader ? rows[0] : undefined
  const data = hasHeader ? rows.slice(1) : rows
  const totalDataRows = data.length
  const start = Math.max(0, offset - 1)
  const selected = data.slice(start, start + limit)

  const lines = []
  let bytes = 0
  let truncatedByBytes = false
  if (header !== undefined) {
    const line = header.map((c) => oneLineCell(c, maxCellLength)).join(' | ')
    lines.push(`# ${line}`)
    bytes += Buffer.byteLength(line, 'utf8') + 1
  }
  let shown = 0
  for (let r = 0; r < selected.length; r += 1) {
    const line = selected[r].map((c) => oneLineCell(c, maxCellLength)).join(' | ')
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) { truncatedByBytes = true; break }
    bytes += size
    lines.push(`${start + r + 1}: ${line}`)
    shown += 1
  }
  const end = start + shown
  let footer
  if (truncatedByBytes) {
    footer = `(Output capped at ${maxBytes} bytes. Showing data rows ${offset}-${end} of ${totalDataRows}. Use offset=${end + 1} to continue.)`
  } else if (end < totalDataRows) {
    footer = `(Showing data rows ${offset}-${end} of ${totalDataRows}. Use offset=${end + 1} to continue.)`
  } else {
    footer = `(End of table - ${totalDataRows} data rows${header !== undefined ? ', 1 header row' : ''})`
  }
  const body = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return { text: body, returned: shown, totalDataRows, truncatedByBytes }
}

/**
 * Decode table bytes with an explicit or BOM-detected encoding.
 * @param {Buffer} buffer
 * @param {string} requested 'utf-8' | 'utf-16le' | 'utf-16be' | '' (auto)
 * @returns {{text:string, encoding:string}}
 */
export function decodeTable(buffer, requested) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let encoding = requested
  if (encoding !== 'utf-16le' && encoding !== 'utf-16be') encoding = 'utf-8'
  if (!requested || requested === 'auto') {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
    else encoding = 'utf-8'
  }
  if (encoding === 'utf-16be') {
    const swapped = Buffer.from(bytes)
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t
    }
    return { text: swapped.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf-16be' }
  }
  if (encoding === 'utf-16le') {
    return { text: bytes.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf-16le' }
  }
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes)
  return { text, encoding: 'utf-8' }
}
