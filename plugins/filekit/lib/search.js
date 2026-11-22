/**
 * Bounded in-document text search for filekit.
 *
 * `filekit_search` answers "which part of this document mentions X?" without
 * dumping the whole body: it extracts the document's text units through the same
 * parsers the read/outline tools use, then reports the matching units with a
 * location (paragraph, table cell, sheet row, slide, or PDF page).
 *
 * Borrowed from dcd887/dsh-doc-read (`grep` mode). Plain substring match by
 * default, optional case sensitivity. Results and bytes are capped so one search
 * cannot flood the context.
 */

import { readZipEntry, looksLikeZip, listZipEntries } from './zip.js'
import { parseDocumentXml, parseHyperlinkRels } from './docx.js'
import { listSheets, parseSharedStrings, parseDateStyles, parseSheet } from './xlsx.js'
import { listSlides, renderSlideXml } from './pptx.js'
import { extractPdfText } from './pdf.js'

const SUPPORTED = ['docx', 'xlsx', 'pptx', 'pdf']

function sheetPart(target) {
  const clean = String(target).replace(/^\.?\//, '')
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

/** Flatten one document into {loc,text} units. */
function documentUnits(buffer, format, warnings, maxPdfPages) {
  const units = []
  if (format === 'docx') {
    if (!looksLikeZip(buffer)) throw new Error('not a DOCX container (no ZIP signature)')
    let links = new Map()
    try {
      links = parseHyperlinkRels(readZipEntry(buffer, 'word/_rels/document.xml.rels').toString('utf8'))
    } catch {
      links = new Map()
    }
    const blocks = parseDocumentXml(readZipEntry(buffer, 'word/document.xml').toString('utf8'), links)
    let para = 0
    for (const block of blocks) {
      if (block.kind === 'para') {
        para += 1
        units.push({ loc: `para ${para}`, text: block.text })
      } else {
        for (let r = 0; r < block.rows.length; r += 1) {
          for (let c = 0; c < block.rows[r].length; c += 1) {
            units.push({ loc: `table r${r + 1} c${c + 1}`, text: block.rows[r][c] })
          }
        }
      }
    }
    return units
  }
  if (format === 'xlsx') {
    if (!looksLikeZip(buffer)) throw new Error('not an XLSX container (no ZIP signature)')
    const readText = (name) => {
      try { return readZipEntry(buffer, name).toString('utf8') } catch { return null }
    }
    const workbookXml = readText('xl/workbook.xml')
    if (workbookXml === null) throw new Error('not a readable XLSX: missing xl/workbook.xml')
    const sheets = listSheets(workbookXml, readText('xl/_rels/workbook.xml.rels') ?? '')
    if (sheets.length === 0) throw new Error('XLSX has no worksheets')
    const sharedXml = readText('xl/sharedStrings.xml')
    const sharedStrings = sharedXml === null ? [] : parseSharedStrings(sharedXml)
    const dateStyles = parseDateStyles(readText('xl/styles.xml'))
    for (const sheet of sheets) {
      if (sheet.target === '') continue
      try {
        const parsed = parseSheet(readText(sheetPart(sheet.target)) ?? '', sharedStrings, dateStyles, { maxRows: 200000 })
        parsed.rows.forEach((row, r) => {
          const text = row.map((cell) => String(cell)).join(' | ')
          if (text.trim() !== '') units.push({ loc: `${sheet.name}!row ${r + 1}`, text })
        })
      } catch (error) {
        warnings.push(`sheet "${sheet.name}" not searched (${error?.message ?? String(error)})`)
      }
    }
    return units
  }
  if (format === 'pptx') {
    if (!looksLikeZip(buffer)) throw new Error('not a PPTX container (no ZIP signature)')
    const readText = (name) => readZipEntry(buffer, name).toString('utf8')
    const names = new Set(listZipEntries(buffer).map((entry) => entry.name))
    if (!names.has('ppt/presentation.xml')) throw new Error('not a readable PPTX: missing ppt/presentation.xml')
    const slides = listSlides(
      readText('ppt/presentation.xml'),
      names.has('ppt/_rels/presentation.xml.rels') ? readText('ppt/_rels/presentation.xml.rels') : '',
    )
    slides.forEach((slide, i) => {
      let body = ''
      try { body = renderSlideXml(readText(slide), 200) } catch (error) {
        warnings.push(`slide ${i + 1}: ${error?.message ?? String(error)}`)
      }
      for (const line of body.split('\n')) {
        const text = line.trim()
        if (text !== '') units.push({ loc: `slide ${i + 1}`, text })
      }
    })
    return units
  }
  // pdf
  const doc = extractPdfText(buffer, { offset: 1, limit: maxPdfPages })
  for (const page of doc.pages) {
    for (const line of page.text.split(/\r?\n/)) {
      const text = line.trim()
      if (text !== '') units.push({ loc: `p${page.page}`, text })
    }
  }
  for (const warning of doc.warnings) warnings.push(warning)
  return units
}

function clip(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}\u2026` : s
}

/**
 * @param {Buffer} buffer
 * @param {'docx'|'xlsx'|'pptx'|'pdf'} format
 * @param {string} query
 * @param {{limit?:number, ignoreCase?:boolean, maxBytes?:number, maxPdfPages?:number, snippet?:number}} [opts]
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

  const warnings = []
  const units = documentUnits(buffer, fmt, warnings, maxPdfPages)

  const lines = []
  let bytes = 0
  let hits = 0
  let truncated = false
  for (const unit of units) {
    const hay = ignoreCase ? unit.text.toLowerCase() : unit.text
    if (!hay.includes(needle)) continue
    if (hits >= limit) { truncated = true; break }
    const line = `- ${unit.loc}: ${clip(unit.text, snippet)}`
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) { truncated = true; break }
    bytes += size
    lines.push(line)
    hits += 1
  }
  const footer = hits === 0
    ? '(no matches)'
    : `${truncated ? '(more matches than shown)' : '(all matches)'} ${hits} match(es) in ${units.length} text unit(s)`
  const text = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return { text, hits, scanned: units.length, truncated, warnings }
}
