/**
 * Bounded XLSX reader (no third-party dependency).
 *
 * An .xlsx is a ZIP of XML parts. This module reads the minimum set needed to
 * render one worksheet as a paged table:
 *   xl/workbook.xml            sheet names + r:id
 *   xl/_rels/workbook.xml.rels  r:id -> part path
 *   xl/sharedStrings.xml       shared string table (optional)
 *   xl/styles.xml              cell formats, used only to recognise DATE cells
 *   xl/worksheets/sheetN.xml   rows and cells
 *
 * Supported cell types: shared string (t="s"), inline string (t="inlineStr"),
 * formula string (t="str"), boolean (t="b"), error (t="e"), and numbers
 * (default), with date-formatted numbers converted to ISO dates.
 *
 * Deliberately unsupported: formulas are shown as their cached value (not
 * recalculated), merged cells are flattened to their top-left value, charts,
 * images, pivot tables, and legacy binary .xls. Those are reported, not guessed.
 */

import { readZipEntry, looksLikeZip } from './zip.js'
import { unescapeXml } from './docx.js'

/** Excel column letters ("A", "AB") to a 0-based index. */
export function columnIndex(ref) {
  let n = 0
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

/** Read an attribute value from a start tag string, e.g. r="A1". */
function attr(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag)
  return m === null ? undefined : m[1]
}

/** Parse sharedStrings.xml into an array of plain strings (bounded to entries). */
export function parseSharedStrings(xml) {
  const out = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = siRe.exec(xml)) !== null) {
    // A shared string may be split into multiple <t> runs (rich text).
    let text = ''
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = tRe.exec(m[1])) !== null) text += unescapeXml(t[1])
    out.push(text)
  }
  return out
}

const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/**
 * Determine which cell style indices (cellXfs) render as dates.
 * @returns {Set<number>} date-style indices usable by a cell's `s` attribute.
 */
export function parseDateStyles(stylesXml) {
  const dateStyles = new Set()
  if (typeof stylesXml !== 'string' || stylesXml.length === 0) return dateStyles

  // Custom number formats that look like dates.
  const customDateFmtIds = new Set()
  const fmtRe = /<numFmt\b([^>]*)\/?>/g
  let f
  while ((f = fmtRe.exec(stylesXml)) !== null) {
    const id = Number(attr(f[1], 'numFmtId'))
    const code = attr(f[1], 'formatCode') ?? ''
    // Strip quoted literals and escaped chars before looking for date tokens.
    const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '')
    if (/[ymdhs]/i.test(bare) && !/^#|^0|general/i.test(bare)) customDateFmtIds.add(id)
  }

  // cellXfs lists each cell's xf in order; its `numFmtId` picks the format.
  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)
  if (xfsBlock === null) return dateStyles
  const xfRe = /<xf\b([^>]*?)\/?>/g
  let x
  let index = 0
  while ((x = xfRe.exec(xfsBlock[1])) !== null) {
    const numFmtId = Number(attr(x[1], 'numFmtId'))
    if (BUILTIN_DATE_FMT_IDS.has(numFmtId) || customDateFmtIds.has(numFmtId)) dateStyles.add(index)
    index += 1
  }
  return dateStyles
}

/** Convert an Excel serial date to an ISO date/time string (UTC, 1900 system). */
export function serialToIso(serial) {
  const ms = Math.round(serial * 86400000)
  // Excel's epoch: serial 1 = 1900-01-01, with the fictitious 1900-02-29 (serial
  // 60). Anchoring at 1899-12-30 matches all serials >= 61 in practice.
  const d = new Date(Date.UTC(1899, 11, 30) + ms)
  if (Number.isNaN(d.getTime())) return String(serial)
  const iso = d.toISOString()
  // Whole days render as a plain date; anything with a time keeps the time.
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace('.000Z', '')
}

/**
 * Parse one worksheet's rows into arrays of display strings.
 * @param {string} sheetXml
 * @param {string[]} sharedStrings
 * @param {Set<number>} dateStyles
 * @param {{maxRows?:number, maxCells?:number}} caps
 * @returns {{rows:string[][], truncated:boolean}}
 */
