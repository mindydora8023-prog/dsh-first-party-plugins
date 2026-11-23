/**
 * Bounded XLSX reader (no third-party dependency).
 *
 * An .xlsx is a ZIP of XML parts. This module reads the minimum set needed to
 * render one worksheet as a paged table:
 *   xl/workbook.xml            sheet names + r:id + date1904 flag
 *   xl/_rels/workbook.xml.rels  r:id -> part path
 *   xl/sharedStrings.xml       shared string table (optional, skipping <rPh> ruby text)
 *   xl/styles.xml              cell formats, used only to recognise DATE cells
 *   xl/worksheets/sheetN.xml   rows and cells
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { looksLikeZip } from './zip.js'
import { mdCell, markdownTable } from './md.js'
import { attr, parseRels, readZipText, sheetPart, truncateUtf8, unescapeXml } from './ooxml.js'

/** Hard cap on columns per row to keep sparse sheets bounded. */
const MAX_COLUMNS = 1024

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

/** Detect whether the workbook uses the 1904 date system (`<workbookPr date1904="1"/>`). */
export function isDate1904(workbookXml) {
  if (typeof workbookXml !== 'string') return false
  const m = /<workbookPr\b([^>]*?)\/?>/.exec(workbookXml)
  if (m === null) return false
  const val = (attr(m[1], 'date1904') ?? '').trim().toLowerCase()
  return val === '1' || val === 'true'
}

/** Strip phonetic ruby guides (`<rPh>...</rPh>`) before reading `<t>` runs. */
function stripRuby(fragment) {
  return fragment.includes('<rPh') ? fragment.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '') : fragment
}

/** Parse sharedStrings.xml into an array of plain strings, skipping `<rPh>` ruby text. */
export function parseSharedStrings(xml) {
  const out = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = siRe.exec(xml)) !== null) {
    const clean = stripRuby(m[1])
    let text = ''
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = tRe.exec(clean)) !== null) text += unescapeXml(t[1])
    out.push(text)
  }
  return out
}

const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/**
 * Determine which cell style indices (cellXfs) render as dates.
 * Strips quoted literals, escaped chars, and `[...]` color/locale/currency
 * tokens before testing for date tokens so `[$USD] 0.00` and `[Red]#,##0` stay
 * numbers.
 *
 * @returns {Set<number>} date-style indices usable by a cell's `s` attribute.
 */
export function parseDateStyles(stylesXml) {
  const dateStyles = new Set()
  if (typeof stylesXml !== 'string' || stylesXml.length === 0) return dateStyles

  const customDateFmtIds = new Set()
  const fmtRe = /<numFmt\b([^>]*)\/?>/g
  let f
  while ((f = fmtRe.exec(stylesXml)) !== null) {
    const id = Number(attr(f[1], 'numFmtId'))
    const code = unescapeXml(attr(f[1], 'formatCode') ?? '')
    const bare = code
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '')
      .replace(/\[[^\]]*\]/g, '')
      .trim()
    if (/[ymdhs]/i.test(bare) && !/^#|^0|general/i.test(bare)) customDateFmtIds.add(id)
  }

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

/**
 * Convert an Excel serial date to an ISO date/time string (UTC).
 * @param {number} serial
 * @param {boolean} [date1904=false] true when workbook sets `date1904="1"`
 */
export function serialToIso(serial, date1904 = false) {
  const ms = Math.round(serial * 86400000)
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const d = new Date(epoch + ms)
  if (Number.isNaN(d.getTime())) return String(serial)
  const iso = d.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace('.000Z', '')
}

