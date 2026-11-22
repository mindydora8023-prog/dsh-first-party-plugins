/**
 * Bounded document outline builder for filekit.
 *
 * Adds a cheap "table of contents" view WITHOUT dumping the whole document:
 *   - DOCX: heading paragraphs (outline level or HeadingN style)
 *   - XLSX: sheet names plus the first (header) row of each sheet
 *   - PPTX: one title line per slide (first text shape)
 *   - PDF : first non-empty line per page, plus the page count
 *
 * This is the capability borrowed from dcd887/dsh-doc-read (`outline` mode):
 * an agent can decide which range to read instead of paging blindly. It reuses
 * the same parsers the read tools use, so there is no second parser to drift.
 */

import { readZipEntry, looksLikeZip, listZipEntries } from './zip.js'
import { parseDocumentXml, parseHyperlinkRels } from './docx.js'
import { listSheets, parseSharedStrings, parseDateStyles, parseSheet } from './xlsx.js'
import { listSlides, renderSlideXml } from './pptx.js'
import { extractPdfText } from './pdf.js'

const SUPPORTED = ['docx', 'xlsx', 'pptx', 'pdf']

/** Normalize a worksheet target to its ZIP part name. */
function sheetPart(target) {
  const clean = String(target).replace(/^\.?\//, '')
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

function docxEntries(buffer) {
  if (!looksLikeZip(buffer)) {
    throw new Error('not a DOCX container (no ZIP signature). Legacy binary .doc files are not supported; convert to .docx first.')
  }
  let links = new Map()
  try {
    links = parseHyperlinkRels(readZipEntry(buffer, 'word/_rels/document.xml.rels').toString('utf8'))
  } catch {
    links = new Map()
  }
  const blocks = parseDocumentXml(readZipEntry(buffer, 'word/document.xml').toString('utf8'), links)
  const entries = []
  for (const block of blocks) {
    if (block.kind !== 'para') continue
    if (!(block.level > 0)) continue
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    entries.push({ label: text, hint: block.level })
  }
  return entries
}

function xlsxEntries(buffer, warnings) {
  if (!looksLikeZip(buffer)) {
    throw new Error('not an XLSX container (no ZIP signature). Legacy binary .xls is not supported; save as .xlsx first.')
  }
  const readText = (name) => {
    try { return readZipEntry(buffer, name).toString('utf8') } catch { return null }
  }
  const workbookXml = readText('xl/workbook.xml')
  if (workbookXml === null) throw new Error('not a readable XLSX: missing xl/workbook.xml')
  const relsXml = readText('xl/_rels/workbook.xml.rels') ?? ''
  const sheets = listSheets(workbookXml, relsXml)
  if (sheets.length === 0) throw new Error('XLSX has no worksheets')
  const sharedXml = readText('xl/sharedStrings.xml')
  const sharedStrings = sharedXml === null ? [] : parseSharedStrings(sharedXml)
  const dateStyles = parseDateStyles(readText('xl/styles.xml'))
  const entries = []
  for (const sheet of sheets) {
    let hint = ''
    if (sheet.target !== '') {
      try {
        const first = parseSheet(readText(sheetPart(sheet.target)) ?? '', sharedStrings, dateStyles, { maxRows: 1 }).rows[0] ?? []
        hint = first.filter((cell) => String(cell).trim() !== '').slice(0, 8).join(' | ')
      } catch (error) {
        warnings.push(`sheet "${sheet.name}" header unavailable (${error?.message ?? String(error)})`)
      }
    }
    entries.push({ label: sheet.name, hint })
  }
  return entries
}

function pptxEntries(buffer, warnings) {
  if (!looksLikeZip(buffer)) {
    throw new Error('not a PPTX container (no ZIP signature). Legacy binary .ppt is not supported; save as .pptx first.')
  }
  const readText = (name) => readZipEntry(buffer, name).toString('utf8')
  const names = new Set(listZipEntries(buffer).map((entry) => entry.name))
  if (!names.has('ppt/presentation.xml')) throw new Error('not a readable PPTX: missing ppt/presentation.xml')
  const slides = listSlides(
    readText('ppt/presentation.xml'),
    names.has('ppt/_rels/presentation.xml.rels') ? readText('ppt/_rels/presentation.xml.rels') : '',
  )
  const entries = []
  for (let i = 0; i < slides.length; i += 1) {
    let title = ''
    try {
      const body = renderSlideXml(readText(slides[i]), 120)
      title = body.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
    } catch (error) {
      warnings.push(`slide ${i + 1}: ${error?.message ?? String(error)}`)
    }
    entries.push({ label: title === '' ? '(no text)' : title, hint: i + 1 })
  }
  return entries
}

function pdfEntries(buffer, warnings, maxPages) {
  const doc = extractPdfText(buffer, { offset: 1, limit: maxPages })
  const entries = []
  for (const page of doc.pages) {
    const firstLine = page.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '(no extractable text)'
    entries.push({ label: firstLine.slice(0, 160), hint: page.page })
  }
  if (doc.pageCount > doc.pages.length) {
    warnings.push(`outline covers the first ${doc.pages.length} of ${doc.pageCount} pages`)
  }
  for (const warning of doc.warnings) warnings.push(warning)
  return entries
}

/**
 * Build a bounded outline for one document.
 *
 * @param {Buffer} buffer
 * @param {'docx'|'xlsx'|'pptx'|'pdf'} format
 * @param {{maxEntries?:number, maxBytes?:number, maxPdfPages?:number}} [opts]
 * @returns {{text:string, entryCount:number, totalEntries:number, truncated:boolean, warnings:string[]}}
 */
export function buildOutline(buffer, format, opts = {}) {
  const fmt = String(format).toLowerCase()
  if (!SUPPORTED.includes(fmt)) {
    throw new Error(`outline is not supported for "${format}"; supported: ${SUPPORTED.join(', ')}`)
  }
  const warnings = []
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? Math.trunc(opts.maxEntries) : 500
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.trunc(opts.maxBytes) : 50 * 1024
  const maxPdfPages = Number.isFinite(opts.maxPdfPages) && opts.maxPdfPages > 0 ? Math.trunc(opts.maxPdfPages) : 32

  let raw
  if (fmt === 'docx') raw = docxEntries(buffer)
  else if (fmt === 'xlsx') raw = xlsxEntries(buffer, warnings)
  else if (fmt === 'pptx') raw = pptxEntries(buffer, warnings)
  else raw = pdfEntries(buffer, warnings, maxPdfPages)

  const totalEntries = raw.length
  const lines = []
  let bytes = 0
  let shown = 0
  for (const entry of raw) {
    if (shown >= maxEntries) break
    let line
    if (fmt === 'docx') {
      const level = Math.min(Math.max(Number(entry.hint) || 1, 1), 9)
      line = `${'  '.repeat(level - 1)}- ${entry.label}`
    } else if (fmt === 'xlsx') {
      line = entry.hint === '' ? `## ${entry.label}` : `## ${entry.label}\n   ${entry.hint}`
    } else if (fmt === 'pptx') {
      line = `${entry.hint}. ${entry.label}`
    } else {
      line = `- p${entry.hint}: ${entry.label}`
    }
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > maxBytes) break
    bytes += size
    lines.push(line)
    shown += 1
  }
  const truncated = shown < totalEntries
  const footer = truncated
    ? `(outline truncated at ${shown} of ${totalEntries} entries; raise limit or read a specific range)`
    : `(outline: ${totalEntries} entries)`
  const text = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return { text, entryCount: shown, totalEntries, truncated, warnings }
}
