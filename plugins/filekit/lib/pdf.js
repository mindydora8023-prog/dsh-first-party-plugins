/**
 * Minimal, dependency-free PDF text extractor facade.
 *
 * Delegates to modular internals under `lib/pdf/{lexer,xref,filters,cmap,content}.js`.
 * Only `node:zlib` is used; no network, no child processes, no npm packages.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { DEFAULT_MAX_STREAM_BYTES, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pdf/lexer.js'
import {
  PdfDoc,
  collectContentObjects,
  collectPages,
  fallbackPages,
  findRoot,
  findTrailerDict,
  parseClassicXref,
  scanObjects,
} from './pdf/xref.js'
import { decodeStream } from './pdf/filters.js'
import { getPageFonts } from './pdf/cmap.js'
import { extractContentText } from './pdf/content.js'

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  throw new Error('buffer must be a Buffer or Uint8Array holding PDF bytes')
}

/**
 * Extract plain text from a page range of a PDF buffer.
 * @param {Buffer|Uint8Array} buffer
 * @param {{offset?:number, limit?:number, maxStreamBytes?:number}} [options]
 * @returns {{pageCount:number, pages:Array<{page:number, text:string}>, warnings:string[]}}
 */
export function extractPdfText(buffer, options = {}) {
  const buf = toBuffer(buffer)
  if (buf.length < 5) {
    throw new Error('input is not a PDF file: data is empty or too short')
  }
  const head = buf.toString('latin1', 0, Math.min(buf.length, 1024))
  if (head.indexOf('%PDF-') === -1) {
    throw new Error('input is not a PDF file: missing %PDF- header; pass the raw PDF bytes')
  }

  const maxStreamBytes = Number.isFinite(options.maxStreamBytes) && options.maxStreamBytes > 0
    ? Math.trunc(options.maxStreamBytes)
    : DEFAULT_MAX_STREAM_BYTES

  const warnings = []
  let offsets = null
  let trailer = null
  let usedXrefStream = false

  // Classic xref reads only tail/xref byte ranges; full latin1 scan is deferred to fallback.
  try {
    const classic = parseClassicXref(buf)
    if (classic && classic.xrefStream) usedXrefStream = true
    else if (classic && classic.offsets && classic.offsets.size) {
      offsets = classic.offsets
      trailer = classic.trailer
    }
  } catch {
    offsets = null
    trailer = null
  }

  if (!offsets) {
    const latin1 = buf.toString('latin1')
    offsets = scanObjects(buf, latin1)
    if (offsets.size) {
      trailer = findTrailerDict(buf, latin1)
      if (usedXrefStream) {
        warnings.push(
          'this PDF uses cross-reference streams (PDF 1.5+); object offsets were recovered by scanning the file',
        )
      }
    }
  }

  if (!offsets || offsets.size === 0) {
    throw new Error(
      'this PDF uses cross-reference streams (PDF 1.5+) and no classic xref table or readable objects were found; text extraction is not supported for this file',
    )
  }

  const doc = new PdfDoc(buf, offsets)

  if (trailer && trailer.map.has('Encrypt')) {
    warnings.push('detected an encrypted PDF; only unencrypted text is attempted')
  }

  const rootObj = findRoot(doc, trailer)
  let pages = rootObj ? collectPages(doc, rootObj) : []
  if (!pages.length) pages = fallbackPages(doc)

  if (!pages.length && usedXrefStream) {
    throw new Error(
      'this PDF uses cross-reference streams (PDF 1.5+) with pages stored in object streams; no classic page objects were found, so text extraction is not supported for this file',
    )
  }

  const pageCount = pages.length

  let offset = Number.isFinite(options.offset) ? Math.floor(options.offset) : 1
  if (offset < 1) offset = 1
  let limit
  if (options.limit === undefined || options.limit === null || !Number.isFinite(options.limit)) {
    limit = DEFAULT_PAGE_LIMIT
  } else {
    limit = Math.floor(options.limit)
  }
  if (limit < 0) limit = 0
  if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT

  const startIdx = Math.min(offset - 1, pageCount)
  const endIdx = Math.min(pageCount, startIdx + limit)

  const resultPages = []
  for (let i = startIdx; i < endIdx; i += 1) {
    const pageNo = i + 1
    const page = pages[i]
    let text = ''
    try {
      const fonts = getPageFonts(doc, page.resources, pageNo, warnings, maxStreamBytes)
      const contentObjs = collectContentObjects(doc, page.dict)
      const chunks = []
      let pageBytes = 0
      for (const cobj of contentObjs) {
        const decoded = decodeStream(doc, cobj, pageNo, warnings, maxStreamBytes)
        if (decoded && decoded.length) {
          if (pageBytes + decoded.length > maxStreamBytes) {
            warnings.push(`page ${pageNo}: cumulative decoded content streams exceed ${maxStreamBytes}-byte cap; remaining streams skipped`)
            break
          }
          pageBytes += decoded.length + 1
          chunks.push(decoded)
          chunks.push(Buffer.from('\n', 'latin1'))
        }
      }
      if (chunks.length) {
        const merged = Buffer.concat(chunks)
        text = extractContentText(merged, fonts, pageNo, warnings)
      }
    } catch (e) {
      warnings.push(`page ${pageNo}: text extraction failed (${String(e && e.message ? e.message : e)})`)
      text = ''
    }
    resultPages.push({ page: pageNo, text })
  }

  const seenWarnings = new Set()
  const finalWarnings = []
  for (const w of warnings) {
    if (seenWarnings.has(w)) continue
    seenWarnings.add(w)
    finalWarnings.push(w)
  }

  return { pageCount, pages: resultPages, warnings: finalWarnings }
}
