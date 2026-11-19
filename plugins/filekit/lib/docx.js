/**
 * Bounded DOCX main-body reader (paragraphs + tables), no third-party dependency.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the body. This module reads
 * only that part and extracts:
 *   - main-body paragraphs, in document order;
 *   - table rows, each rendered as cells separated by " | ".
 *
 * It is NOT a full Word layout engine: no styles, headers/footers, footnotes,
 * comments, images, tracked-change resolution, or legacy binary .doc. Those are
 * out of scope and are reported rather than silently ignored where it matters.
 */

import { readZipEntry, looksLikeZip } from './zip.js'
import { headingPrefix, markdownTable } from './md.js'

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

/** Map one numeric character reference to a character; out-of-range -> U+FFFD. */
function codePointChar(codePoint) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '\uFFFD'
}

/** Decode XML entities, including numeric character references. */
export function unescapeXml(text) {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePointChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointChar(parseInt(dec, 10)))
}

/**
 * Extract the visible text of one `w:p` fragment.
 *
 * Tabs and breaks keep their position. A hyperlink is written as Markdown
 * `[text](url)` when the relationship target is known, which is the form a
 * model can follow without a second pass over document.xml.rels.
 */
function paragraphText(fragment, links) {
  let out = ''
  const runRe = /<(w:t)\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g
  let m
  while ((m = runRe.exec(fragment)) !== null) {
    if (m[1] === 'w:t') out += unescapeXml(m[2])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else if (m[0].startsWith('<w:br')) out += '\n'
    else {
      const rid = /r:id="([^"]*)"/.exec(m[3])
      const label = paragraphText(m[4], links).replace(/\s+/g, ' ').trim()
      const href = rid === null ? '' : links.get(rid[1]) ?? ''
      if (label === '') continue
      out += href === '' ? label : `[${label}](${href})`
    }
  }
  return out
}

/** Map `rId` to a hyperlink target from word/_rels/document.xml.rels. */
export function parseHyperlinkRels(xml) {
  const links = new Map()
  if (typeof xml !== 'string' || xml.length === 0) return links
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m
  while ((m = relRe.exec(xml)) !== null) {
    const tag = m[1]
    if (!/Type="[^"]*\/hyperlink"/.test(tag)) continue
    const id = /Id="([^"]*)"/.exec(tag)
    const target = /Target="([^"]*)"/.exec(tag)
    if (id !== null && target !== null) links.set(id[1], unescapeXml(target[1]))
  }
  return links
}

/**
 * Heading level of one paragraph, or 0 when it is body text.
 *
 * Word stores this two ways: an outline level on the paragraph, or a style
 * whose name is `HeadingN` / `heading N`. Both are read; neither invents a
 * level the document did not declare.
 */
function headingLevel(fragment) {
  const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(fragment)
  if (outline !== null) {
    const level = Number(outline[1]) + 1
    if (level >= 1 && level <= 9) return level
  }
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(fragment)
  if (style === null) return 0
  const named = /^heading\s*(\d)$/i.exec(style[1].replace(/([a-z])(\d)/i, '$1 $2'))
  if (named === null) return 0
  const level = Number(named[1])
  return level >= 1 && level <= 9 ? level : 0
}

