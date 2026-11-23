/**
 * PDF content stream text extractor.
 *
 * Enforces bounded recursion in `parseContentArray`, resets text position on
 * `BT` and `ET`, and decodes strings through the active font's `/ToUnicode`
 * CMap or `/Encoding /Differences` before falling back to CP1252/MacRoman.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import {
  MAX_ITER,
  MAX_PARSE_DEPTH,
  isDelim,
  isNumToken,
  isWhite,
  readHexString,
  readLiteralString,
  readName,
  skipSpace,
} from './lexer.js'
import { decodeFontBytes } from './cmap.js'

export function parseContentArray(buf, pos, end, depth = 0) {
  pos += 1 // [
  const items = []
  if (depth >= MAX_PARSE_DEPTH) {
    // Iteratively skip balanced '[' ... ']' without recursing further.
    let level = 1
    let guard = 0
    while (pos < end && level > 0) {
      if (++guard > MAX_ITER) return { items, pos: end }
      const c = buf[pos]
      if (c === 0x28) { pos = readLiteralString(buf, pos, end).pos; continue }
      if (c === 0x5b) { level += 1; pos += 1; continue }
      if (c === 0x5d) { level -= 1; pos += 1; continue }
      pos += 1
    }
    return { items, pos }
  }
  let guard = 0
  while (pos < end) {
    if (++guard > MAX_ITER) break
    pos = skipSpace(buf, pos, end)
    if (pos >= end) break
    const c = buf[pos]
    if (c === 0x5d) return { items, pos: pos + 1 }
    if (c === 0x28) {
      const r = readLiteralString(buf, pos, end)
      items.push({ t: 'string', bytes: r.bytes })
      pos = r.pos
      continue
    }
    if (c === 0x3c) {
      if (pos + 1 < end && buf[pos + 1] === 0x3c) {
        pos += 2
        continue
      }
      const r = readHexString(buf, pos, end)
      items.push({ t: 'string', bytes: r.bytes })
      pos = r.pos
      continue
    }
    if (c === 0x5b) {
      const r = parseContentArray(buf, pos, end, depth + 1)
      items.push({ t: 'array', items: r.items })
      pos = r.pos
      continue
    }
    if (c === 0x2f) {
      const r = readName(buf, pos, end)
      items.push({ t: 'name', name: r.name })
      pos = r.pos
      continue
    }
    const start = pos
    while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) pos += 1
    if (pos === start) {
      pos += 1
      continue
    }
    const tok = buf.toString('latin1', start, pos)
    if (isNumToken(tok)) items.push({ t: 'num', n: parseFloat(tok) })
    else items.push({ t: 'name', name: tok })
  }
  return { items, pos }
}

function skipInlineImage(buf, pos, end) {
  let p = buf.indexOf('ID', pos)
  if (p < 0 || p >= end) return end
  p += 2
  if (p < end && isWhite(buf[p])) p += 1
  let guard = 0
  while (p + 1 < end) {
    if (++guard > MAX_ITER) return end
    if (buf[p] === 0x45 && buf[p + 1] === 0x49) {
      const before = p === 0 ? 0x20 : buf[p - 1]
      const after = p + 2 < end ? buf[p + 2] : 0x20
      if (isWhite(before) && (isWhite(after) || p + 2 >= end)) return p + 2
    }
    p += 1
  }
  return end
}

export function extractContentText(data, fonts, pageNo, warnings) {
  const state = {
    lines: [],
    cur: [],
    encoding: 'WinAnsiEncoding',
    fontInfo: null,
    usedFonts: new Set(),
    lastX: null,
    lastY: null,
  }

  function ensureSpace() {
    if (!state.cur.length) return
    const last = state.cur[state.cur.length - 1]
    if (last === ' ' || last === '') return
    state.cur.push(' ')
  }

  function show(bytes) {
    const s = decodeFontBytes(bytes, state.fontInfo, state.encoding)
    if (!s) return
    state.cur.push(s)
  }

  function newline() {
    if (state.cur.length) {
      state.lines.push(state.cur.join(''))
      state.cur = []
    }
  }

  function warnFont() {
    const info = state.fontInfo
    if (!info) return
    // A parsed ToUnicode CMap handles CID/subset decoding cleanly; only warn when missing.
    if (info.cmap) return
    if (!(info.type0 || info.hasToUnicode)) return
    const key = `${info.encoding}|${info.type0 ? 't0' : ''}${info.hasToUnicode ? 'tu' : ''}`
    if (state.usedFonts.has(key)) return
    state.usedFonts.add(key)
    warnings.push(
      `page ${pageNo}: uses an embedded/subset font without a readable ToUnicode map; extracted text may be incomplete`,
    )
  }

  function runOperator(op, args) {
    if (op === 'Tj') {
      const a = args[args.length - 1]
      if (a && a.t === 'string') {
        warnFont()
        show(a.bytes)
      }
      return
    }
    if (op === 'TJ') {
      const a = args[args.length - 1]
      if (a && a.t === 'array') {
        warnFont()
        for (const item of a.items) {
          if (item.t === 'string') show(item.bytes)
          else if (item.t === 'num' && item.n <= -200) ensureSpace()
        }
      }
      return
    }
    if (op === "'" || op === '"') {
      const a = args[args.length - 1]
      newline()
      if (a && a.t === 'string') {
        warnFont()
        show(a.bytes)
      }
      return
    }
    if (op === 'Td' || op === 'TD') {
      if (args.length >= 2 && args[args.length - 1].t === 'num' && args[args.length - 2].t === 'num') {
        const tx = args[args.length - 2].n
        const ty = args[args.length - 1].n
        if (Math.abs(ty) > 0.5) newline()
        else if (Math.abs(tx) > 80) ensureSpace()
      }
      return
    }
    if (op === 'Tm') {
      if (args.length >= 6 && args[args.length - 1].t === 'num') {
        const e = args[args.length - 2].t === 'num' ? args[args.length - 2].n : null
        const f = args[args.length - 1].n
        if (state.lastY != null && Math.abs(f - state.lastY) > 0.5) newline()
        else if (state.lastX != null && e != null && Math.abs(e - state.lastX) > 80) ensureSpace()
        state.lastX = e
        state.lastY = f
      }
      return
    }
    if (op === 'T*') {
      newline()
      return
    }
    if (op === 'Tf') {
      if (args.length >= 2) {
        const nameArg = args[args.length - 2]
        const fname = nameArg && nameArg.t === 'name' ? nameArg.name : null
        const info = fname ? fonts.get(fname) : null
        state.fontInfo = info || null
        state.encoding = info && info.encoding ? info.encoding : 'WinAnsiEncoding'
      }
      return
    }
    if (op === 'BT') {
      state.lastX = null
      state.lastY = null
      return
    }
    if (op === 'ET') {
      newline()
      state.lastX = null
      state.lastY = null
    }
  }

  const buf = data
  const end = buf.length
  let pos = 0
  const operands = []
  let guard = 0

  while (pos < end) {
    if (++guard > MAX_ITER) break
    pos = skipSpace(buf, pos, end)
    if (pos >= end) break
    const c = buf[pos]

    if (c === 0x28) {
      const r = readLiteralString(buf, pos, end)
      operands.push({ t: 'string', bytes: r.bytes })
      pos = r.pos
      continue
    }
    if (c === 0x3c) {
      if (pos + 1 < end && buf[pos + 1] === 0x3c) {
        pos += 2
        continue
      }
      const r = readHexString(buf, pos, end)
      operands.push({ t: 'string', bytes: r.bytes })
      pos = r.pos
      continue
    }
    if (c === 0x5b) {
      const r = parseContentArray(buf, pos, end, 0)
      operands.push({ t: 'array', items: r.items })
      pos = r.pos
      continue
    }
    if (c === 0x2f) {
      const r = readName(buf, pos, end)
      operands.push({ t: 'name', name: r.name })
      pos = r.pos
      continue
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7d) {
      pos += 1
      continue
    }

    const start = pos
    while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) pos += 1
    if (pos === start) {
      pos += 1
      continue
    }
    const tok = buf.toString('latin1', start, pos)

    if (isNumToken(tok)) {
      operands.push({ t: 'num', n: parseFloat(tok) })
      continue
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') {
      operands.push({ t: 'bool', b: tok === 'true' })
      continue
    }

    runOperator(tok, operands)
    operands.length = 0
    if (tok === 'BI') {
      pos = skipInlineImage(buf, pos, end)
    }
  }
  newline()

  const cleaned = state.lines.map((s) => s.replace(/[ \t]+$/, '')).join('\n')
  return cleaned.replace(/^\n+/, '').replace(/\n+$/, '')
}