/** Parse one `<row>...</row>` inner XML into an array of cell strings. */
function parseRowCells(rowInner, sharedStrings, dateStyles, date1904, cellCounter) {
  const row = []
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let c
  while ((c = cellRe.exec(rowInner)) !== null) {
    const tag = c[1]
    const inner = c[2] ?? ''
    const type = attr(tag, 't')
    const styleRaw = attr(tag, 's')
    const styleIndex = styleRaw === undefined ? -1 : Number(styleRaw)
    const ref = attr(tag, 'r')
    const col = ref === undefined ? row.length : columnIndex(ref)
    if (col >= MAX_COLUMNS) continue

    let value = ''
    if (type === 's') {
      const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1])
      value = Number.isInteger(idx) ? sharedStrings[idx] ?? '' : ''
    } else if (type === 'inlineStr') {
      const is = /<is>([\s\S]*?)<\/is>/.exec(inner)
      if (is !== null) {
        const clean = stripRuby(is[1])
        let text = ''
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
        let t
        while ((t = tRe.exec(clean)) !== null) text += unescapeXml(t[1])
        value = text
      }
    } else if (type === 'str') {
      value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1] ?? '')
    } else if (type === 'b') {
      value = String((/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1]) === '1' ? 'TRUE' : 'FALSE'
    } else if (type === 'e') {
      const rawErr = (/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1] ?? 'ERROR'
      value = rawErr.startsWith('#') ? rawErr : `#${rawErr}`
    } else {
      const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner) ?? [])[1]
      if (raw !== undefined) {
        const num = Number(raw)
        if (dateStyles.has(styleIndex) && Number.isFinite(num)) value = serialToIso(num, date1904)
        else value = raw
      }
    }
    row[col] = value
    cellCounter.count += 1
    if (cellCounter.count >= cellCounter.max) {
      cellCounter.hit = true
      break
    }
  }
  for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = ''
  return row
}

/** Count `<row` tags quickly starting from `pos`, capped at `maxAdditional`. */
function countRemainingRows(sheetXml, startPos, maxAdditional) {
  let count = 0
  let pos = startPos
  while (count < maxAdditional) {
    const idx = sheetXml.indexOf('<row', pos)
    if (idx === -1) return { count, capped: false }
    const next = sheetXml.charCodeAt(idx + 4)
    if (next === 32 || next === 62 || next === 9 || next === 10 || next === 13 || next === 47) {
      count += 1
    }
    pos = idx + 4
  }
  // Check whether at least one more <row exists beyond the cap.
  let probe = pos
  while (probe < sheetXml.length) {
    const idx = sheetXml.indexOf('<row', probe)
    if (idx === -1) return { count, capped: false }
    const next = sheetXml.charCodeAt(idx + 4)
    if (next === 32 || next === 62 || next === 9 || next === 10 || next === 13 || next === 47) {
      return { count, capped: true }
    }
    probe = idx + 4
  }
  return { count, capped: false }
}

/**
 * Parse one worksheet's rows into arrays of display strings.
 *
 * When `caps.collectStart` / `caps.collectCount` are provided, only row 0 (if
 * `keepFirstRow`) and the requested window `[collectStart, collectStart + collectCount)`
 * are materialized as cell arrays; once collected, cell parsing stops early and
 * remaining `<row` tags are counted without allocating row arrays.
 *
 * @param {string} sheetXml
 * @param {string[]} sharedStrings
 * @param {Set<number>} dateStyles
 * @param {{maxRows?:number, maxCells?:number, date1904?:boolean, collectStart?:number, collectCount?:number, keepFirstRow?:boolean}} caps
 * @returns {{rows:string[][], headerRow?:string[], totalSheetRows:number, truncated:boolean}}
 */
