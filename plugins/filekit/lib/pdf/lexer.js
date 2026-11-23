/**
 * PDF lexer, token readers, bounded recursive object parser, and value helpers.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'

export const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024
export const MAX_PAGE_LIMIT = 100
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_TREE_DEPTH = 64
export const MAX_PARSE_DEPTH = 64
export const MAX_ITER = 2_000_000

export function isWhite(c) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
}

export function isDelim(c) {
  return (
    c === 0x28 || c === 0x29 || // ( )
    c === 0x3c || c === 0x3e || // < >
    c === 0x5b || c === 0x5d || // [ ]
    c === 0x7b || c === 0x7d || // { }
    c === 0x2f || // /
    c === 0x25 // %
  )
}

export function isHexDigit(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
}

export function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  return -1
}

export function isDigit(c) {
  return c >= 0x30 && c <= 0x39
}

export function isNumToken(s) {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)
}

export function readLiteralString(buf, pos, end) {
  // pos points at '('
  pos += 1
  let depth = 1
  const out = []
  let guard = 0
  while (pos < end) {
    if (++guard > MAX_ITER) break
    const c = buf[pos++]
    if (c === 0x5c) {
      if (pos >= end) break
      const e = buf[pos++]
      if (e === 0x6e) out.push(0x0a)
      else if (e === 0x72) out.push(0x0d)
      else if (e === 0x74) out.push(0x09)
      else if (e === 0x62) out.push(0x08)
      else if (e === 0x66) out.push(0x0c)
      else if (e === 0x28) out.push(0x28)
      else if (e === 0x29) out.push(0x29)
      else if (e === 0x5c) out.push(0x5c)
      else if (e === 0x0d) {
        if (pos < end && buf[pos] === 0x0a) pos += 1
      } else if (e === 0x0a) {
        // line continuation
      } else if (e >= 0x30 && e <= 0x37) {
        let v = e - 0x30
        let n = 1
        while (n < 3 && pos < end && buf[pos] >= 0x30 && buf[pos] <= 0x37) {
          v = v * 8 + (buf[pos] - 0x30)
          pos += 1
          n += 1
        }
        out.push(v & 0xff)
      } else {
        out.push(e)
      }
    } else if (c === 0x28) {
      depth += 1
      out.push(c)
    } else if (c === 0x29) {
      depth -= 1
      if (depth === 0) break
      out.push(c)
    } else {
      out.push(c)
    }
  }
  return { bytes: Buffer.from(out), pos }
}

export function readHexString(buf, pos, end) {
  // pos points at '<' that is not '<<'
  pos += 1
  const digits = []
  let guard = 0
  while (pos < end && buf[pos] !== 0x3e) {
    if (++guard > MAX_ITER) break
    const c = buf[pos++]
    if (isHexDigit(c)) digits.push(c)
  }
  if (pos < end && buf[pos] === 0x3e) pos += 1
  if (digits.length % 2 === 1) digits.push(0x30)
  const out = Buffer.alloc(digits.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (hexVal(digits[i * 2]) << 4) | hexVal(digits[i * 2 + 1])
  }
  return { bytes: out, pos }
}

export function readName(buf, pos, end) {
  // pos points at '/'
  pos += 1
  const bytes = []
  while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) {
    let c = buf[pos++]
    if (c === 0x23 && pos + 1 < end && isHexDigit(buf[pos]) && isHexDigit(buf[pos + 1])) {
      c = (hexVal(buf[pos]) << 4) | hexVal(buf[pos + 1])
      pos += 2
    }
    bytes.push(c)
  }
  return { name: Buffer.from(bytes).toString('latin1'), pos }
}

export function skipSpace(buf, pos, end) {
  while (pos < end) {
    const c = buf[pos]
    if (isWhite(c)) {
      pos += 1
      continue
    }
    if (c === 0x25) {
      pos += 1
      while (pos < end && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos += 1
      continue
    }
    break
  }
  return pos
}

/**
 * Recursive PDF object parser with explicit nesting depth guard (`<= MAX_PARSE_DEPTH`).
 */
export class Parser {
  constructor(buf, pos, end) {
    this.buf = buf
    this.pos = pos == null ? 0 : pos
    this.end = end == null ? buf.length : end
  }

  skipSpace() {
    this.pos = skipSpace(this.buf, this.pos, this.end)
  }

  readInteger() {
    this.skipSpace()
    let sign = 1
    if (this.pos < this.end && (this.buf[this.pos] === 0x2b || this.buf[this.pos] === 0x2d)) {
      if (this.buf[this.pos] === 0x2d) sign = -1
      this.pos += 1
    }
    const start = this.pos
    while (this.pos < this.end && isDigit(this.buf[this.pos])) this.pos += 1
    if (this.pos === start) return null
    return sign * parseInt(this.buf.toString('latin1', start, this.pos), 10)
  }

  matchKeyword(kw) {
    this.skipSpace()
    const b = this.buf
    if (this.pos + kw.length > this.end) return false
    for (let i = 0; i < kw.length; i += 1) {
      if (b[this.pos + i] !== kw.charCodeAt(i)) return false
    }
    const after = this.pos + kw.length
    if (after < this.end && !isWhite(b[after]) && !isDelim(b[after])) return false
    this.pos = after
    return true
  }

