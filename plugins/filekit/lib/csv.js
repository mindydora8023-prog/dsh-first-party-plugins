/**
 * Bounded CSV / TSV parsing.
 *
 * Two jobs:
 *   1. Parse RFC4180-style text into rows: quoted fields (only when a quote
 *      opens at cell start), doubled quotes inside a quoted field, embedded
 *      newlines inside quotes, and CRLF or LF record terminators.
 *   2. Produce a bounded, model-facing window: a header row, a slice of data
 *      rows, per-cell length caps, and byte accounting, so a 50 MB export can be
 *      inspected one page at a time without flooding the context.
 *
 * Encoding: UTF-8 by default; UTF-16LE/BE accepted explicitly. A BOM sets the
 * default when `encoding` is omitted.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { truncateUtf8 } from './ooxml.js'

/** Detect the field delimiter from the first logical line, outside quotes. */
export function detectDelimiter(text, requested) {
  if (requested === ',' || requested === '\t' || requested === ';' || requested === '|') return requested
  const head = text.slice(0, Math.min(text.length, 8192))
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 }
  let quoted = false
  let atCellStart = true
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if (quoted) {
      if (ch === '"') {
        if (head[i + 1] === '"') { i += 1; continue }
        quoted = false
      }
      continue
    }
    if (atCellStart && ch === '"') { quoted = true; atCellStart = false; continue }
    if (ch === '\n' || ch === '\r') break
    if (Object.prototype.hasOwnProperty.call(counts, ch)) {
      counts[ch] += 1
      atCellStart = true
    } else {
      atCellStart = false
    }
  }
  let best = ','
  let bestCount = -1
  for (const [delim, count] of Object.entries(counts)) {
    if (count > bestCount) { best = delim; bestCount = count }
  }
  return bestCount > 0 ? best : ','
}

/**
 * Parse delimited text into rows of raw cell strings using slice-based scanning.
 * Quotes only open a quoted field at cell start (RFC 4180).
 *
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
  let cells = 0
  let i = 0
  const n = text.length

  while (i < n) {
    let value
    if (text[i] === '"') {
      // Quoted field: only entered at cell start.
      i += 1
      let segStart = i
      let parts = null
      while (i < n) {
        const q = text.indexOf('"', i)
        if (q === -1) {
          const tail = text.slice(segStart)
          value = parts !== null ? (parts.push(tail), parts.join('')) : tail
          i = n
          break
        }
        if (q + 1 < n && text[q + 1] === '"') {
          if (parts === null) parts = []
          parts.push(text.slice(segStart, q), '"')
          i = q + 2
          segStart = i
          continue
        }
        const tail = text.slice(segStart, q)
        value = parts !== null ? (parts.push(tail), parts.join('')) : tail
        i = q + 1
        break
      }
      if (value === undefined) value = parts !== null ? parts.join('') : ''
      const extraStart = i
      while (i < n && text[i] !== delimiter && text[i] !== '\r' && text[i] !== '\n') i += 1
      if (i > extraStart) value += text.slice(extraStart, i)
    } else {
      // Unquoted field: literal quotes inside remain literal.
      const start = i
      while (i < n && text[i] !== delimiter && text[i] !== '\r' && text[i] !== '\n') i += 1
      value = text.slice(start, i)
    }

    row.push(value)
    cells += 1

    if (i < n && text[i] === delimiter) {
      i += 1
      if (cells >= maxCells) {
        rows.push(row)
        return { rows, truncated: true }
      }
      if (i === n) {
        row.push('')
        cells += 1
        rows.push(row)
        row = []
      }
      continue
    }

    if (i < n && (text[i] === '\r' || text[i] === '\n')) {
      if (text[i] === '\r' && i + 1 < n && text[i + 1] === '\n') i += 2
      else i += 1
      rows.push(row)
      row = []
      if (rows.length >= maxRows || cells >= maxCells) {
        return { rows, truncated: i < n }
      }
      continue
    }

    if (row.length > 0) {
      rows.push(row)
      row = []
    }
  }
  return { rows, truncated: false }
}

function truncateCell(value, max) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...(cell truncated, ${value.length} chars)`
}

/**
 * Render one cell as a single physical line.
 * Escapes backslashes, CR, LF, and tabs reversibly so row numbering stays aligned.
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
  const cell = (value) => oneLineCell(value, maxCellLength).replace(/\|/g, '\\|')
  if (header !== undefined) {
    const line = header.map((c) => cell(c)).join(' | ')
    const headerLine = `# ${line}`
    lines.push(headerLine)
    bytes += Buffer.byteLength(headerLine, 'utf8') + 1
  }
  let shown = 0
  for (let r = 0; r < selected.length; r += 1) {
    const rowBody = selected[r].map((c) => cell(c)).join(' | ')
    const fullLine = `${start + r + 1}: ${rowBody}`
    const size = Buffer.byteLength(fullLine, 'utf8') + 1
    if (bytes + size > maxBytes) {
      if (shown === 0) {
        // Never return 0 rows when a row exists (prevents infinite pagination loops).
        const notice = '... (row truncated to fit output cap)'
        const budget = Math.max(64, maxBytes - bytes - Buffer.byteLength(notice, 'utf8') - 16)
        lines.push(`${start + r + 1}: ${truncateUtf8(rowBody, budget)}${notice}`)
        shown += 1
      }
      truncatedByBytes = true
      break
    }
    bytes += size
    lines.push(fullLine)
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
