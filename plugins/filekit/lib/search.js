/**
 * Bounded in-document text search for filekit.
 *
 * `filekit_search` answers "which part of this document mentions X?" without
 * dumping the whole body: it extracts the document's text units through the same
 * parsers the read/outline tools use, stops early once the match/byte cap is
 * reached, and reports matching units with exact locations aligned to the read
 * tools (DOCX block offset, XLSX sheet!row, PPTX slide + speaker notes, PDF page).
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { looksLikeZip, listZipEntries } from './zip.js'
import { parseDocumentXml, parseHyperlinkRels } from './docx.js'
import { isDate1904, listSheets, parseSharedStrings, parseDateStyles, parseSheet } from './xlsx.js'
import { extractSlideNotes, listSlides, renderSlideXml } from './pptx.js'
import { extractPdfText } from './pdf.js'
import { readZipText, sheetPart } from './ooxml.js'

const SUPPORTED = ['docx', 'xlsx', 'pptx', 'pdf']

function clip(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}\u2026` : s
}

/**
 * Stream document units into `visit(loc, text)` and stop immediately if `visit`
 * returns `true` (match limit or byte cap reached).
 */
function scanDocumentUnits(buffer, format, warnings, maxPdfPages, scanMaxBytes, visit) {
  const zipOpts = scanMaxBytes !== undefined ? { maxBytes: scanMaxBytes } : {}

  if (format === 'docx') {
    if (!looksLikeZip(buffer)) throw new Error('not a DOCX container (no ZIP signature)')
    const relsXml = readZipText(buffer, 'word/_rels/document.xml.rels', { ...zipOpts, optional: true })
    const links = relsXml !== null ? parseHyperlinkRels(relsXml) : new Map()
    const blocks = parseDocumentXml(readZipText(buffer, 'word/document.xml', zipOpts), links)
    let para = 0
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]
      const blockNo = i + 1
      if (block.kind === 'para') {
        para += 1
        // Include exact 1-based block offset alongside paragraph index so callers
        // can pass `offset=blockNo` directly to `filekit_read_docx`.
        if (visit(`block ${blockNo} / para ${para}`, block.text)) return
      } else {
        for (let r = 0; r < block.rows.length; r += 1) {
          for (let c = 0; c < block.rows[r].length; c += 1) {
            if (visit(`block ${blockNo} table r${r + 1} c${c + 1}`, block.rows[r][c])) return
          }
        }
      }
    }
    return
  }

  if (format === 'xlsx') {
    if (!looksLikeZip(buffer)) throw new Error('not an XLSX container (no ZIP signature)')
    const readText = (name) => readZipText(buffer, name, { ...zipOpts, optional: true })
    const workbookXml = readText('xl/workbook.xml')
    if (workbookXml === null) throw new Error('not a readable XLSX: missing xl/workbook.xml')
    const date1904 = isDate1904(workbookXml)
    const sheets = listSheets(workbookXml, readText('xl/_rels/workbook.xml.rels') ?? '')
    if (sheets.length === 0) throw new Error('XLSX has no worksheets')
    const sharedXml = readText('xl/sharedStrings.xml')
    const sharedStrings = sharedXml === null ? [] : parseSharedStrings(sharedXml)
    const dateStyles = parseDateStyles(readText('xl/styles.xml'))
    for (const sheet of sheets) {
      if (sheet.target === '') continue
      try {
        const parsed = parseSheet(readText(sheetPart(sheet.target)) ?? '', sharedStrings, dateStyles, {
          maxRows: 200000,
          date1904,
        })
        for (let r = 0; r < parsed.rows.length; r += 1) {
          const text = parsed.rows[r].map((cell) => String(cell)).join(' | ')
          if (text.trim() !== '') {
            if (visit(`${sheet.name}!row ${r + 1}`, text)) return
          }
        }
      } catch (error) {
        warnings.push(`sheet "${sheet.name}" not searched (${error?.message ?? String(error)})`)
      }
    }
    return
  }

  if (format === 'pptx') {
    if (!looksLikeZip(buffer)) throw new Error('not a PPTX container (no ZIP signature)')
    const readText = (name) => readZipText(buffer, name, zipOpts)
    const names = new Set(listZipEntries(buffer).map((entry) => entry.name))
    if (!names.has('ppt/presentation.xml')) throw new Error('not a readable PPTX: missing ppt/presentation.xml')
    const slides = listSlides(
      readText('ppt/presentation.xml'),
      names.has('ppt/_rels/presentation.xml.rels') ? readText('ppt/_rels/presentation.xml.rels') : '',
    )
    for (let i = 0; i < slides.length; i += 1) {
      let body = ''
      try {
        body = renderSlideXml(readText(slides[i]), 200)
      } catch (error) {
        warnings.push(`slide ${i + 1}: ${error?.message ?? String(error)}`)
      }
      for (const line of body.split('\n')) {
        const text = line.trim()
        if (text !== '') {
          if (visit(`slide ${i + 1}`, text)) return
        }
      }
      const notes = extractSlideNotes(buffer, names, slides[i], scanMaxBytes)
      if (notes !== '') {
        for (const line of notes.split('\n')) {
          const text = line.trim()
          if (text !== '') {
            if (visit(`slide ${i + 1} notes`, text)) return
          }
        }
      }
    }
    return
  }

  // pdf
  const doc = extractPdfText(buffer, {
    offset: 1,
    limit: maxPdfPages,
    ...(scanMaxBytes !== undefined ? { maxStreamBytes: scanMaxBytes } : {}),
  })
  if (doc.pageCount > doc.pages.length) {
    warnings.push(`search covered only the first ${doc.pages.length} of ${doc.pageCount} pages`)
  }
  for (const warning of doc.warnings) warnings.push(warning)
  for (const page of doc.pages) {
    for (const line of page.text.split(/\r?\n/)) {
      const text = line.trim()
      if (text !== '') {
        if (visit(`p${page.page}`, text)) return
      }
    }
  }
}