export function parseSheet(sheetXml, sharedStrings, dateStyles, caps = {}) {
  const maxRows = Number.isFinite(caps.maxRows) ? caps.maxRows : 100000
  const maxCells = Number.isFinite(caps.maxCells) ? caps.maxCells : 2000000
  const date1904 = caps.date1904 === true
  const windowed = Number.isFinite(caps.collectStart) && Number.isFinite(caps.collectCount)
  const collectStart = windowed ? Math.max(0, Math.trunc(caps.collectStart)) : 0
  const collectEnd = windowed ? collectStart + Math.max(0, Math.trunc(caps.collectCount)) : maxRows
  const keepFirstRow = windowed && caps.keepFirstRow === true

  const rows = []
  let headerRow
  let totalSheetRows = 0
  const cellCounter = { count: 0, max: maxCells, hit: false }
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let r

  while ((r = rowRe.exec(sheetXml)) !== null) {
    const idx = totalSheetRows
    totalSheetRows += 1

    const needRow = !windowed || (idx >= collectStart && idx < collectEnd) || (keepFirstRow && idx === 0)
    if (needRow) {
      const parsedRow = parseRowCells(r[1], sharedStrings, dateStyles, date1904, cellCounter)
      if (keepFirstRow && idx === 0) headerRow = parsedRow
      if (!windowed || (idx >= collectStart && idx < collectEnd)) {
        rows.push(parsedRow)
      }
      if (cellCounter.hit) {
        return { rows, headerRow, totalSheetRows, truncated: true }
      }
    }

    if (totalSheetRows >= maxRows) {
      return { rows, headerRow, totalSheetRows, truncated: true }
    }

    // Early-stop cell parsing once the requested window (and optional header) has been collected!
    if (windowed && totalSheetRows >= collectEnd && (!keepFirstRow || headerRow !== undefined)) {
      const rest = countRemainingRows(sheetXml, rowRe.lastIndex, maxRows - totalSheetRows)
      totalSheetRows += rest.count
      return { rows, headerRow, totalSheetRows, truncated: rest.capped }
    }
  }
  return { rows, headerRow, totalSheetRows, truncated: false }
}

/**
 * List sheets as {name, rid, target} resolved through the workbook rels.
 * @returns {Array<{name:string, rid:string, target:string}>}
 */
