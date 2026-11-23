/**
 * Minimal, bounded ZIP reader (no third-party dependency).
 *
 * DOCX/XLSX/PPTX are ZIP containers. Node ships zlib but not a ZIP reader, so
 * this module implements just what office documents need:
 *   - locate the End Of Central Directory record (EOCD), verifying comment length;
 *   - walk the central directory with full bounds checks;
 *   - inflate one entry by name, rejecting encrypted entries and enforcing caps.
 *
 * Deliberately unsupported: ZIP64, multi-disk archives, encrypted entries.
 * Each of those throws a readable error instead of guessing.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** Parsed central directories, keyed by the ZIP Buffer object. */
const CENTRAL_DIRECTORY = new WeakMap()

/**
 * Find the EOCD record, scanning backwards over a possible archive comment
 * and verifying that its declared comment length matches the trailing bytes.
 */
function findEocd(buf) {
  if (buf.length < 22) {
    throw new Error('not a ZIP container (too short); this file is not an Office document')
  }
  const maxComment = 65535
  const start = Math.max(0, buf.length - (22 + maxComment))
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (commentLen === buf.length - (i + 22)) return i
  }
  throw new Error('not a ZIP container (no end-of-central-directory record); this file is not an Office document')
}

/**
 * List the entries in a ZIP buffer.
 * @param {Buffer} buf
 * @returns {Array<{name:string, flags:number, method:number, compressedSize:number, size:number, localOffset:number}>}
 */
export function listZipEntries(buf) {
  const cached = CENTRAL_DIRECTORY.get(buf)
  if (cached !== undefined) return cached
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('this ZIP uses ZIP64, which this reader does not support')
  }
  let p = cdOffset
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('corrupt ZIP central directory')
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const recordEnd = p + 46 + nameLen + extraLen + commentLen
    if (recordEnd > buf.length) {
      throw new Error('corrupt ZIP central directory (truncated entry record)')
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, flags, method, compressedSize, size, localOffset })
    p = recordEnd
  }
  CENTRAL_DIRECTORY.set(buf, entries)
  return entries
}

/**
 * Extract one entry's bytes by exact name.
 * @param {Buffer} buf ZIP buffer
 * @param {string} name entry name (forward slashes)
 * @param {{maxBytes?:number}} opts hard cap on the inflated size
 * @returns {Buffer}
 */
export function readZipEntry(buf, name, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 64 * 1024 * 1024
  const entries = listZipEntries(buf)
  const entry = entries.find((e) => e.name === name)
  if (entry === undefined) throw new Error(`ZIP entry not found: ${name}`)
  if ((entry.flags & 0x0001) !== 0) {
    throw new Error(`ZIP entry "${name}" is encrypted; encrypted Office documents are not supported`)
  }
  if (entry.size > maxBytes) {
    throw new Error(`ZIP entry "${name}" is ${entry.size} bytes, above the ${maxBytes}-byte cap`)
  }
  const p = entry.localOffset
  if (p < 0 || p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new Error(`corrupt ZIP local header for "${name}"`)
  }
  const localFlags = buf.readUInt16LE(p + 6)
  if ((localFlags & 0x0001) !== 0) {
    throw new Error(`ZIP entry "${name}" is encrypted; encrypted Office documents are not supported`)
  }
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  if (dataStart > buf.length) throw new Error(`corrupt ZIP local header bounds for "${name}"`)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) throw new Error(`truncated ZIP entry "${name}"`)
  const raw = buf.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (entry.compressedSize > maxBytes) {
      throw new Error(`ZIP entry "${name}" is ${entry.compressedSize} bytes, above the ${maxBytes}-byte cap`)
    }
    return Buffer.from(raw)
  }
  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength: maxBytes })
  }
  throw new Error(`ZIP compression method ${entry.method} is not supported for "${name}"`)
}

/**
 * Whether a buffer looks like a ZIP container (leading local-header signature).
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG
}
