/**
 * Bounded PPTX reader (no third-party dependency).
 *
 * A .pptx is a ZIP. Slides live at ppt/slides/slideN.xml and are listed, in
 * presentation order, by ppt/presentation.xml plus its rels. Each slide becomes
 * one block: a heading, then its text shapes and tables in document order.
 * Speaker notes are appended only when the notes part has text.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { listZipEntries, looksLikeZip } from './zip.js'
import { markdownTable } from './md.js'
import { attr, parseRels, readZipText, resolvePart, truncateUtf8, unescapeXml } from './ooxml.js'

/** Visible text of one shape tree fragment, paragraphs separated by newlines. */
export function shapeText(fragment) {
  const paras = []
  // `a:t` is also a prefix of `a:tbl` / `a:tc` / `a:tr`, so the tag name has to
  // end at a delimiter. The same rule applies to `a:p` versus `a:pPr`.
  const pRe = /<a:p(?=[\s>])[^>]*>([\s\S]*?)<\/a:p>/g
  let p
  while ((p = pRe.exec(fragment)) !== null) {
    let text = ''
    const tRe = /<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/g
    let t
    while ((t = tRe.exec(p[1])) !== null) text += unescapeXml(t[1])
    if (text.trim() !== '') paras.push(text.trim())
  }
  if (paras.length > 0) return paras.join('\n')
  // A fixture or a producer may put the text run directly under the cell.
  let loose = ''
  const tRe = /<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>/g
  let t
  while ((t = tRe.exec(fragment)) !== null) loose += unescapeXml(t[1])
  return loose.trim()
}

/** One a:tbl fragment as rows of cell strings. */
function tableRows(fragment) {
  const rows = []
  const trRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g
  let tr
  while ((tr = trRe.exec(fragment)) !== null) {
    const cells = []
    const tcRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g
    let tc
    while ((tc = tcRe.exec(tr[1])) !== null) cells.push(shapeText(tc[1]))
    rows.push(cells)
  }
  return rows
}

/**
 * Slide order as part names, e.g. ppt/slides/slide1.xml.
 * @returns {string[]}
 */