export function parseSheet(sheetXml, sharedStrings, dateStyles, caps = {}) {
  const maxRows = Number.isFinite(caps.maxRows) ? caps.maxRows : 100000
  const maxCells = Number.isFinite(caps.maxCells) ? caps.maxCells : 2000000
  const rows = []
  let cells = 0
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let r
  while ((r = rowRe.exec(sheetXml)) !== null) {
    const row = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let c
    while ((c = cellRe.exec(r[1])) !== null) {
      const tag = c[1]
      const inner = c[2] ?? ''
      const type = attr(tag, 't')
      const styleIndex = attr(tag, 's') === undefined ? -1 : Number(attr(tag, 's'))
      const ref = attr(tag, 'r')
      const col = ref === undefined ? row.length : columnIndex(ref)

      let value = ''
      if (type === 's') {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1])
        value = Number.isInteger(idx) ? sharedStrings[idx] ?? '' : ''
      } else if (type === 'inlineStr') {
        const is = /<is>([\s\S]*?)<\/is>/.exec(inner)
        if (is !== null) {
          let text = ''
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
          let t
          while ((t = tRe.exec(is[1])) !== null) text += unescapeXml(t[1])
          value = text
        }
      } else if (type === 'str') {
        value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1] ?? '')
      } else if (type === 'b') {
        value = String((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1]) === '1' ? 'TRUE' : 'FALSE'
      } else if (type === 'e') {
        value = `#${(/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1] ?? 'ERROR'}`
      } else {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1]
        if (raw !== undefined) {
          const num = Number(raw)
          if (dateStyles.has(styleIndex) && Number.isFinite(num)) value = serialToIso(num)
          else value = raw
        }
      }
      row[col] = value
      cells += 1
      if (cells >= maxCells) return { rows: row.length > 0 ? [...rows, row] : rows, truncated: true }
    }
    // Fill holes so columns stay aligned.
    for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = ''
    rows.push(row)
    if (rows.length >= maxRows) return { rows, truncated: true }
  }
  return { rows, truncated: false }
}

/**
 * List sheets as {name, rid, target} resolved through the workbook rels.
 * @returns {Array<{name:string, rid:string, target:string}>}
 */
