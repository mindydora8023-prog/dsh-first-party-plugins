/**
 * Shared OOXML / ZIP / XML helpers used by DOCX, XLSX, PPTX, outline, and search.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { readZipEntry } from './zip.js'

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Map one numeric character reference to a character; out-of-range -> U+FFFD. */
function codePointChar(codePoint) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '\uFFFD'
}

/**
 * Decode XML entities in a SINGLE pass (so `&amp;#65;` decodes to `&#65;`,
 * not `A`).
 * @param {string} text
 * @returns {string}
 */
export function unescapeXml(text) {
  const s = String(text ?? '')
  if (!s.includes('&')) return s
  return s.replace(/&(?:(amp|lt|gt|quot|apos)|#x([0-9a-fA-F]+)|#(\d+));/g, (match, named, hex, dec) => {
    if (named !== undefined) return XML_ENTITIES[named]
    if (hex !== undefined) return codePointChar(parseInt(hex, 16))
    if (dec !== undefined) return codePointChar(parseInt(dec, 10))
    return match
  })
}

const ATTR_RE_CACHE = new Map()

/**
 * Read an XML attribute value from a tag attribute substring (supports `"` and `'`).
 * Compiled per attribute name and cached.
 * @param {string} tag
 * @param {string} name
 * @returns {string|undefined}
 */
export function attr(tag, name) {
  let re = ATTR_RE_CACHE.get(name)
  if (re === undefined) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`)
    ATTR_RE_CACHE.set(name, re)
  }
  const m = re.exec(tag)
  if (m === null) return undefined
  return m[1] !== undefined ? m[1] : m[2]
}

/** Normalize a worksheet target to its ZIP part name (`xl/...`). */
export function sheetPart(target) {
  const clean = String(target).replace(/^\.?\//, '')
  return clean.startsWith('xl/') ? clean : `xl/${clean}`
}

/** Resolve a relative OOXML relationship target against the part that owns it. */
export function resolvePart(baseFile, target) {
  if (target.startsWith('/')) return target.replace(/^\//, '')
  const parts = baseFile.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Parse an OOXML `.rels` XML into `{ id, type, target }` records.
 * @param {string} xml
 * @returns {Array<{id:string, type:string, target:string}>}
 */
export function parseRels(xml) {
  const out = []
  if (typeof xml !== 'string' || xml.length === 0) return out
  const relRe = /<Relationship\b([^>]*?)\/?>/g
  let m
  while ((m = relRe.exec(xml)) !== null) {
    const id = attr(m[1], 'Id')
    const target = attr(m[1], 'Target')
    const type = attr(m[1], 'Type') ?? ''
    if (id !== undefined && target !== undefined) {
      out.push({ id, type, target: unescapeXml(target) })
    }
  }
  return out
}

/**
 * Read a ZIP entry as UTF-8 text with an optional byte cap and optional-missing mode.
 * @param {Buffer} buffer
 * @param {string} name
 * @param {{optional?:boolean, maxBytes?:number}} [opts]
 * @returns {string|null}
 */
export function readZipText(buffer, name, opts = {}) {
  try {
    return readZipEntry(buffer, name, opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}).toString('utf8')
  } catch (error) {
    if (opts.optional) return null
    throw error
  }
}

/**
 * Truncate a UTF-8 string so its byte length stays <= maxBytes without splitting
 * a UTF-16 surrogate pair.
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(value, maxBytes) {
  const text = String(value)
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  if (lo > 0) {
    const last = text.charCodeAt(lo - 1)
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1
  }
  return text.slice(0, lo)
}