export function listSlides(presentationXml, relsXml) {
  const rels = new Map()
  for (const rel of parseRels(relsXml)) {
    rels.set(rel.id, rel.target.replace(/^\//, ''))
  }
  const slides = []
  const sldRe = /<p:sldId(?=[\s>])([^>]*?)\/?>/g
  let m
  while ((m = sldRe.exec(presentationXml)) !== null) {
    const rid = attr(m[1], 'r:id')
    if (rid === undefined) continue
    const target = rels.get(rid)
    if (target === undefined) continue
    slides.push(target.startsWith('ppt/') ? target : `ppt/${target.replace(/^\.\//, '')}`)
  }
  return slides
}

/**
 * Speaker-notes part for one slide.
 * The slide rels are authoritative; a same-numbered notes part is only a fallback.
 */
export function notesPart(buffer, names, slidePart, scanMaxBytes) {
  const zipOpts = scanMaxBytes !== undefined ? { maxBytes: scanMaxBytes } : {}
  const relsName = slidePart.replace(/^(.*)\/([^/]+)$/, '$1/_rels/$2.rels')
  if (names.has(relsName)) {
    const xml = readZipText(buffer, relsName, { ...zipOpts, optional: true })
    if (xml !== null) {
      for (const rel of parseRels(xml)) {
        if (!/notesSlide/.test(`${rel.type}${rel.target}`)) continue
        if (rel.target === '') continue
        const part = resolvePart(slidePart, rel.target)
        if (names.has(part)) return part
      }
    }
  }
  const guessed = slidePart.replace('ppt/slides/', 'ppt/notesSlides/').replace(/slide(\d+)\.xml$/, 'notesSlide$1.xml')
  return names.has(guessed) ? guessed : ''
}

/** Extract trimmed speaker notes text for one slide, or '' if absent. */
export function extractSlideNotes(buffer, names, slidePart, scanMaxBytes) {
  const part = notesPart(buffer, names, slidePart, scanMaxBytes)
  if (part === '') return ''
  try {
    const xml = readZipText(buffer, part, scanMaxBytes !== undefined ? { maxBytes: scanMaxBytes } : {})
    return shapeText(xml).trim()
  } catch {
    return ''
  }
}

/** Render one slide XML as Markdown without the heading. */
export function renderSlideXml(xml, maxCellLength) {
  const body = []
  const tableRe = /<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g
  let last = 0
  let t
  const flush = (segment) => {
    const text = shapeText(segment)
    if (text !== '') body.push(text)
  }
  while ((t = tableRe.exec(xml)) !== null) {
    flush(xml.slice(last, t.index))
    const table = markdownTable(tableRows(t[0]), maxCellLength)
    if (table !== '') body.push(table)
    last = t.index + t[0].length
  }
  flush(xml.slice(last))
  return body.join('\n\n')
}

/**
 * Read a PPTX buffer into a bounded window of slides.
 * @param {Buffer} buffer
 * @param {{offset:number, limit:number, maxCellLength?:number, maxBytes?:number, scanMaxBytes?:number}} req
 * @returns {{text:string, returned:number, slideCount:number, truncatedByBytes:boolean, warnings:string[]}}
 */
export function readPptx(buffer, req) {
  const warnings = []
  if (!looksLikeZip(buffer)) {
    throw new Error('not a PPTX container (no ZIP signature). Legacy binary .ppt is not supported; save as .pptx first.')
  }
  const zipOpts = req.scanMaxBytes !== undefined ? { maxBytes: req.scanMaxBytes } : {}
  const names = new Set(listZipEntries(buffer).map((entry) => entry.name))
  const readText = (name) => readZipText(buffer, name, zipOpts)
  if (!names.has('ppt/presentation.xml')) {
    throw new Error('not a readable PPTX: missing ppt/presentation.xml')
  }
  const slides = listSlides(
    readText('ppt/presentation.xml'),
    names.has('ppt/_rels/presentation.xml.rels') ? readText('ppt/_rels/presentation.xml.rels') : '',
  )
  const maxCellLength = Number.isFinite(req.maxCellLength) ? req.maxCellLength : 500
  const maxBytes = Number.isFinite(req.maxBytes) ? req.maxBytes : 50 * 1024
  const start = Math.max(0, req.offset - 1)
  const end = Math.min(slides.length, start + req.limit)
  const parts = []
  let bytes = 0
  let truncatedByBytes = false
  let returned = 0
  for (let i = start; i < end; i += 1) {
    let body = ''
    try {
      body = renderSlideXml(readText(slides[i]), maxCellLength)
    } catch (error) {
      warnings.push(`slide ${i + 1}: ${error?.message ?? String(error)}`)
    }
    const notes = extractSlideNotes(buffer, names, slides[i], req.scanMaxBytes)
    if (notes !== '') body = `${body}\n\n### Notes\n${notes}`.trim()
    const chunk = `## Slide ${i + 1}\n${body === '' ? '(no extractable text)' : body}`
    const size = Buffer.byteLength(chunk, 'utf8') + 2
    if (bytes + size > maxBytes) {
      if (parts.length === 0) {
        const notice = '\n... (slide truncated to fit output cap)'
        const budget = Math.max(64, maxBytes - bytes - Buffer.byteLength(notice, 'utf8') - 16)
        parts.push(`${truncateUtf8(chunk, budget)}${notice}`)
        returned += 1
      }
      truncatedByBytes = true
      break
    }
    bytes += size
    parts.push(chunk)
    returned += 1
  }
  const last = start + returned
  let footer
  if (truncatedByBytes) footer = `(Output capped at ${maxBytes} bytes. Showing slides ${req.offset}-${last} of ${slides.length}. Use offset=${last + 1} to continue.)`
  else if (last < slides.length) footer = `(Showing slides ${req.offset}-${last} of ${slides.length}. Use offset=${last + 1} to continue.)`
  else footer = `(End of presentation - ${slides.length} slides)`
  return {
    text: parts.length > 0 ? `${parts.join('\n\n')}\n\n${footer}` : footer,
    returned,
    slideCount: slides.length,
    truncatedByBytes,
    warnings,
  }
}