export function listSheets(workbookXml, relsXml) {
  const relMap = new Map()
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m
  while ((m = relRe.exec(relsXml)) !== null) {
    const id = attr(m[1], 'Id')
    const target = attr(m[1], 'Target')
    if (id !== undefined && target !== undefined) relMap.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const sheets = []
  const sheetRe = /<sheet\b([^>]*?)\/?>/g
  while ((m = sheetRe.exec(workbookXml)) !== null) {
    const name = attr(m[1], 'name')
    const rid = attr(m[1], 'r:id') ?? attr(m[1], 'id')
    if (name === undefined || rid === undefined) continue
    const target = relMap.get(rid)
    sheets.push({ name, rid, target: target === undefined ? '' : target })
  }
  return sheets
}

/** Zip part name for a sheet target, tolerating absolute vs relative spellings. */
function sheetPart(target) {
  const clean = target.replace(/^\.?\//, '')
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

/**
 * Read an XLSX buffer into a bounded, model-facing text window of one sheet.
 * @param {Buffer} buffer
 * @param {{offset:number, limit:number, sheet?:string|number, hasHeader?:boolean, maxCellLength?:number, maxBytes?:number}} req
 * @returns {{text:string, sheetName:string, sheets:string[], returned:number, totalRows:number, truncatedByBytes:boolean, warnings:string[]}}
 */
export function readXlsx(buffer, req) {
  const warnings = []
  if (!looksLikeZip(buffer)) {
    throw new Error('not an XLSX container (no ZIP signature). Legacy binary .xls is not supported; save as .xlsx first.')
  }
  const readText = (name, optional) => {
    try {
      return readZipEntry(buffer, name).toString('utf8')
    } catch (error) {
      if (optional) return null
      throw new Error(`not a readable XLSX: missing ${name} (${error?.message ?? String(error)})`)
    }
  }

  const workbookXml = readText('xl/workbook.xml', false)
  const relsXml = readText('xl/_rels/workbook.xml.rels', true) ?? ''
  const sheets = listSheets(workbookXml, relsXml)
  if (sheets.length === 0) throw new Error('XLSX has no worksheets')

  let chosen
  if (typeof req.sheet === 'number' && Number.isFinite(req.sheet)) {
    chosen = sheets[req.sheet - 1]
  } else if (typeof req.sheet === 'string' && req.sheet.trim() !== '') {
    const wanted = req.sheet.trim()
    chosen = sheets.find((s) => s.name === wanted)
    if (chosen === undefined && /^\d+$/.test(wanted)) chosen = sheets[Number(wanted) - 1]
  } else {
    chosen = sheets[0]
  }
  if (chosen === undefined) {
    throw new Error(`worksheet not found; available sheets: ${sheets.map((s) => s.name).join(', ')}`)
  }
  if (chosen.target === '') {
    throw new Error(`worksheet "${chosen.name}" has no resolvable part path in the workbook rels`)
  }

  const sheetXml = readText(sheetPart(chosen.target), false)
  const sharedXml = readText('xl/sharedStrings.xml', true)
  const sharedStrings = sharedXml === null ? [] : parseSharedStrings(sharedXml)
  const stylesXml = readText('xl/styles.xml', true)
  const dateStyles = parseDateStyles(stylesXml)

  const parsed = parseSheet(sheetXml, sharedStrings, dateStyles, { maxRows: 200000 })
  if (parsed.truncated) warnings.push('the sheet scan stopped at a row/cell cap; totals may be short')

  const maxCellLength = Number.isFinite(req.maxCellLength) ? req.maxCellLength : 500
  const maxBytes = Number.isFinite(req.maxBytes) ? req.maxBytes : 50 * 1024
  const hasHeader = req.hasHeader !== false
  const rows = parsed.rows
  const totalRows = hasHeader ? Math.max(0, rows.length - 1) : rows.length
  const dataStart = hasHeader ? 1 : 0
  const start = Math.max(0, req.offset - 1)
  const selected = rows.slice(dataStart + start, dataStart + start + req.limit)
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0)

  const truncate = (v) => {
    const s = v === undefined ? '' : String(v)
    return s.length > maxCellLength ? `${s.slice(0, maxCellLength)}...(cell truncated, ${s.length} chars)` : s
  }

  const lines = []
  let bytes = 0
  let truncatedByBytes = false
  if (hasHeader && rows[0] !== undefined) {
    const headerLine = Array.from({ length: width }, (_, i) => truncate(rows[0][i])).join(' | ')
    lines.push(`# ${headerLine}`)
    bytes += Buffer.byteLength(headerLine, 'utf8') + 1
  }
  let shown = 0
  for (let r = 0; r < selected.length; r += 1) {
    const row = selected[r]
    const line = Array.from({ length: width }, (_, i) => truncate(row[i])).join(' | ')
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) { truncatedByBytes = true; break }
    bytes += size
    lines.push(`${start + r + 1}: ${line}`)
    shown += 1
  }
  const end = start + shown
  let footer
  if (truncatedByBytes) footer = `(Output capped at ${maxBytes} bytes. Showing rows ${req.offset}-${end} of ${totalRows}. Use offset=${end + 1} to continue.)`
  else if (end < totalRows) footer = `(Showing rows ${req.offset}-${end} of ${totalRows}. Use offset=${end + 1} to continue.)`
  else footer = `(End of sheet "${chosen.name}" - ${totalRows} data rows${hasHeader ? ', 1 header row' : ''})`

  const body = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return {
    text: body,
    sheetName: chosen.name,
    sheets: sheets.map((s) => s.name),
    returned: shown,
    totalRows,
    truncatedByBytes,
    warnings,
  }
}
