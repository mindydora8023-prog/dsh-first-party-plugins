/**
 * Bounded DOCX main-body reader (paragraphs + tables), no third-party dependency.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the body. This module reads
 * only that part and extracts:
 *   - main-body paragraphs, in document order (depth-tracked, skipping mc:Fallback);
 *   - table rows, each rendered as a Markdown table.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { looksLikeZip } from './zip.js'
import { headingPrefix, markdownTable } from './md.js'
import { attr, parseRels, readZipText, truncateUtf8, unescapeXml } from './ooxml.js'

export { unescapeXml }

/** True when `ch` can terminate an XML tag name. */
function isTagBoundary(ch) {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * Strip all occurrences of a possibly-nested element (such as `mc:Fallback`)
 * so alternate DrawingML/VML markup is not duplicated.
 */
function stripElement(xml, tagName) {
  const openToken = `<${tagName}`
  const closeToken = `</${tagName}>`
  if (!xml.includes(openToken)) return xml
  let out = ''
  let pos = 0
  while (pos < xml.length) {
    const start = xml.indexOf(openToken, pos)
    if (start === -1) {
      out += xml.slice(pos)
      break
    }
    const after = xml[start + openToken.length]
    if (after !== undefined && !isTagBoundary(after)) {
      out += xml.slice(pos, start + openToken.length)
      pos = start + openToken.length
      continue
    }
    out += xml.slice(pos, start)
    const openEnd = xml.indexOf('>', start)
    if (openEnd === -1) break
    if (xml[openEnd - 1] === '/') {
      pos = openEnd + 1
      continue
    }
    let depth = 1
    let cur = openEnd + 1
    while (cur < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(openToken, cur)
      const nextClose = xml.indexOf(closeToken, cur)
      if (nextClose === -1) {
        cur = xml.length
        break
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const ch = xml[nextOpen + openToken.length]
        const oe = xml.indexOf('>', nextOpen)
        if (oe === -1) { cur = xml.length; break }
        if ((ch === undefined || isTagBoundary(ch)) && xml[oe - 1] !== '/') {
          depth += 1
        }
        cur = oe + 1
      } else {
        depth -= 1
        cur = nextClose + closeToken.length
      }
    }
    pos = cur
  }
  return out
}

/**
 * Find the end index (past closing tag) of a balanced XML element whose opening
 * tag starts at `openStart` (with `openEnd` pointing at its `>`).
 */
function findBalancedClose(xml, tagName, openEnd) {
  const openToken = `<${tagName}`
  const closeToken = `</${tagName}>`
  let depth = 1
  let cur = openEnd + 1
  while (cur < xml.length && depth > 0) {
    const nextOpen = xml.indexOf(openToken, cur)
    const nextClose = xml.indexOf(closeToken, cur)
    if (nextClose === -1) return { innerEnd: xml.length, afterClose: xml.length }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = xml[nextOpen + openToken.length]
      const oe = xml.indexOf('>', nextOpen)
      if (oe === -1) return { innerEnd: xml.length, afterClose: xml.length }
      if ((ch === undefined || isTagBoundary(ch)) && xml[oe - 1] !== '/') {
        depth += 1
      }
      cur = oe + 1
    } else {
      depth -= 1
      if (depth === 0) return { innerEnd: nextClose, afterClose: nextClose + closeToken.length }
      cur = nextClose + closeToken.length
    }
  }
  return { innerEnd: xml.length, afterClose: xml.length }
}

/**
 * Extract top-level balanced occurrences of `tagName` inside `xml`.
 * @param {string} xml
 * @param {string} tagName
 * @returns {string[]} inner XML of each top-level occurrence
 */
function extractTopLevelElements(xml, tagName) {
  const results = []
  const openToken = `<${tagName}`
  let pos = 0
  while (pos < xml.length) {
    const start = xml.indexOf(openToken, pos)
    if (start === -1) break
    const after = xml[start + openToken.length]
    if (after !== undefined && !isTagBoundary(after)) {
      pos = start + openToken.length
      continue
    }
    const openEnd = xml.indexOf('>', start)
    if (openEnd === -1) break
    if (xml[openEnd - 1] === '/') {
      pos = openEnd + 1
      continue
    }
    const { innerEnd, afterClose } = findBalancedClose(xml, tagName, openEnd)
    results.push(xml.slice(openEnd + 1, innerEnd))
    pos = afterClose
  }
  return results
}

/**
 * Extract the visible text of one `w:p` fragment.
 * Tabs and breaks keep their position; hyperlinks render as `[text](url)`.
 */
