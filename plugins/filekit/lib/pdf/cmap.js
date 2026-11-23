/**
 * Zero-dependency PDF font decoding: `/ToUnicode` CMap (`beginbfchar`,
 * `beginbfrange` including array form, UTF-16BE + surrogate pairs, 1..4-byte
 * CID code lengths), `/Encoding /Differences`, and CP1252 / MacRoman fallback.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { DEFAULT_MAX_STREAM_BYTES, dictMap, nameOf, resolve } from './lexer.js'
import { decodeStream } from './filters.js'

const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

const MACROMAN = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1,
  0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df,
  0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211,
  0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca,
  0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1,
  0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
]

/** Common Adobe Glyph List names for `/Encoding /Differences`. */
const GLYPH_NAMES = {
  space: ' ', nbspace: ' ', exclam: '!', quotedbl: '"', numbersign: '#',
  dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '\u2019',
  quoteleft: '\u2018', quotedblleft: '\u201c', quotedblright: '\u201d',
  quotedblbase: '\u201e', quotesinglbase: '\u201a', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '\u2212',
  period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3',
  four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
  at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}',
  asciitilde: '~', bullet: '\u2022', endash: '\u2013', emdash: '\u2014',
  ellipsis: '\u2026', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
  Euro: '\u20ac', sterling: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  copyright: '\u00a9', registered: '\u00ae', trademark: '\u2122',
  degree: '\u00b0', plusminus: '\u00b1', multiply: '\u00d7', divide: '\u00f7',
  section: '\u00a7', paragraph: '\u00b6', dagger: '\u2020', daggerdbl: '\u2021',
  perthousand: '\u2030', guilsinglleft: '\u2039', guilsinglright: '\u203a',
  guillemotleft: '\u00ab', guillemotright: '\u00bb',
  Agrave: '\u00c0', Aacute: '\u00c1', Acircumflex: '\u00c2', Atilde: '\u00c3',
  Adieresis: '\u00c4', Aring: '\u00c5', AE: '\u00c6', Ccedilla: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Ecircumflex: '\u00ca', Edieresis: '\u00cb',
  Igrave: '\u00cc', Iacute: '\u00cd', Icircumflex: '\u00ce', Idieresis: '\u00cf',
  Ntilde: '\u00d1', Ograve: '\u00d2', Oacute: '\u00d3', Ocircumflex: '\u00d4',
  Otilde: '\u00d5', Odieresis: '\u00d6', Oslash: '\u00d8', Ugrave: '\u00d9',
  Uacute: '\u00da', Ucircumflex: '\u00db', Udieresis: '\u00dc', Yacute: '\u00dd',
  germandbls: '\u00df', agrave: '\u00e0', aacute: '\u00e1', acircumflex: '\u00e2',
  atilde: '\u00e3', adieresis: '\u00e4', aring: '\u00e5', ae: '\u00e6',
  ccedilla: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecircumflex: '\u00ea',
  edieresis: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icircumflex: '\u00ee',
  idieresis: '\u00ef', ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3',
  ocircumflex: '\u00f4', otilde: '\u00f5', odieresis: '\u00f6', oslash: '\u00f8',
  ugrave: '\u00f9', uacute: '\u00fa', ucircumflex: '\u00fb', udieresis: '\u00fc',
  yacute: '\u00fd', ydieresis: '\u00ff', OE: '\u0152', oe: '\u0153',
  Scaron: '\u0160', scaron: '\u0161', Ydieresis: '\u0178', Zcaron: '\u017d', zcaron: '\u017e',
}

function isControlCode(cp) {
  if (cp === 0x0a || cp === 0x09) return false
  if (cp < 0x20) return true
  if (cp >= 0x7f && cp <= 0x9f) return true
  return false
}

