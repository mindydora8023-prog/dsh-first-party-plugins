/**
 * PDF stream decompression filters (FlateDecode + PNG predictors).
 * Reuses 2 row buffers in applyPngPredictor to avoid per-row allocations.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { DEFAULT_MAX_STREAM_BYTES, dictMap, nameListOf, numOf, resolve } from './lexer.js'

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function applyPngPredictor(data, parmsMap, maxStreamBytes = DEFAULT_MAX_STREAM_BYTES) {
  const colors = numOf(parmsMap.get('Colors'), 1)
  const bpc = numOf(parmsMap.get('BitsPerComponent'), 8)
  const columns = numOf(parmsMap.get('Columns'), 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  if (rowLen <= 0 || rowLen > maxStreamBytes) return null
  const out = Buffer.alloc(data.length)
  let inPos = 0
  let outPos = 0
  let prev = Buffer.alloc(rowLen)
  let cur = Buffer.alloc(rowLen)
  while (inPos < data.length) {
    const filter = data[inPos++]
    const avail = Math.min(rowLen, data.length - inPos)
    data.copy(cur, 0, inPos, inPos + avail)
    if (avail < rowLen) cur.fill(0, avail)
    inPos += avail
    if (filter === 0) {
      // none
    } else if (filter === 1) {
      for (let i = bpp; i < avail; i += 1) cur[i] = (cur[i] + cur[i - bpp]) & 0xff
    } else if (filter === 2) {
      for (let i = 0; i < avail; i += 1) cur[i] = (cur[i] + prev[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < avail; i += 1) {
        const left = i >= bpp ? cur[i - bpp] : 0
        cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < avail; i += 1) {
        const a = i >= bpp ? cur[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        cur[i] = (cur[i] + paeth(a, b, c)) & 0xff
      }
    } else {
      return null
    }
    cur.copy(out, outPos, 0, avail)
    outPos += avail
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return out.subarray(0, outPos)
}

function unsupportedFilterName(name) {
  if (name === 'DCTDecode' || name === 'DCT') return 'DCTDecode (JPEG image)'
  if (name === 'JPXDecode') return 'JPXDecode (JPEG 2000 image)'
  if (name === 'LZWDecode' || name === 'LZW') return 'LZWDecode'
  if (name === 'ASCII85Decode' || name === 'A85') return 'ASCII85Decode'
  if (name === 'ASCIIHexDecode' || name === 'AHx') return 'ASCIIHexDecode'
  if (name === 'CCITTFaxDecode' || name === 'CCF') return 'CCITTFaxDecode'
  if (name === 'RunLengthDecode' || name === 'RL') return 'RunLengthDecode'
  return name
}

/**
 * Decode a PDF stream object using its Filter/DecodeParms chain.
 * @param {object} doc
 * @param {object} obj
 * @param {number|string} pageNo
 * @param {string[]|null} warnings
 * @param {number} [maxStreamBytes]
 * @returns {Buffer|null}
 */
export function decodeStream(doc, obj, pageNo, warnings, maxStreamBytes = DEFAULT_MAX_STREAM_BYTES) {
  if (!obj || !obj.stream || !obj.stream.length) return Buffer.alloc(0)
  const cap = Number.isFinite(maxStreamBytes) && maxStreamBytes > 0 ? maxStreamBytes : DEFAULT_MAX_STREAM_BYTES
  const map = dictMap(obj)
  let filters = []
  let parms = []
  if (map) {
    if (map.has('Filter')) filters = nameListOf(doc, map.get('Filter'))
    if (map.has('DecodeParms')) {
      const raw = resolve(doc, map.get('DecodeParms'))
      if (raw && raw.value.t === 'dict') parms = [raw.value.map]
      else if (raw && raw.value.t === 'array') {
        for (const item of raw.value.items) {
          const ir = resolve(doc, item)
          parms.push(ir && ir.value.t === 'dict' ? ir.value.map : null)
        }
      }
    }
  }
  let data = obj.stream
  for (let i = 0; i < filters.length; i += 1) {
    const name = filters[i]
    if (name === 'FlateDecode' || name === 'Fl') {
      try {
        data = inflateSync(data, { maxOutputLength: cap })
      } catch {
        try {
          data = inflateRawSync(data, { maxOutputLength: cap })
        } catch {
          if (warnings) warnings.push(`page ${pageNo}: content stream failed to decode with FlateDecode; page text skipped`)
          return null
        }
      }
      const pm = parms[i] || null
      if (pm && pm.has('Predictor')) {
        const pred = numOf(pm.get('Predictor'), 1)
        if (pred >= 10) {
          const unf = applyPngPredictor(data, pm, cap)
          if (!unf) {
            if (warnings) warnings.push(`page ${pageNo}: unsupported PNG predictor parameters; page text skipped`)
            return null
          }
          data = unf
        } else if (pred === 2) {
          if (warnings) warnings.push(`page ${pageNo}: TIFF predictor 2 is not supported; page text skipped`)
          return null
        }
      }
    } else {
      if (warnings) {
        warnings.push(
          `page ${pageNo}: content stream uses unsupported filter ${unsupportedFilterName(name)}; page text skipped`,
        )
      }
      return null
    }
    if (data.length > cap) {
      if (warnings) warnings.push(`page ${pageNo}: content stream exceeds ${cap}-byte limit after decoding; stream discarded`)
      return null
    }
  }
  return data
}