function paragraphText(fragment, links) {
  let out = ''
  const runRe = /<(w:t)(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g
  let m
  while ((m = runRe.exec(fragment)) !== null) {
    if (m[1] === 'w:t') out += unescapeXml(m[2])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else if (m[0].startsWith('<w:br')) out += '\n'
    else {
      const rid = attr(m[3], 'r:id')
      const label = paragraphText(m[4], links).replace(/\s+/g, ' ').trim()
      const href = rid === undefined ? '' : links.get(rid) ?? ''
      if (label === '') continue
      out += href === '' ? label : `[${label}](${href})`
    }
  }
  return out
}

/** Map `rId` to a hyperlink target from word/_rels/document.xml.rels. */
export function parseHyperlinkRels(xml) {
  const links = new Map()
  for (const rel of parseRels(xml)) {
    if (/\/hyperlink$/i.test(rel.type) || rel.type.includes('/hyperlink')) {
      links.set(rel.id, rel.target)
    }
  }
  return links
}

/** Heading level of one paragraph (1..9), or 0 for body text. */
function headingLevel(fragment) {
  const outline = /<w:outlineLvl\b([^>]*?)\/?>/.exec(fragment)
  if (outline !== null) {
    const val = attr(outline[1], 'w:val')
    const level = Number(val) + 1
    if (Number.isInteger(level) && level >= 1 && level <= 9) return level
  }
  const style = /<w:pStyle\b([^>]*?)\/?>/.exec(fragment)
  if (style === null) return 0
  const val = attr(style[1], 'w:val') ?? ''
  const named = /^heading\s*(\d)$/i.exec(val.replace(/([a-z])(\d)/i, '$1 $2'))
  if (named === null) return 0
  const level = Number(named[1])
  return level >= 1 && level <= 9 ? level : 0
}

/** Turn one top-level `w:tbl` inner XML into rows of cell strings (depth-safe). */
function tableRows(tblInner, links) {
  const rows = []
  for (const trInner of extractTopLevelElements(tblInner, 'w:tr')) {
    const cells = []
    for (const tcInner of extractTopLevelElements(trInner, 'w:tc')) {
      const paras = []
      // Extract all paragraphs in cell order (including any nested table cells flattened cleanly).
      const pRe = /<w:p(?=[\s>])[^>]*>([\s\S]*?)<\/w:p>/g
      let p
      while ((p = pRe.exec(tcInner)) !== null) {
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
 * Parse `word/document.xml` into ordered top-level blocks (paragraphs and tables).
 * Skips `mc:Fallback` alternate markup and uses depth-tracked `<w:tbl>`/`<w:p>` scanning.
 *
 * @param {string} xml
 * @param {Map<string,string>} [links] hyperlink rId -> target
 * @returns {Array<{kind:'para', text:string, level:number} | {kind:'table', rows:string[][]}>}
 */
export function parseDocumentXml(xml, links = new Map()) {
  const clean = stripElement(String(xml ?? ''), 'mc:Fallback')
  const bodyStart = clean.indexOf('<w:body')
  let body = clean
  if (bodyStart >= 0) {
    const openEnd = clean.indexOf('>', bodyStart)
    if (openEnd >= 0) {
      const bodyEnd = clean.indexOf('</w:body>', openEnd + 1)
      body = bodyEnd >= 0 ? clean.slice(openEnd + 1, bodyEnd) : clean.slice(openEnd + 1)
    }
  }

  const blocks = []
  let pos = 0
  while (pos < body.length) {
    const nextTbl = body.indexOf('<w:tbl', pos)
    const nextP = body.indexOf('<w:p', pos)
    if (nextTbl === -1 && nextP === -1) break

    let tagName
    let start
    if (nextTbl !== -1 && (nextP === -1 || nextTbl < nextP)) {
      tagName = 'w:tbl'
      start = nextTbl
    } else {
      tagName = 'w:p'
      start = nextP
    }

    const after = body[start + tagName.length + 1]
    if (after !== undefined && !isTagBoundary(after)) {
      pos = start + tagName.length + 1
      continue
    }
    const openEnd = body.indexOf('>', start)
    if (openEnd === -1) break
    if (body[openEnd - 1] === '/') {
      pos = openEnd + 1
      continue
    }

    const { innerEnd, afterClose } = findBalancedClose(body, tagName, openEnd)
    const inner = body.slice(openEnd + 1, innerEnd)
    if (tagName === 'w:tbl') {
      blocks.push({ kind: 'table', rows: tableRows(inner, links) })
    } else {
      const text = paragraphText(inner, links)
      if (text.trim() !== '') {
        blocks.push({ kind: 'para', text, level: headingLevel(inner) })
      }
    }
    pos = afterClose
  }
  return blocks
}

/**
 * Read a DOCX buffer into a bounded, model-facing text window.
 * @param {Buffer} buffer
 * @param {{offset:number, limit:number, hasHeader?:boolean, maxCellLength?:number, maxBytes?:number, scanMaxBytes?:number}} req
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
  const zipOpts = req.scanMaxBytes !== undefined ? { maxBytes: req.scanMaxBytes } : {}
  let xmlStr
  try {
    xmlStr = readZipText(buffer, 'word/document.xml', zipOpts)
  } catch (error) {
    throw new Error(`not a readable DOCX: ${error?.message ?? String(error)}`)
  }
  let blocks
  try {
    const relsStr = readZipText(buffer, 'word/_rels/document.xml.rels', { ...zipOpts, optional: true })
    const links = relsStr !== null ? parseHyperlinkRels(relsStr) : new Map()
    blocks = parseDocumentXml(xmlStr, links)
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
    const size = Buffer.byteLength(rendered, 'utf8') + 2
    if (bytes + size > maxBytes) {
      if (returned === 0) {
        // Never return 0 blocks when at least one block exists (prevents infinite pagination loops).
        const notice = '\n... (block truncated to fit output cap)'
        const budget = Math.max(64, maxBytes - bytes - Buffer.byteLength(notice, 'utf8') - 16)
        lines.push(`${truncateUtf8(rendered, budget)}${notice}`)
        returned += 1
      }
      truncatedByBytes = true
      break
    }
    bytes += size
    lines.push(rendered)
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