/** Turn one `w:tbl` fragment into rows of cell strings. */
function tableRows(fragment, links) {
  const rows = []
  const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
  let tr
  while ((tr = trRe.exec(fragment)) !== null) {
    const cells = []
    const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
    let tc
    while ((tc = tcRe.exec(tr[1])) !== null) {
      const paras = []
      const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
      let p
      while ((p = pRe.exec(tc[1])) !== null) {
        const text = paragraphText(p[1], links)
        if (text.trim() !== '') paras.push(text)
      }
      cells.push(paras.join('\n'))
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Parse `word/document.xml` into ordered blocks.
 * @param {string} xml
 * @param {Map<string,string>} [links] hyperlink rId -> target
 * @returns {Array<{kind:'para', text:string, level:number} | {kind:'table', rows:string[][]}>}
 */
export function parseDocumentXml(xml, links = new Map()) {
  // Isolate the body so headers/footers or settings that share tags do not leak in.
  const bodyStart = xml.indexOf('<w:body')
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml
  const blocks = []
  // Split on tables; text between them is paragraph territory.
  const tblRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g
  let last = 0
  let t
  const flushParagraphs = (segment) => {
    const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
    let p
    while ((p = pRe.exec(segment)) !== null) {
      const text = paragraphText(p[1], links)
      if (text.trim() === '') continue
      blocks.push({ kind: 'para', text, level: headingLevel(p[1]) })
    }
  }
  while ((t = tblRe.exec(body)) !== null) {
    flushParagraphs(body.slice(last, t.index))
    blocks.push({ kind: 'table', rows: tableRows(t[0], links) })
    last = t.index + t[0].length
  }
  flushParagraphs(body.slice(last))
  return blocks
}

/**
 * Read a DOCX buffer into a bounded, model-facing text window.
 * @param {Buffer} buffer
 * @param {{offset:number, limit:number, hasHeader?:boolean, maxCellLength?:number, maxBytes?:number}} req
 *   `offset`/`limit` count output blocks (a paragraph is one block; a table is one block).
 * @returns {{text:string, returned:number, totalBlocks:number, truncatedByBytes:boolean, warnings:string[]}}
 */
export function readDocx(buffer, req) {
  const warnings = []
  if (!looksLikeZip(buffer)) {
    throw new Error(
      'not a DOCX container (no ZIP signature). Legacy binary .doc files are not supported; '
        + 'convert to .docx first.',
    )
  }
  let xmlBuf
  try {
    xmlBuf = readZipEntry(buffer, 'word/document.xml')
  } catch (error) {
    throw new Error(`not a readable DOCX: ${error?.message ?? String(error)}`)
  }
  let blocks
  try {
    let links = new Map()
    try {
      links = parseHyperlinkRels(readZipEntry(buffer, 'word/_rels/document.xml.rels').toString('utf8'))
    } catch {
      links = new Map()
    }
    blocks = parseDocumentXml(xmlBuf.toString('utf8'), links)
  } catch (error) {
    throw new Error(`not a readable DOCX: ${error?.message ?? String(error)}`)
  }
  const totalBlocks = blocks.length
  const maxCellLength = Number.isFinite(req.maxCellLength) ? req.maxCellLength : 500
  const maxBytes = Number.isFinite(req.maxBytes) ? req.maxBytes : 50 * 1024
  const start = Math.max(0, req.offset - 1)
  const end = start + req.limit
  const lines = []
  let bytes = 0
  let truncatedByBytes = false
  let returned = 0
  for (let i = start; i < blocks.length && i < end; i += 1) {
    const block = blocks[i]
    let rendered
    if (block.kind === 'para') {
      const text = block.text.replace(/[ \t]+\n/g, '\n').trim()
      rendered = `${headingPrefix(block.level)}${text}`
    } else {
      rendered = markdownTable(block.rows, maxCellLength)
    }
    const size = Buffer.byteLength(rendered, 'utf8') + 1
    if (bytes + size > maxBytes) { truncatedByBytes = true; break }
    bytes += size
    lines.push(block.kind === 'para' ? rendered : rendered)
    returned += 1
  }
  const lastBlock = start + returned
  let footer
  if (truncatedByBytes) {
    footer = `(Output capped at ${maxBytes} bytes. Showing blocks ${req.offset}-${lastBlock} of ${totalBlocks}. Use offset=${lastBlock + 1} to continue.)`
  } else if (lastBlock < totalBlocks) {
    footer = `(Showing blocks ${req.offset}-${lastBlock} of ${totalBlocks}. Use offset=${lastBlock + 1} to continue.)`
  } else {
    footer = `(End of document - ${totalBlocks} blocks)`
  }
  const body = lines.length > 0 ? `${lines.join('\n\n')}\n\n${footer}` : footer
  return { text: body, returned, totalBlocks, truncatedByBytes, warnings }
}