/** Map a PDF glyph name (e.g. `A`, `fi`, `uni4E2D`, `u1F600`) to Unicode text. */
export function glyphNameToUnicode(name) {
  if (typeof name !== 'string' || name.length === 0) return null
  // Strip optional dot suffix (e.g. `A.sc`, `fi.alt`).
  const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name
  if (base.length === 0) return null
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, base)) return GLYPH_NAMES[base]
  if (base.length === 1) return base
  // `uniXXXX` (one or more 4-hex-digit UTF-16BE code units).
  if (/^uni([0-9A-Fa-f]{4})+$/.test(base)) {
    return decodeUtf16BeHex(base.slice(3))
  }
  // `uXXXX`..`uXXXXXX` scalar Unicode value.
  if (/^u[0-9A-Fa-f]{4,6}$/.test(base)) {
    const cp = parseInt(base.slice(1), 16)
    if (cp >= 0 && cp <= 0x10ffff) return String.fromCodePoint(cp)
  }
  return null
}

/**
 * Decode a PDF CMap UTF-16BE hex string (e.g. `4E2D`, `D83DDE00`, `00660069`)
 * into a JS string, preserving surrogate pairs and multi-char ligatures.
 */
export function decodeUtf16BeHex(hex) {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length === 0) return ''
  // Odd-length hex is padded on the right per PDF spec; 2-hex-digit single byte -> 1 code unit.
  if (clean.length <= 2) {
    const v = parseInt(clean, 16)
    return Number.isNaN(v) ? '' : String.fromCharCode(v)
  }
  const padded = clean.length % 4 === 0 ? clean : clean.padStart(Math.ceil(clean.length / 4) * 4, '0')
  let out = ''
  for (let i = 0; i < padded.length; i += 4) {
    const unit = parseInt(padded.slice(i, i + 4), 16)
    if (!Number.isNaN(unit)) out += String.fromCharCode(unit)
  }
  return out
}

/** Decode a hex token as an unsigned integer and its byte length (1..4). */
function parseHexCode(hex) {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length === 0 || clean.length > 8) return null
  const len = Math.max(1, Math.ceil(clean.length / 2))
  const val = parseInt(clean, 16)
  if (!Number.isFinite(val)) return null
  return { len, val }
}

/** Filter out C0/C1 control codes from a decoded Unicode string. */
function stripControls(str) {
  let out = ''
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && !isControlCode(cp)) out += ch
  }
  return out
}

/**
 * Parse a PDF `/ToUnicode` CMap stream into a fast lookup structure.
 * Supports `begincodespacerange`, `beginbfchar`, and `beginbfrange` (both
 * incrementing scalar/surrogate destination and `[ <dst0> <dst1> ... ]` array form).
 *
 * @param {Buffer|string} input decoded ToUnicode stream bytes or text
 * @returns {object|null} CMap object, or null when no mappings were found
 */
