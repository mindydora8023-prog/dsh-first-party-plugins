/**
 * PDF cross-reference table parser, fallback object scanner, PdfDoc object
 * table (with cycle guard), and page-tree walker.
 *
 * Defers full-file latin1 string conversion so classic-xref PDFs only slice
 * the tail and xref ranges instead of materializing a multi-megabyte string.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import {
  MAX_ITER,
  MAX_TREE_DEPTH,
  Parser,
  dictMap,
  nameOf,
  numOf,
  resolve,
  skipSpace,
} from './lexer.js'

const STARTXREF_TOKEN = Buffer.from('startxref', 'latin1')
const ENDSTREAM_TOKEN = Buffer.from('endstream', 'latin1')

/** Slice a small latin1 window from `buf` without converting the whole file. */
function sliceLatin1(buf, start, length) {
  return buf.toString('latin1', start, Math.min(buf.length, start + length))
}

/**
 * Parse a classic cross-reference table chain (`Prev` links newest -> oldest).
 * Freed (`f`) entries in newer sections block resurrection from older sections.
 */
export function parseClassicXref(buf) {
  const startIdx = buf.lastIndexOf(STARTXREF_TOKEN)
  if (startIdx < 0) return null
  const m = /^startxref\s+(\d+)/.exec(sliceLatin1(buf, startIdx, 48))
  if (!m) return null

  let offset = parseInt(m[1], 10)
  const offsets = new Map()
  const seenObjs = new Set()
  let trailer = null
  const visitedOffsets = new Set()

  while (offset != null && !visitedOffsets.has(offset)) {
    visitedOffsets.add(offset)
    if (offset < 0 || offset >= buf.length) return null
    let p = skipSpace(buf, offset, buf.length)
    const head = sliceLatin1(buf, p, 32)
    if (head.startsWith('xref') && (p + 4 >= buf.length || /^xref[\s\r\n]/.test(head))) {
      p += 4
      let ok = true
      for (;;) {
        p = skipSpace(buf, p, buf.length)
        const peek = sliceLatin1(buf, p, 48)
        if (peek.startsWith('trailer') && (p + 7 >= buf.length || /^trailer[\s\r\n<]/.test(peek))) {
          p += 7
          break
        }
        const sm = /^(\d+)\s+(\d+)/.exec(peek)
        if (!sm) {
          ok = false
          break
        }
        const first = parseInt(sm[1], 10)
        const count = parseInt(sm[2], 10)
        p += sm[0].length
        if (count > MAX_ITER) {
          ok = false
          break
        }
        for (let k = 0; k < count; k += 1) {
          p = skipSpace(buf, p, buf.length)
          const em = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(sliceLatin1(buf, p, 32))
          if (!em) {
            ok = false
            break
          }
          p += em[0].length
          const num = first + k
          if (!seenObjs.has(num)) {
            seenObjs.add(num)
            if (em[3] === 'n') {
              offsets.set(num, [parseInt(em[1], 10)])
            }
          }
        }
        if (!ok) break
      }
      if (!ok) return null
      const parser = new Parser(buf, p, buf.length)
      const tv = parser.parseValue()
      if (!tv || tv.t !== 'dict') return null
      if (!trailer) trailer = tv
      const prev = numOf(tv.map.get('Prev'), null)
      offset = prev != null ? prev : null
    } else if (head.startsWith('obj') || /^\d+\s+\d+\s+obj\b/.test(head)) {
      return { xrefStream: true }
    } else {
      return null
    }
  }
  if (!offsets.size) return null
  return { offsets, trailer }
}

/** Fallback scan: locate every `N G obj` definition when classic xref fails. */
export function scanObjects(buf, text) {
  const view = text ?? buf.toString('latin1')
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  const offsets = new Map()
  let m
  let guard = 0
  while ((m = re.exec(view)) !== null) {
    if (++guard > MAX_ITER) break
    const num = parseInt(m[1], 10)
    const arr = offsets.get(num)
    if (arr) arr.push(m.index)
    else offsets.set(num, [m.index])
  }
  return offsets
}

export function findTrailerDict(buf, text) {
  const view = text ?? buf.toString('latin1')
  let idx = view.length
  for (let guard = 0; guard < 100; guard += 1) {
    if (idx <= 0) break
    idx = view.lastIndexOf('trailer', idx - 1)
    if (idx < 0) break
    const parser = new Parser(buf, idx + 7, buf.length)
    const v = parser.parseValue()
    if (v && v.t === 'dict' && v.map.has('Root')) return v
  }
  return null
}

/**
 * Document object table with caching and a `visiting` cycle guard so cyclic
 * indirect references (such as `/Length` pointing to its own object) never
 * overflow the call stack.
 */