/**
 * @param {Buffer} buffer
 * @param {'docx'|'xlsx'|'pptx'|'pdf'} format
 * @param {string} query
 * @param {{limit?:number, ignoreCase?:boolean, maxBytes?:number, maxPdfPages?:number, snippet?:number, scanMaxBytes?:number}} [opts]
 * @returns {{text:string, hits:number, scanned:number, truncated:boolean, warnings:string[]}}
 */
export function searchDocument(buffer, format, query, opts = {}) {
  const fmt = String(format).toLowerCase()
  if (!SUPPORTED.includes(fmt)) {
    throw new Error(`search is not supported for "${format}"; supported: ${SUPPORTED.join(', ')}`)
  }
  const needleRaw = String(query ?? '')
  if (needleRaw === '') throw new Error('query must be a non-empty string')
  const ignoreCase = opts.ignoreCase !== false
  const needle = ignoreCase ? needleRaw.toLowerCase() : needleRaw
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.trunc(opts.limit) : 50
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.trunc(opts.maxBytes) : 50 * 1024
  const maxPdfPages = Number.isFinite(opts.maxPdfPages) && opts.maxPdfPages > 0 ? Math.trunc(opts.maxPdfPages) : 32
  const snippet = Number.isFinite(opts.snippet) && opts.snippet > 0 ? Math.trunc(opts.snippet) : 200
  const scanMaxBytes = Number.isFinite(opts.scanMaxBytes) && opts.scanMaxBytes > 0 ? Math.trunc(opts.scanMaxBytes) : undefined

  const warnings = []
  const lines = []
  let bytes = 0
  let hits = 0
  let scanned = 0
  let truncated = false

  scanDocumentUnits(buffer, fmt, warnings, maxPdfPages, scanMaxBytes, (loc, text) => {
    scanned += 1
    const hay = ignoreCase ? text.toLowerCase() : text
    if (!hay.includes(needle)) return false
    if (hits >= limit) {
      truncated = true
      return true
    }
    const line = `- ${loc}: ${clip(text, snippet)}`
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) {
      truncated = true
      return true
    }
    bytes += size
    lines.push(line)
    hits += 1
    return false
  })

  const footer = hits === 0
    ? '(no matches)'
    : `${truncated ? '(more matches than shown)' : '(all matches)'} ${hits} match(es) in ${scanned} text unit(s)`
  const text = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return { text, hits, scanned, truncated, warnings }
}