  parseValue(depth = 0) {
    this.skipSpace()
    if (this.pos >= this.end) return { t: 'null' }
    const c = this.buf[this.pos]
    if (c === 0x3c) {
      if (this.pos + 1 < this.end && this.buf[this.pos + 1] === 0x3c) {
        return this.parseDict(depth + 1)
      }
      const r = readHexString(this.buf, this.pos, this.end)
      this.pos = r.pos
      return { t: 'string', bytes: r.bytes }
    }
    if (c === 0x5b) return this.parseArray(depth + 1)
    if (c === 0x28) {
      const r = readLiteralString(this.buf, this.pos, this.end)
      this.pos = r.pos
      return { t: 'string', bytes: r.bytes }
    }
    if (c === 0x2f) {
      const r = readName(this.buf, this.pos, this.end)
      this.pos = r.pos
      return { t: 'name', name: r.name }
    }
    if (c === 0x2b || c === 0x2d || c === 0x2e || isDigit(c)) return this.parseNumberOrRef()
    return this.parseKeywordValue()
  }

  parseKeywordValue() {
    const start = this.pos
    while (this.pos < this.end && !isWhite(this.buf[this.pos]) && !isDelim(this.buf[this.pos])) {
      this.pos += 1
    }
    if (this.pos === start) {
      this.pos += 1
      return { t: 'null' }
    }
    const tok = this.buf.toString('latin1', start, this.pos)
    if (tok === 'true') return { t: 'bool', b: true }
    if (tok === 'false') return { t: 'bool', b: false }
    if (tok === 'null') return { t: 'null' }
    return { t: 'name', name: tok }
  }

  parseNumberOrRef() {
    const start = this.pos
    while (
      this.pos < this.end &&
      (isDigit(this.buf[this.pos]) ||
        this.buf[this.pos] === 0x2b ||
        this.buf[this.pos] === 0x2d ||
        this.buf[this.pos] === 0x2e)
    ) {
      this.pos += 1
    }
    const tok = this.buf.toString('latin1', start, this.pos)
    const n = parseFloat(tok)
    if (Number.isNaN(n)) return { t: 'null' }
    if (tok.indexOf('.') === -1) {
      const save = this.pos
      let p = skipSpace(this.buf, this.pos, this.end)
      const s1 = p
      while (p < this.end && isDigit(this.buf[p])) p += 1
      if (p > s1) {
        const genStr = this.buf.toString('latin1', s1, p)
        p = skipSpace(this.buf, p, this.end)
        if (p < this.end && this.buf[p] === 0x52 /* R */) {
          this.pos = p + 1
          return { t: 'ref', num: parseInt(tok, 10), gen: parseInt(genStr, 10) }
        }
      }
      this.pos = save
    }
    return { t: 'num', n }
  }

  parseDict(depth = 1) {
    this.pos += 2 // <<
    const map = new Map()
    if (depth > MAX_PARSE_DEPTH) {
      this.skipNested(0x3c, 0x3e, true)
      return { t: 'dict', map }
    }
    let guard = 0
    while (this.pos < this.end) {
      if (++guard > MAX_ITER) break
      this.skipSpace()
      if (this.pos >= this.end) break
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      if (this.buf[this.pos] !== 0x2f) {
        this.pos += 1
        continue
      }
      const key = readName(this.buf, this.pos, this.end)
      this.pos = key.pos
      const val = this.parseValue(depth)
      map.set(key.name, val)
    }
    return { t: 'dict', map }
  }

  parseArray(depth = 1) {
    this.pos += 1 // [
    const items = []
    if (depth > MAX_PARSE_DEPTH) {
      this.skipNested(0x5b, 0x5d, false)
      return { t: 'array', items }
    }
    let guard = 0
    while (this.pos < this.end) {
      if (++guard > MAX_ITER) break
      this.skipSpace()
      if (this.pos >= this.end) break
      if (this.buf[this.pos] === 0x5d) {
        this.pos += 1
        break
      }
      items.push(this.parseValue(depth))
    }
    return { t: 'array', items }
  }

  /** Iteratively skip past an over-nested dict or array without recursing. */
  skipNested(openByte, closeByte, isDouble) {
    let level = 1
    let guard = 0
    while (this.pos < this.end && level > 0) {
      if (++guard > MAX_ITER) {
        this.pos = this.end
        return
      }
      const c = this.buf[this.pos]
      if (c === 0x28) {
        this.pos = readLiteralString(this.buf, this.pos, this.end).pos
        continue
      }
      if (isDouble) {
        if (c === openByte && this.pos + 1 < this.end && this.buf[this.pos + 1] === openByte) {
          level += 1
          this.pos += 2
          continue
        }
        if (c === closeByte && this.pos + 1 < this.end && this.buf[this.pos + 1] === closeByte) {
          level -= 1
          this.pos += 2
          continue
        }
      } else {
        if (c === openByte) { level += 1; this.pos += 1; continue }
        if (c === closeByte) { level -= 1; this.pos += 1; continue }
      }
      this.pos += 1
    }
  }
}

export function nameOf(v) {
  return v && v.t === 'name' ? v.name : null
}

export function numOf(v, def) {
  return v && v.t === 'num' ? v.n : def
}

export function resolve(doc, v) {
  if (!v) return null
  if (v.t === 'ref') return doc.getObject(v.num)
  return { num: null, value: v, stream: null }
}

export function dictMap(obj) {
  return obj && obj.value && obj.value.t === 'dict' ? obj.value.map : null
}

export function nameListOf(doc, v) {
  const r = resolve(doc, v)
  if (!r) return []
  if (r.value.t === 'name') return [r.value.name]
  if (r.value.t === 'array') {
    const out = []
    for (const item of r.value.items) {
      const ir = resolve(doc, item)
      if (ir && ir.value.t === 'name') out.push(ir.value.name)
    }
    return out
  }
  return []
}