export class PdfDoc {
  constructor(buf, offsets) {
    this.buf = buf
    this.offsets = offsets
    this.cache = new Map()
    this.visiting = new Set()
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num)
    if (this.visiting.has(num)) return null
    const cands = this.offsets.get(num)
    if (!cands || !cands.length) {
      this.cache.set(num, null)
      return null
    }
    this.visiting.add(num)
    try {
      for (let i = cands.length - 1; i >= 0; i -= 1) {
        const obj = this.parseAt(cands[i], num)
        if (obj) {
          this.cache.set(num, obj)
          return obj
        }
      }
    } finally {
      this.visiting.delete(num)
    }
    this.cache.set(num, null)
    return null
  }

  parseAt(offset, expectedNum) {
    if (offset < 0 || offset >= this.buf.length) return null
    const p = new Parser(this.buf, offset, this.buf.length)
    const num = p.readInteger()
    const gen = p.readInteger()
    if (num !== expectedNum) return null
    if (!p.matchKeyword('obj')) return null
    const value = p.parseValue()
    if (!value) return null
    let stream = null
    p.skipSpace()
    if (p.matchKeyword('stream')) {
      let start = p.pos
      if (start < this.buf.length && this.buf[start] === 0x0d) start += 1
      if (start < this.buf.length && this.buf[start] === 0x0a) start += 1
      let len = null
      if (value.t === 'dict') {
        const lv = value.map.get('Length')
        if (lv && lv.t === 'num') len = lv.n
        else if (lv && lv.t === 'ref') {
          const lo = this.getObject(lv.num)
          if (lo && lo.value && lo.value.t === 'num') len = lo.value.n
        }
      }
      let endData
      if (len != null && len >= 0 && start + len <= this.buf.length) {
        endData = start + len
      } else {
        const idx = this.buf.indexOf(ENDSTREAM_TOKEN, start)
        if (idx >= 0) {
          endData = idx
          if (endData > start && this.buf[endData - 1] === 0x0a) endData -= 1
          if (endData > start && this.buf[endData - 1] === 0x0d) endData -= 1
        } else {
          endData = this.buf.length
        }
      }
      if (endData < start) endData = start
      stream = this.buf.subarray(start, endData)
    }
    return { num, gen, value, stream }
  }
}

export function findRoot(doc, trailer) {
  if (trailer) {
    const local = resolve(doc, trailer.map.get('Root'))
    if (local && dictMap(local)) return local
  }
  let last = null
  const nums = Array.from(doc.offsets.keys()).sort((a, b) => a - b)
  for (const num of nums) {
    const obj = doc.getObject(num)
    const m = dictMap(obj)
    if (m && nameOf(m.get('Type')) === 'Catalog') last = obj
  }
  return last
}

export function collectPages(doc, rootObj) {
  const pages = []
  const seen = new Set()

  function walk(v, inheritedRes, depth) {
    if (depth > MAX_TREE_DEPTH) return
    let obj
    let num = null
    if (v && v.t === 'ref') {
      num = v.num
      obj = doc.getObject(num)
    } else if (v && v.value) {
      obj = v
      num = v.num
    } else {
      obj = { num: null, value: v, stream: null }
    }
    if (!obj) return
    const map = dictMap(obj)
    if (!map) return
    if (num != null) {
      if (seen.has(num)) return
      seen.add(num)
    }
    let resources = inheritedRes
    if (map.has('Resources')) {
      const r = resolve(doc, map.get('Resources'))
      if (r && r.value && r.value.t === 'dict') resources = r.value.map
    }
    const type = nameOf(map.get('Type'))
    const kids = resolve(doc, map.get('Kids'))
    if (type !== 'Page' && kids && kids.value && kids.value.t === 'array') {
      for (const kid of kids.value.items) walk(kid, resources, depth + 1)
      return
    }
    pages.push({ obj, dict: map, resources })
  }

  if (rootObj) {
    const pagesVal = rootObj.value.map.get('Pages')
    if (pagesVal) walk(pagesVal, null, 0)
  }
  return pages
}

export function fallbackPages(doc) {
  const pages = []
  const nums = Array.from(doc.offsets.keys()).sort((a, b) => a - b)
  for (const num of nums) {
    const obj = doc.getObject(num)
    const m = dictMap(obj)
    if (!m) continue
    if (nameOf(m.get('Type')) === 'Page') {
      let resources = null
      if (m.has('Resources')) {
        const r = resolve(doc, m.get('Resources'))
        if (r && r.value && r.value.t === 'dict') resources = r.value.map
      }
      pages.push({ obj, dict: m, resources })
    }
  }
  return pages
}

export function collectContentObjects(doc, pageDict) {
  const out = []
  const raw = pageDict.get('Contents')
  if (!raw) return out
  const r = resolve(doc, raw)
  if (!r) return out
  if (r.value && r.value.t === 'array') {
    for (const item of r.value.items) {
      const ir = resolve(doc, item)
      if (ir && ir.stream) out.push(ir)
    }
  } else if (r.stream) {
    out.push(r)
  }
  return out
}