export function parseToUnicodeCMap(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input ?? '')
  if (text.length === 0) return null

  const codespace = [] // Array<{ len: number, low: number, high: number }>
  const mapByLen = new Map() // Map<number, Map<number, string>>
  const rangesByLen = new Map() // Map<number, Array<{ start:number, end:number, prefix:string, lastUnit:number }>>
  let totalMappings = 0

  const getMap = (len) => {
    let m = mapByLen.get(len)
    if (m === undefined) { m = new Map(); mapByLen.set(len, m) }
    return m
  }
  const getRanges = (len) => {
    let arr = rangesByLen.get(len)
    if (arr === undefined) { arr = []; rangesByLen.set(len, arr) }
    return arr
  }

  // 1. begincodespacerange ... endcodespacerange
  const csBlockRe = /begincodespacerange\b([\s\S]*?)endcodespacerange/g
  let bm
  while ((bm = csBlockRe.exec(text)) !== null) {
    const pairRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g
    let pm
    while ((pm = pairRe.exec(bm[1])) !== null) {
      const lo = parseHexCode(pm[1])
      const hi = parseHexCode(pm[2])
      if (lo && hi && lo.len === hi.len && lo.val <= hi.val) {
        codespace.push({ len: lo.len, low: lo.val, high: hi.val })
      }
    }
  }

  // 2. beginbfchar ... endbfchar
  const charBlockRe = /beginbfchar\b([\s\S]*?)endbfchar/g
  while ((bm = charBlockRe.exec(text)) !== null) {
    const pairRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g
    let pm
    while ((pm = pairRe.exec(bm[1])) !== null) {
      const src = parseHexCode(pm[1])
      if (!src) continue
      const dst = decodeUtf16BeHex(pm[2])
      getMap(src.len).set(src.val, dst)
      totalMappings += 1
    }
  }

  // 3. beginbfrange ... endbfrange (incrementing and array forms)
  const rangeBlockRe = /beginbfrange\b([\s\S]*?)endbfrange/g
  while ((bm = rangeBlockRe.exec(text)) !== null) {
    const entryRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:<([0-9A-Fa-f\s]+)>|\[([\s\S]*?)\])/g
    let em
    while ((em = entryRe.exec(bm[1])) !== null) {
      const start = parseHexCode(em[1])
      const end = parseHexCode(em[2])
      if (!start || !end || start.len !== end.len || start.val > end.val) continue
      const span = end.val - start.val
      if (span > 65536) continue

      if (em[4] !== undefined) {
        // Array form: <start> <end> [ <dst0> <dst1> ... ]
        const m = getMap(start.len)
        const itemRe = /<([0-9A-Fa-f\s]+)>/g
        let im
        let idx = 0
        while ((im = itemRe.exec(em[4])) !== null && idx <= span) {
          m.set(start.val + idx, decodeUtf16BeHex(im[1]))
          totalMappings += 1
          idx += 1
        }
      } else if (em[3] !== undefined) {
        // Incrementing form: <start> <end> <dstStart>
        const baseStr = decodeUtf16BeHex(em[3])
        if (baseStr.length === 0) continue
        const prefix = baseStr.slice(0, -1)
        const lastUnit = baseStr.charCodeAt(baseStr.length - 1)
        if (span <= 256) {
          const m = getMap(start.len)
          for (let offset = 0; offset <= span; offset += 1) {
            const unit = (lastUnit + offset) & 0xffff
            m.set(start.val + offset, prefix + String.fromCharCode(unit))
          }
        } else {
          getRanges(start.len).push({ start: start.val, end: end.val, prefix, lastUnit })
        }
        totalMappings += span + 1
      }
    }
  }

  if (totalMappings === 0) return null

  const lengthSet = new Set()
  for (const r of codespace) lengthSet.add(r.len)
  for (const len of mapByLen.keys()) lengthSet.add(len)
  for (const len of rangesByLen.keys()) lengthSet.add(len)
  // Ordered candidate byte lengths (prefer longer code lengths first when no codespace disambiguates).
  const lengthsDesc = Array.from(lengthSet).sort((a, b) => b - a)
  const lengthsAsc = Array.from(lengthSet).sort((a, b) => a - b)

  return { codespace, mapByLen, rangesByLen, lengthsDesc, lengthsAsc }
}

function lookupCMap(cmap, len, code) {
  const m = cmap.mapByLen.get(len)
  if (m !== undefined) {
    const hit = m.get(code)
    if (hit !== undefined) return hit
  }
  const ranges = cmap.rangesByLen.get(len)
  if (ranges !== undefined) {
    for (const r of ranges) {
      if (code >= r.start && code <= r.end) {
        const unit = (r.lastUnit + (code - r.start)) & 0xffff
        return r.prefix + String.fromCharCode(unit)
      }
    }
  }
  return undefined
}

function readBigEndian(bytes, pos, len) {
  let val = 0
  for (let i = 0; i < len; i += 1) {
    val = (val << 8) | bytes[pos + i]
  }
  return val >>> 0
}

function matchesCodespace(cmap, len, code) {
  for (const r of cmap.codespace) {
    if (r.len === len && code >= r.low && code <= r.high) return true
  }
  return false
}

/** Decode bytes using a parsed ToUnicode CMap. */
export function decodeWithCMap(bytes, cmap) {
  const parts = []
  let i = 0
  const n = bytes.length
  const hasCodespace = cmap.codespace.length > 0

  while (i < n) {
    let matched = false

    if (hasCodespace) {
      // Per PDF spec, codespace ranges partition code prefixes unambiguously by length.
      for (const len of cmap.lengthsAsc) {
        if (i + len > n) continue
        const code = readBigEndian(bytes, i, len)
        if (!matchesCodespace(cmap, len, code)) continue
        const mapped = lookupCMap(cmap, len, code)
        if (mapped !== undefined) {
          const clean = stripControls(mapped)
          if (clean.length > 0) parts.push(clean)
        }
        i += len
        matched = true
        break
      }
      if (matched) continue
    }

    // No codespace match: probe mapped code lengths (longest first so 2-byte CIDs win).
    for (const len of cmap.lengthsDesc) {
      if (i + len > n) continue
      const code = readBigEndian(bytes, i, len)
      const mapped = lookupCMap(cmap, len, code)
      if (mapped !== undefined) {
        const clean = stripControls(mapped)
        if (clean.length > 0) parts.push(clean)
        i += len
        matched = true
        break
      }
    }
    if (!matched) {
      // Unmapped byte: advance by shortest declared code length (or 1).
      const step = cmap.lengthsAsc.length > 0 && i + cmap.lengthsAsc[0] <= n ? cmap.lengthsAsc[0] : 1
      i += step
    }
  }
  return parts.join('')
}