export function listSheets(workbookXml, relsXml) {
  const relMap = new Map()
  for (const rel of parseRels(relsXml)) {
    relMap.set(rel.id, rel.target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const sheets = []
  const sheetRe = /<sheet\b([^>]*?)\/?>/g
  let m
  while ((m = sheetRe.exec(workbookXml)) !== null) {
    const name = attr(m[1], 'name')
    const rid = attr(m[1], 'r:id') ?? attr(m[1], 'id')
    if (name === undefined || rid === undefined) continue
    const target = relMap.get(rid)
    sheets.push({ name: unescapeXml(name), rid, target: target === undefined ? '' : target })
  }
  return sheets
}

/**
 * Read an XLSX buffer into a bounded, model-facing text window of one sheet.
 * @param {Buffer} buffer
 * @param {{offset:number, limit:number, sheet?:string|number, hasHeader?:boolean, maxCellLength?:number, maxBytes?:number, scanMaxBytes?:number}} req
 * @returns {{text:string, sheetName:string, sheets:string[], returned:number, totalRows:number, truncatedByBytes:boolean, warnings:string[]}}
 */
export function readXlsx(buffer, req) {
  const warnings = []
  if (!looksLikeZip(buffer)) {
    throw new Error('not an XLSX container (no ZIP signature). Legacy binary .xls is not supported; save as .xlsx first.')
  }
  const zipOpts = req.scanMaxBytes !== undefined ? { maxBytes: req.scanMaxBytes } : {}
  const readText = (name, optional) => {
    try {
      return readZipText(buffer, name, { ...zipOpts, optional })
    } catch (error) {
      throw new Error(`not a readable XLSX: missing ${name} (${error?.message ?? String(error)})`)
    }
  }

  const workbookXml = readText('xl/workbook.xml', false)
  const date1904 = isDate1904(workbookXml)
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

  const maxCellLength = Number.isFinite(req.maxCellLength) ? req.maxCellLength : 500
  const maxBytes = Number.isFinite(req.maxBytes) ? req.maxBytes : 50 * 1024
  const hasHeader = req.hasHeader !== false
  const dataStart = hasHeader ? 1 : 0
  const start = Math.max(0, req.offset - 1)

  const parsed = parseSheet(sheetXml, sharedStrings, dateStyles, {
    maxRows: 200000,
    date1904,
    collectStart: dataStart + start,
    collectCount: req.limit,
    keepFirstRow: hasHeader,
  })
  if (parsed.truncated) warnings.push('the sheet scan stopped at a row/cell cap; totals may be short')

  const totalRows = hasHeader ? Math.max(0, parsed.totalSheetRows - 1) : parsed.totalSheetRows
  const page = parsed.rows
  const headerRow = hasHeader ? (parsed.headerRow ?? []) : undefined

  // Compute uniform column width across header + page rows.
  let width = headerRow ? headerRow.length : 0
  for (const row of page) {
    if (row.length > width) width = row.length
  }
  const formatRow = (row) => {
    const cols = Array.from({ length: width }, (_, i) => mdCell(row?.[i], maxCellLength))
    return `| ${cols.join(' | ')} |`
  }

  const tableLines = [`## ${chosen.name}`]
  let bytes = Buffer.byteLength(tableLines[0], 'utf8') + 1
  if (hasHeader && width > 0) {
    const hLine = formatRow(headerRow)
    const sepLine = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
    tableLines.push(hLine, sepLine)
    bytes += Buffer.byteLength(hLine, 'utf8') + Buffer.byteLength(sepLine, 'utf8') + 2
  }

  // Enforce maxBytes row-by-row on the primary sheet (never dropping row 0 on hasHeader: false).
  let shown = 0
  let primaryTruncated = false
  for (let r = 0; r < page.length; r += 1) {
    const line = width > 0 ? formatRow(page[r]) : '|  |'
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) {
      if (shown === 0) {
        const notice = '... (row truncated to fit output cap)'
        const budget = Math.max(64, maxBytes - bytes - Buffer.byteLength(notice, 'utf8') - 16)
        tableLines.push(`${truncateUtf8(line, budget)}${notice}`)
        shown += 1
      }
      primaryTruncated = true
      break
    }
    bytes += size
    tableLines.push(line)
    shown += 1
  }

  const parts = [tableLines.join('\n')]
  let truncatedByBytes = primaryTruncated
  const focused = req.sheet !== undefined
  if (!focused && !primaryTruncated) {
    for (const section of sheets) {
      if (section === chosen || section.target === '') continue
      let header = []
      try {
        const xml = readText(sheetPart(section.target), false)
        header = parseSheet(xml, sharedStrings, dateStyles, { maxRows: 1, date1904 }).rows[0] ?? []
      } catch (error) {
        warnings.push(`sheet "${section.name}" was not previewed (${error?.message ?? String(error)})`)
      }
      const preview = `## ${section.name}\n${markdownTable([header], maxCellLength)}\n\n(header only; pass sheet=${JSON.stringify(section.name)} to read it)`
      const size = Buffer.byteLength(preview, 'utf8') + 2
      if (bytes + size > maxBytes) { truncatedByBytes = true; break }
      bytes += size
      parts.push(preview)
    }
  }

  const end = start + shown
  let footer
  if (primaryTruncated) {
    footer = `(Output capped at ${maxBytes} bytes. Showing rows ${req.offset}-${end} of ${totalRows} on "${chosen.name}". Use offset=${end + 1} to continue.)`
  } else if (end < totalRows) {
    footer = `(Showing rows ${req.offset}-${end} of ${totalRows} on "${chosen.name}". Use offset=${end + 1} to continue.)`
  } else if (truncatedByBytes) {
    footer = `(End of sheet "${chosen.name}" - ${totalRows} data rows${hasHeader ? ', 1 header row' : ''}; remaining sheet previews omitted due to output cap)`
  } else {
    footer = `(End of sheet "${chosen.name}" - ${totalRows} data rows${hasHeader ? ', 1 header row' : ''})`
  }

  const body = `${parts.join('\n\n')}\n\n${footer}`
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