/** Decode bytes using single-byte encoding + optional `/Encoding /Differences`. */
export function decodeSingleByte(bytes, encoding, differences = null) {
  const parts = []
  const mac = encoding === 'MacRomanEncoding'
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]
    if (differences !== null && differences.has(b)) {
      const mapped = differences.get(b)
      if (mapped !== null && mapped.length > 0) parts.push(mapped)
      continue
    }
    const cp = mac ? (b < 0x80 ? b : MACROMAN[b - 0x80]) : (CP1252[b] !== undefined ? CP1252[b] : b)
    if (cp == null || isControlCode(cp)) continue
    parts.push(String.fromCharCode(cp))
  }
  return parts.join('')
}

/** Decode a PDF text string buffer using the active font's CMap, Differences, or fallback encoding. */
export function decodeFontBytes(bytes, fontInfo, fallbackEncoding) {
  if (fontInfo?.cmap) return decodeWithCMap(bytes, fontInfo.cmap)
  const enc = fontInfo?.encoding ?? fallbackEncoding ?? 'WinAnsiEncoding'
  return decodeSingleByte(bytes, enc, fontInfo?.differences ?? null)
}

/** Parse a `/Differences` array from an `/Encoding` dictionary. */
function parseDifferences(doc, diffVal) {
  const resolved = resolve(doc, diffVal)
  if (!resolved || !resolved.value || resolved.value.t !== 'array') return null
  const map = new Map()
  let code = 0
  for (const item of resolved.value.items) {
    if (item.t === 'num') {
      code = Math.trunc(item.n)
    } else if (item.t === 'name') {
      const unicode = glyphNameToUnicode(item.name)
      if (unicode !== null) map.set(code, unicode)
      code += 1
    }
  }
  return map.size > 0 ? map : null
}

/**
 * Inspect `/Resources /Font` for one page, decoding any `/ToUnicode` CMaps
 * and `/Encoding /Differences` maps.
 */
export function getPageFonts(doc, resources, pageNo, warnings, maxStreamBytes = DEFAULT_MAX_STREAM_BYTES) {
  const fonts = new Map()
  if (!resources) return fonts
  const fontDict = resolve(doc, resources.get('Font'))
  const fm = dictMap(fontDict)
  if (!fm) return fonts
  for (const [name, ref] of fm) {
    const fd = resolve(doc, ref)
    const m = dictMap(fd)
    if (!m) continue
    const info = {
      type0: nameOf(m.get('Subtype')) === 'Type0',
      hasToUnicode: m.has('ToUnicode'),
      cmap: null,
      encoding: null,
      differences: null,
    }
    if (info.hasToUnicode) {
      const tuObj = resolve(doc, m.get('ToUnicode'))
      if (tuObj && tuObj.stream) {
        const decoded = decodeStream(doc, tuObj, pageNo, null, maxStreamBytes)
        if (decoded && decoded.length > 0) {
          info.cmap = parseToUnicodeCMap(decoded)
        }
      }
    }
    const enc = resolve(doc, m.get('Encoding'))
    if (enc && enc.value) {
      if (enc.value.t === 'name') {
        info.encoding = enc.value.name
      } else if (enc.value.t === 'dict') {
        const base = nameOf(enc.value.map.get('BaseEncoding'))
        if (base) info.encoding = base
        if (enc.value.map.has('Differences')) {
          info.differences = parseDifferences(doc, enc.value.map.get('Differences'))
        }
      }
    }
    fonts.set(name, info)
  }
  return fonts
}
