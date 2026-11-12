'use strict';

// Minimal, dependency-free PDF text extractor.
// Only node:zlib is used. No network, no child processes, no npm packages.

import { inflateSync, inflateRawSync } from 'node:zlib';

const MAX_STREAM_BYTES = 64 * 1024 * 1024; // 64 MiB decoded-stream cap
const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_TREE_DEPTH = 64;
const MAX_ITER = 50000000;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function isWhite(c) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

function isDelim(c) {
  return (
    c === 0x28 || c === 0x29 || // ( )
    c === 0x3c || c === 0x3e || // < >
    c === 0x5b || c === 0x5d || // [ ]
    c === 0x7b || c === 0x7d || // { }
    c === 0x2f || // /
    c === 0x25 // %
  );
}

function isHexDigit(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

function isDigit(c) {
  return c >= 0x30 && c <= 0x39;
}

function isNumToken(s) {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s);
}

// ---------------------------------------------------------------------------
// Low-level token readers shared by the object parser and the content scanner
// ---------------------------------------------------------------------------

function readLiteralString(buf, pos, end) {
  // pos points at '('
  pos++;
  let depth = 1;
  const out = [];
  let guard = 0;
  while (pos < end) {
    if (++guard > MAX_ITER) break;
    let c = buf[pos++];
    if (c === 0x5c) {
      // backslash escape
      if (pos >= end) break;
      const e = buf[pos++];
      if (e === 0x6e) out.push(0x0a); // n
      else if (e === 0x72) out.push(0x0d); // r
      else if (e === 0x74) out.push(0x09); // t
      else if (e === 0x62) out.push(0x08); // b
      else if (e === 0x66) out.push(0x0c); // f
      else if (e === 0x28) out.push(0x28); // (
      else if (e === 0x29) out.push(0x29); // )
      else if (e === 0x5c) out.push(0x5c); // backslash
      else if (e === 0x0d) {
        // line continuation; swallow a following LF
        if (pos < end && buf[pos] === 0x0a) pos++;
      } else if (e === 0x0a) {
        // line continuation
      } else if (e >= 0x30 && e <= 0x37) {
        // octal, up to 3 digits total
        let v = e - 0x30;
        let n = 1;
        while (n < 3 && pos < end && buf[pos] >= 0x30 && buf[pos] <= 0x37) {
          v = v * 8 + (buf[pos] - 0x30);
          pos++;
          n++;
        }
        out.push(v & 0xff);
      } else {
        out.push(e);
      }
    } else if (c === 0x28) {
      depth++;
      out.push(c);
    } else if (c === 0x29) {
      depth--;
      if (depth === 0) break;
      out.push(c);
    } else {
      out.push(c);
    }
  }
  return { bytes: Buffer.from(out), pos };
}

function readHexString(buf, pos, end) {
  // pos points at '<' that is not '<<'
  pos++;
  const digits = [];
  while (pos < end && buf[pos] !== 0x3e) {
    const c = buf[pos++];
    if (isHexDigit(c)) digits.push(c);
  }
  if (pos < end && buf[pos] === 0x3e) pos++;
  if (digits.length % 2 === 1) digits.push(0x30);
  const out = Buffer.alloc(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (hexVal(digits[i * 2]) << 4) | hexVal(digits[i * 2 + 1]);
  }
  return { bytes: out, pos };
}

function readName(buf, pos, end) {
  // pos points at '/'
  pos++;
  const bytes = [];
  while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) {
    let c = buf[pos++];
    if (c === 0x23 && pos + 1 < end && isHexDigit(buf[pos]) && isHexDigit(buf[pos + 1])) {
      c = (hexVal(buf[pos]) << 4) | hexVal(buf[pos + 1]);
      pos += 2;
    }
    bytes.push(c);
  }
  return { name: Buffer.from(bytes).toString('latin1'), pos };
}

function skipSpace(buf, pos, end) {
  while (pos < end) {
    const c = buf[pos];
    if (isWhite(c)) {
      pos++;
      continue;
    }
    if (c === 0x25) {
      // % comment to end of line
      pos++;
      while (pos < end && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos++;
      continue;
    }
    break;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Object parser: builds tagged values out of a PDF object / dictionary body
// ---------------------------------------------------------------------------

class Parser {
  constructor(buf, pos, end) {
    this.buf = buf;
    this.pos = pos == null ? 0 : pos;
    this.end = end == null ? buf.length : end;
  }

  skipSpace() {
    this.pos = skipSpace(this.buf, this.pos, this.end);
  }

  readInteger() {
    this.skipSpace();
    let sign = 1;
    if (this.pos < this.end && (this.buf[this.pos] === 0x2b || this.buf[this.pos] === 0x2d)) {
      if (this.buf[this.pos] === 0x2d) sign = -1;
      this.pos++;
    }
    const start = this.pos;
    while (this.pos < this.end && isDigit(this.buf[this.pos])) this.pos++;
    if (this.pos === start) return null;
    return sign * parseInt(this.buf.toString('latin1', start, this.pos), 10);
  }

  matchKeyword(kw) {
    this.skipSpace();
    const b = this.buf;
    if (this.pos + kw.length > this.end) return false;
    for (let i = 0; i < kw.length; i++) {
      if (b[this.pos + i] !== kw.charCodeAt(i)) return false;
    }
    const after = this.pos + kw.length;
    if (after < this.end && !isWhite(b[after]) && !isDelim(b[after])) return false;
    this.pos = after;
    return true;
  }

  parseValue() {
    this.skipSpace();
    if (this.pos >= this.end) return { t: 'null' };
    const c = this.buf[this.pos];
    if (c === 0x3c) {
      if (this.pos + 1 < this.end && this.buf[this.pos + 1] === 0x3c) return this.parseDict();
      const r = readHexString(this.buf, this.pos, this.end);
      this.pos = r.pos;
      return { t: 'string', bytes: r.bytes };
    }
    if (c === 0x5b) return this.parseArray();
    if (c === 0x28) {
      const r = readLiteralString(this.buf, this.pos, this.end);
      this.pos = r.pos;
      return { t: 'string', bytes: r.bytes };
    }
    if (c === 0x2f) {
      const r = readName(this.buf, this.pos, this.end);
      this.pos = r.pos;
      return { t: 'name', name: r.name };
    }
    if (c === 0x2b || c === 0x2d || c === 0x2e || isDigit(c)) return this.parseNumberOrRef();
    return this.parseKeywordValue();
  }

  parseKeywordValue() {
    const start = this.pos;
    while (this.pos < this.end && !isWhite(this.buf[this.pos]) && !isDelim(this.buf[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) {
      this.pos++;
      return { t: 'null' };
    }
    const tok = this.buf.toString('latin1', start, this.pos);
    if (tok === 'true') return { t: 'bool', b: true };
    if (tok === 'false') return { t: 'bool', b: false };
    if (tok === 'null') return { t: 'null' };
    return { t: 'name', name: tok };
  }

  parseNumberOrRef() {
    const start = this.pos;
    while (
      this.pos < this.end &&
      (isDigit(this.buf[this.pos]) ||
        this.buf[this.pos] === 0x2b ||
        this.buf[this.pos] === 0x2d ||
        this.buf[this.pos] === 0x2e)
    ) {
      this.pos++;
    }
    const tok = this.buf.toString('latin1', start, this.pos);
    const n = parseFloat(tok);
    if (Number.isNaN(n)) return { t: 'null' };
    if (tok.indexOf('.') === -1) {
      // possible reference: "N G R" (N already consumed, read G then R)
      const save = this.pos;
      let p = skipSpace(this.buf, this.pos, this.end);
      const s1 = p;
      while (p < this.end && isDigit(this.buf[p])) p++;
      if (p > s1) {
        const genStr = this.buf.toString('latin1', s1, p);
        p = skipSpace(this.buf, p, this.end);
        if (p < this.end && this.buf[p] === 0x52 /* R */) {
          this.pos = p + 1;
          return { t: 'ref', num: parseInt(tok, 10), gen: parseInt(genStr, 10) };
        }
      }
      this.pos = save;
    }
    return { t: 'num', n };
  }

  parseDict() {
    this.pos += 2; // <<
    const map = new Map();
    let guard = 0;
    while (this.pos < this.end) {
      if (++guard > MAX_ITER) break;
      this.skipSpace();
      if (this.pos >= this.end) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.buf[this.pos] !== 0x2f) {
        this.pos++;
        continue;
      }
      const key = readName(this.buf, this.pos, this.end);
      this.pos = key.pos;
      const val = this.parseValue();
      map.set(key.name, val);
    }
    return { t: 'dict', map };
  }

  parseArray() {
    this.pos++; // [
    const items = [];
    let guard = 0;
    while (this.pos < this.end) {
      if (++guard > MAX_ITER) break;
      this.skipSpace();
      if (this.pos >= this.end) break;
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      items.push(this.parseValue());
    }
    return { t: 'array', items };
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function nameOf(v) {
  return v && v.t === 'name' ? v.name : null;
}

function numOf(v, def) {
  return v && v.t === 'num' ? v.n : def;
}

function resolve(doc, v) {
  if (!v) return null;
  if (v.t === 'ref') return doc.getObject(v.num);
  return { num: null, value: v, stream: null };
}

function dictMap(obj) {
  return obj && obj.value && obj.value.t === 'dict' ? obj.value.map : null;
}

function nameListOf(doc, v) {
  const r = resolve(doc, v);
  if (!r) return [];
  if (r.value.t === 'name') return [r.value.name];
  if (r.value.t === 'array') {
    const out = [];
    for (const item of r.value.items) {
      const ir = resolve(doc, item);
      if (ir && ir.value.t === 'name') out.push(ir.value.name);
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Classic cross-reference table
// ---------------------------------------------------------------------------

function parseClassicXref(buf) {
  const text = buf.toString('latin1');
  let searchFrom = text.length;
  let startIdx = -1;
  for (let guard = 0; guard < 32; guard++) {
    startIdx = text.lastIndexOf('startxref', searchFrom - 1);
    if (startIdx < 0) return null;
    // require it to be near the end of file (last occurrence wins anyway)
    break;
  }
  if (startIdx < 0) return null;
  const m = /^startxref\s+(\d+)/.exec(text.slice(startIdx, startIdx + 40));
  if (!m) return null;

  let offset = parseInt(m[1], 10);
  const offsets = new Map();
  let trailer = null;
  const visited = new Set();

  while (offset != null && !visited.has(offset)) {
    visited.add(offset);
    let p = skipSpace(buf, offset, buf.length);
    if (text.startsWith('xref', p)) {
      p += 4;
      // subsections
      let ok = true;
      for (;;) {
        p = skipSpace(buf, p, buf.length);
        if (text.startsWith('trailer', p)) {
          p += 7;
          break;
        }
        const sm = /^(\d+)\s+(\d+)/.exec(text.slice(p, p + 40));
        if (!sm) {
          ok = false;
          break;
        }
        const first = parseInt(sm[1], 10);
        const count = parseInt(sm[2], 10);
        p += sm[0].length;
        if (count > 2000000) {
          ok = false;
          break;
        }
        for (let k = 0; k < count; k++) {
          p = skipSpace(buf, p, buf.length);
          const em = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(text.slice(p, p + 30));
          if (!em) {
            ok = false;
            break;
          }
          p += em[0].length;
          if (em[3] === 'n') {
            const num = first + k;
            if (!offsets.has(num)) offsets.set(num, [parseInt(em[1], 10)]);
          }
        }
        if (!ok) break;
      }
      if (!ok) return null;
      const parser = new Parser(buf, p, buf.length);
      const tv = parser.parseValue();
      if (!tv || tv.t !== 'dict') return null;
      if (!trailer) trailer = tv;
      const prev = numOf(tv.map.get('Prev'), null);
      offset = prev != null ? prev : null;
    } else if (text.startsWith('obj', p) || /^\d+\s+\d+\s+obj/.test(text.slice(p, p + 32))) {
      // An xref stream: PDF 1.5+ structure.
      return { xrefStream: true };
    } else {
      return null;
    }
  }
  if (!offsets.size) return null;
  return { offsets, trailer };
}

// ---------------------------------------------------------------------------
// Scan fallback: find every "N G obj" definition
// ---------------------------------------------------------------------------

function scanObjects(buf) {
  const text = buf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const offsets = new Map();
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (++guard > 5000000) break;
    const num = parseInt(m[1], 10);
    const arr = offsets.get(num);
    if (arr) arr.push(m.index);
    else offsets.set(num, [m.index]);
  }
  return offsets;
}

function findTrailerDict(buf) {
  const text = buf.toString('latin1');
  let idx = text.length;
  for (let guard = 0; guard < 100; guard++) {
    if (idx <= 0) break;
    idx = text.lastIndexOf('trailer', idx - 1);
    if (idx < 0) break;
    const parser = new Parser(buf, idx + 7, buf.length);
    const v = parser.parseValue();
    if (v && v.t === 'dict' && v.map.has('Root')) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Document object table
// ---------------------------------------------------------------------------

class PdfDoc {
  constructor(buf, offsets) {
    this.buf = buf;
    this.offsets = offsets; // Map<number, number[]>
    this.cache = new Map();
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const cands = this.offsets.get(num);
    if (!cands || !cands.length) {
      this.cache.set(num, null);
      return null;
    }
    for (let i = cands.length - 1; i >= 0; i--) {
      const obj = this.parseAt(cands[i], num);
      if (obj) {
        this.cache.set(num, obj);
        return obj;
      }
    }
    this.cache.set(num, null);
    return null;
  }

  parseAt(offset, expectedNum) {
    if (offset < 0 || offset >= this.buf.length) return null;
    const p = new Parser(this.buf, offset, this.buf.length);
    const num = p.readInteger();
    const gen = p.readInteger();
    if (num !== expectedNum) return null;
    if (!p.matchKeyword('obj')) return null;
    const value = p.parseValue();
    if (!value) return null;
    let stream = null;
    p.skipSpace();
    if (p.matchKeyword('stream')) {
      let start = p.pos;
      if (start < this.buf.length && this.buf[start] === 0x0d) start++;
      if (start < this.buf.length && this.buf[start] === 0x0a) start++;
      let len = null;
      if (value.t === 'dict') {
        const lv = value.map.get('Length');
        if (lv && lv.t === 'num') len = lv.n;
        else if (lv && lv.t === 'ref') {
          const lo = this.getObject(lv.num);
          if (lo && lo.value && lo.value.t === 'num') len = lo.value.n;
        }
      }
      let endData;
      if (len != null && len >= 0 && start + len <= this.buf.length) {
        endData = start + len;
      } else {
        const idx = this.buf.indexOf('endstream', start);
        if (idx >= 0) {
          endData = idx;
          if (endData > start && this.buf[endData - 1] === 0x0a) endData--;
          if (endData > start && this.buf[endData - 1] === 0x0d) endData--;
        } else {
          endData = this.buf.length;
        }
      }
      if (endData < start) endData = start;
      stream = this.buf.subarray(start, endData);
    }
    return { num, gen, value, stream };
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function applyPngPredictor(data, parmsMap) {
  const colors = numOf(parmsMap.get('Colors'), 1);
  const bpc = numOf(parmsMap.get('BitsPerComponent'), 8);
  const columns = numOf(parmsMap.get('Columns'), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0 || rowLen > MAX_STREAM_BYTES) return null;
  const out = Buffer.alloc(data.length);
  let inPos = 0;
  let outPos = 0;
  let prev = Buffer.alloc(rowLen);
  while (inPos < data.length) {
    const filter = data[inPos++];
    const avail = Math.min(rowLen, data.length - inPos);
    const row = Buffer.from(data.subarray(inPos, inPos + avail));
    inPos += avail;
    if (filter === 0) {
      // none
    } else if (filter === 1) {
      for (let i = bpp; i < row.length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < row.length; i++) row[i] = (row[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + paeth(a, b, c)) & 0xff;
      }
    } else {
      return null;
    }
    row.copy(out, outPos);
    outPos += row.length;
    prev = Buffer.alloc(rowLen);
    row.copy(prev);
  }
  return out.subarray(0, outPos);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unsupportedFilterName(name) {
  if (name === 'DCTDecode' || name === 'DCT') return 'DCTDecode (JPEG image)';
  if (name === 'JPXDecode') return 'JPXDecode (JPEG 2000 image)';
  if (name === 'LZWDecode' || name === 'LZW') return 'LZWDecode';
  if (name === 'ASCII85Decode' || name === 'A85') return 'ASCII85Decode';
  if (name === 'ASCIIHexDecode' || name === 'AHx') return 'ASCIIHexDecode';
  if (name === 'CCITTFaxDecode' || name === 'CCF') return 'CCITTFaxDecode';
  if (name === 'RunLengthDecode' || name === 'RL') return 'RunLengthDecode';
  return name;
}

function decodeStream(doc, obj, pageNo, warnings) {
  if (!obj || !obj.stream || !obj.stream.length) return Buffer.alloc(0);
  const map = dictMap(obj);
  let filters = [];
  let parms = [];
  if (map) {
    if (map.has('Filter')) filters = nameListOf(doc, map.get('Filter'));
    if (map.has('DecodeParms')) {
      const raw = resolve(doc, map.get('DecodeParms'));
      if (raw && raw.value.t === 'dict') parms = [raw.value.map];
      else if (raw && raw.value.t === 'array') {
        for (const item of raw.value.items) {
          const ir = resolve(doc, item);
          parms.push(ir && ir.value.t === 'dict' ? ir.value.map : null);
        }
      }
    }
  }
  let data = obj.stream;
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    if (name === 'FlateDecode' || name === 'Fl') {
      let ok = true;
      try {
        data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
      } catch (e1) {
        try {
          data = inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES });
        } catch (e2) {
          warnings.push('page ' + pageNo + ': content stream failed to decode with FlateDecode; page text skipped');
          return null;
        }
      }
      const pm = parms[i] || null;
      if (pm && pm.has('Predictor')) {
        const pred = numOf(pm.get('Predictor'), 1);
        if (pred >= 10) {
          const unf = applyPngPredictor(data, pm);
          if (!unf) {
            warnings.push('page ' + pageNo + ': unsupported PNG predictor parameters; page text skipped');
            return null;
          }
          data = unf;
        } else if (pred === 2) {
          warnings.push('page ' + pageNo + ': TIFF predictor 2 is not supported; page text skipped');
          return null;
        }
      }
    } else {
      warnings.push(
        'page ' + pageNo + ': content stream uses unsupported filter ' + unsupportedFilterName(name) + '; page text skipped'
      );
      return null;
    }
    if (data.length > MAX_STREAM_BYTES) {
      warnings.push('page ' + pageNo + ': content stream exceeds 64 MiB after decoding; stream discarded');
      return null;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Encoding tables
// ---------------------------------------------------------------------------

const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178
};

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
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7
];

function isControlCode(cp) {
  if (cp === 0x0a || cp === 0x09) return false;
  if (cp < 0x20) return true;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  return false;
}

function decodeBytes(bytes, encoding) {
  const parts = [];
  const mac = encoding === 'MacRomanEncoding';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let cp;
    if (mac) {
      cp = b < 0x80 ? b : MACROMAN[b - 0x80];
    } else {
      cp = CP1252[b] !== undefined ? CP1252[b] : b;
    }
    if (cp == null) continue;
    if (isControlCode(cp)) continue;
    parts.push(String.fromCharCode(cp));
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Font resources
// ---------------------------------------------------------------------------

function getPageFonts(doc, resources) {
  const fonts = new Map();
  if (!resources) return fonts;
  const fontDict = resolve(doc, resources.get('Font'));
  const fm = dictMap(fontDict);
  if (!fm) return fonts;
  for (const [name, ref] of fm) {
    const fd = resolve(doc, ref);
    const m = dictMap(fd);
    if (!m) continue;
    const info = { type0: false, hasToUnicode: false, encoding: null };
    if (nameOf(m.get('Subtype')) === 'Type0') info.type0 = true;
    if (m.has('ToUnicode')) info.hasToUnicode = true;
    const enc = resolve(doc, m.get('Encoding'));
    if (enc && enc.value) {
      if (enc.value.t === 'name') info.encoding = enc.value.name;
      else if (enc.value.t === 'dict') {
        const base = nameOf(enc.value.map.get('BaseEncoding'));
        if (base) info.encoding = base;
      }
    }
    fonts.set(name, info);
  }
  return fonts;
}

// ---------------------------------------------------------------------------
// Content stream text extraction
// ---------------------------------------------------------------------------

function parseContentArray(buf, pos, end) {
  pos++; // [
  const items = [];
  let guard = 0;
  while (pos < end) {
    if (++guard > MAX_ITER) break;
    pos = skipSpace(buf, pos, end);
    if (pos >= end) break;
    const c = buf[pos];
    if (c === 0x5d) return { items, pos: pos + 1 };
    if (c === 0x28) {
      const r = readLiteralString(buf, pos, end);
      items.push({ t: 'string', bytes: r.bytes });
      pos = r.pos;
      continue;
    }
    if (c === 0x3c) {
      if (pos + 1 < end && buf[pos + 1] === 0x3c) {
        pos += 2;
        continue;
      }
      const r = readHexString(buf, pos, end);
      items.push({ t: 'string', bytes: r.bytes });
      pos = r.pos;
      continue;
    }
    if (c === 0x5b) {
      const r = parseContentArray(buf, pos, end);
      items.push({ t: 'array', items: r.items });
      pos = r.pos;
      continue;
    }
    if (c === 0x2f) {
      const r = readName(buf, pos, end);
      items.push({ t: 'name', name: r.name });
      pos = r.pos;
      continue;
    }
    const start = pos;
    while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) pos++;
    if (pos === start) {
      pos++;
      continue;
    }
    const tok = buf.toString('latin1', start, pos);
    if (isNumToken(tok)) items.push({ t: 'num', n: parseFloat(tok) });
    else items.push({ t: 'name', name: tok });
  }
  return { items, pos };
}

function skipInlineImage(buf, pos, end) {
  // Called just after "BI"; skip to the "EI" that follows image data.
  let p = buf.indexOf('ID', pos);
  if (p < 0 || p >= end) return end;
  p += 2;
  // skip the single whitespace character that follows ID
  if (p < end && isWhite(buf[p])) p++;
  let guard = 0;
  while (p + 1 < end) {
    if (++guard > MAX_ITER) return end;
    if ((buf[p] === 0x45 && buf[p + 1] === 0x49) /* EI */) {
      const before = p === 0 ? 0x20 : buf[p - 1];
      const after = p + 2 < end ? buf[p + 2] : 0x20;
      if (isWhite(before) && (isWhite(after) || p + 2 >= end)) return p + 2;
    }
    p++;
  }
  return end;
}

function extractContentText(data, fonts, pageNo, warnings) {
  const state = {
    lines: [],
    cur: [],
    encoding: 'WinAnsiEncoding',
    fontInfo: null,
    usedFonts: new Set(),
    lastX: null,
    lastY: null
  };

  function ensureSpace() {
    if (!state.cur.length) return;
    const last = state.cur[state.cur.length - 1];
    if (last === ' ' || last === '') return;
    state.cur.push(' ');
  }

  function show(bytes) {
    const s = decodeBytes(bytes, state.encoding);
    if (!s) return;
    state.cur.push(s);
  }

  function newline() {
    if (state.cur.length) {
      state.lines.push(state.cur.join(''));
      state.cur = [];
    }
  }

  function warnFont() {
    const info = state.fontInfo;
    if (!info) return;
    if (!(info.type0 || info.hasToUnicode)) return;
    const key = info.encoding + '|' + (info.type0 ? 't0' : '') + (info.hasToUnicode ? 'tu' : '');
    if (state.usedFonts.has(key)) return;
    state.usedFonts.add(key);
    warnings.push(
      'page ' + pageNo + ': uses an embedded/subset font; extracted text may be incomplete'
    );
  }

  const buf = data;
  const end = buf.length;
  let pos = 0;
  const operands = [];
  let guard = 0;

  while (pos < end) {
    if (++guard > MAX_ITER) break;
    pos = skipSpace(buf, pos, end);
    if (pos >= end) break;
    const c = buf[pos];

    if (c === 0x28) {
      const r = readLiteralString(buf, pos, end);
      operands.push({ t: 'string', bytes: r.bytes });
      pos = r.pos;
      continue;
    }
    if (c === 0x3c) {
      if (pos + 1 < end && buf[pos + 1] === 0x3c) {
        pos += 2;
        continue;
      }
      const r = readHexString(buf, pos, end);
      operands.push({ t: 'string', bytes: r.bytes });
      pos = r.pos;
      continue;
    }
    if (c === 0x5b) {
      const r = parseContentArray(buf, pos, end);
      operands.push({ t: 'array', items: r.items });
      pos = r.pos;
      continue;
    }
    if (c === 0x2f) {
      const r = readName(buf, pos, end);
      operands.push({ t: 'name', name: r.name });
      pos = r.pos;
      continue;
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7d) {
      pos++;
      continue;
    }

    const start = pos;
    while (pos < end && !isWhite(buf[pos]) && !isDelim(buf[pos])) pos++;
    if (pos === start) {
      pos++;
      continue;
    }
    const tok = buf.toString('latin1', start, pos);

    if (isNumToken(tok)) {
      operands.push({ t: 'num', n: parseFloat(tok) });
      continue;
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') {
      operands.push({ t: 'bool', b: tok === 'true' });
      continue;
    }

    runOperator(tok, operands, state);
    operands.length = 0;
    if (tok === 'BI') {
      pos = skipInlineImage(buf, pos, end);
    }
  }
  newline();

  function runOperator(op, args, st) {
    if (op === 'Tj') {
      const a = args[args.length - 1];
      if (a && a.t === 'string') {
        warnFont();
        show(a.bytes);
      }
      return;
    }
    if (op === 'TJ') {
      const a = args[args.length - 1];
      if (a && a.t === 'array') {
        warnFont();
        for (const item of a.items) {
          if (item.t === 'string') show(item.bytes);
          else if (item.t === 'num') {
            if (item.n <= -200) ensureSpace();
          }
        }
      }
      return;
    }
    if (op === "'") {
      const a = args[args.length - 1];
      newline();
      if (a && a.t === 'string') {
        warnFont();
        show(a.bytes);
      }
      return;
    }
    if (op === '"') {
      const a = args[args.length - 1];
      newline();
      if (a && a.t === 'string') {
        warnFont();
        show(a.bytes);
      }
      return;
    }
    if (op === 'Td' || op === 'TD') {
      if (args.length >= 2 && args[args.length - 1].t === 'num' && args[args.length - 2].t === 'num') {
        const tx = args[args.length - 2].n;
        const ty = args[args.length - 1].n;
        if (Math.abs(ty) > 0.5) newline();
        else if (Math.abs(tx) > 80) ensureSpace();
      }
      return;
    }
    if (op === 'Tm') {
      if (args.length >= 6 && args[args.length - 1].t === 'num') {
        const e = args[args.length - 2].t === 'num' ? args[args.length - 2].n : null;
        const f = args[args.length - 1].n;
        if (state.lastY != null && Math.abs(f - state.lastY) > 0.5) newline();
        else if (state.lastX != null && e != null && Math.abs(e - state.lastX) > 80) ensureSpace();
        state.lastX = e;
        state.lastY = f;
      }
      return;
    }
    if (op === 'T*') {
      newline();
      return;
    }
    if (op === 'Tf') {
      if (args.length >= 2) {
        const nameArg = args[args.length - 2];
        const fname = nameArg && nameArg.t === 'name' ? nameArg.name : null;
        const info = fname ? fonts.get(fname) : null;
        state.fontInfo = info || null;
        state.encoding = info && info.encoding ? info.encoding : 'WinAnsiEncoding';
      }
      return;
    }
    if (op === 'ET') {
      newline();
      return;
    }
    // BT, q, Q, cm, gs, re, m, l, c, v, y, h, S, s, f, W, n, etc. are ignored.
  }

  const cleaned = state.lines.map((s) => s.replace(/[ \t]+$/, '')).join('\n');
  const text = cleaned.replace(/^\n+/, '').replace(/\n+$/, '');
  return text;
}

// ---------------------------------------------------------------------------
// Page tree
// ---------------------------------------------------------------------------

function findRoot(doc, trailer) {
  if (trailer) {
    const local = resolveExpr(doc, trailer.map.get('Root'));
    if (local && dictMap(local)) return local;
  }
  let last = null;
  const nums = Array.from(doc.offsets.keys()).sort((a, b) => a - b);
  for (const num of nums) {
    const obj = doc.getObject(num);
    const m = dictMap(obj);
    if (m && nameOf(m.get('Type')) === 'Catalog') last = obj;
  }
  return last;
}

function resolveExpr(doc, v) {
  return resolve(doc, v);
}

function collectPages(doc, rootObj) {
  const pages = [];
  const seen = new Set();

  function walk(v, inheritedRes, depth) {
    if (depth > MAX_TREE_DEPTH) return;
    let obj;
    let num = null;
    if (v && v.t === 'ref') {
      num = v.num;
      obj = doc.getObject(num);
    } else if (v && v.value) {
      obj = v;
      num = v.num;
    } else {
      obj = { num: null, value: v, stream: null };
    }
    if (!obj) return;
    const map = dictMap(obj);
    if (!map) return;
    if (num != null) {
      if (seen.has(num)) return;
      seen.add(num);
    }
    let resources = inheritedRes;
    if (map.has('Resources')) {
      const r = resolve(doc, map.get('Resources'));
      if (r && r.value && r.value.t === 'dict') resources = r.value.map;
    }
    const type = nameOf(map.get('Type'));
    const kids = resolve(doc, map.get('Kids'));
    if (type !== 'Page' && kids && kids.value && kids.value.t === 'array') {
      for (const kid of kids.value.items) walk(kid, resources, depth + 1);
      return;
    }
    pages.push({ obj, dict: map, resources });
  }

  if (rootObj) {
    const pagesVal = rootObj.value.map.get('Pages');
    if (pagesVal) walk(pagesVal, null, 0);
  }
  return pages;
}

function fallbackPages(doc) {
  const pages = [];
  const nums = Array.from(doc.offsets.keys()).sort((a, b) => a - b);
  for (const num of nums) {
    const obj = doc.getObject(num);
    const m = dictMap(obj);
    if (!m) continue;
    if (nameOf(m.get('Type')) === 'Page') {
      let resources = null;
      if (m.has('Resources')) {
        const r = resolve(doc, m.get('Resources'));
        if (r && r.value && r.value.t === 'dict') resources = r.value.map;
      }
      pages.push({ obj, dict: m, resources });
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Content stream gathering
// ---------------------------------------------------------------------------

function collectContentObjects(doc, pageDict) {
  const out = [];
  const raw = pageDict.get('Contents');
  if (!raw) return out;
  const r = resolve(doc, raw);
  if (!r) return out;
  if (r.value && r.value.t === 'array') {
    for (const item of r.value.items) {
      const ir = resolve(doc, item);
      if (ir && ir.stream) out.push(ir);
    }
  } else if (r.stream) {
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buffer coercion
// ---------------------------------------------------------------------------

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('buffer must be a Buffer or Uint8Array holding PDF bytes');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractPdfText(buffer, options = {}) {
  const buf = toBuffer(buffer);
  if (buf.length < 5) {
    throw new Error('input is not a PDF file: data is empty or too short');
  }
  const head = buf.toString('latin1', 0, Math.min(buf.length, 1024));
  if (head.indexOf('%PDF-') === -1) {
    throw new Error('input is not a PDF file: missing %PDF- header; pass the raw PDF bytes');
  }

  const warnings = [];
  let offsets = null;
  let trailer = null;
  let usedXrefStream = false;

  try {
    const classic = parseClassicXref(buf);
    if (classic && classic.xrefStream) usedXrefStream = true;
    else if (classic && classic.offsets && classic.offsets.size) {
      offsets = classic.offsets;
      trailer = classic.trailer;
    }
  } catch (e) {
    offsets = null;
    trailer = null;
  }

  if (!offsets) {
    offsets = scanObjects(buf);
    if (offsets.size) {
      trailer = findTrailerDict(buf);
      if (usedXrefStream) {
        warnings.push(
          'this PDF uses cross-reference streams (PDF 1.5+); object offsets were recovered by scanning the file'
        );
      }
    }
  }

  if (!offsets || offsets.size === 0) {
    throw new Error(
      'this PDF uses cross-reference streams (PDF 1.5+) and no classic xref table or readable objects were found; text extraction is not supported for this file'
    );
  }

  const doc = new PdfDoc(buf, offsets);

  if (trailer && trailer.map.has('Encrypt')) {
    warnings.push('detected an encrypted PDF; only unencrypted text is attempted');
  }

  const rootObj = findRoot(doc, trailer);
  let pages = rootObj ? collectPages(doc, rootObj) : [];
  if (!pages.length) pages = fallbackPages(doc);

  if (!pages.length && usedXrefStream) {
    throw new Error(
      'this PDF uses cross-reference streams (PDF 1.5+) with pages stored in object streams; no classic page objects were found, so text extraction is not supported for this file'
    );
  }

  const pageCount = pages.length;

  let offset = Number.isFinite(options.offset) ? Math.floor(options.offset) : 1;
  if (offset < 1) offset = 1;
  let limit;
  if (options.limit === undefined || options.limit === null || !Number.isFinite(options.limit)) {
    limit = DEFAULT_PAGE_LIMIT;
  } else {
    limit = Math.floor(options.limit);
  }
  if (limit < 0) limit = 0;
  if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;

  const startIdx = Math.min(offset - 1, pageCount);
  const endIdx = Math.min(pageCount, startIdx + limit);

  const resultPages = [];
  for (let i = startIdx; i < endIdx; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    let text = '';
    try {
      const fonts = getPageFonts(doc, page.resources);
      const contentObjs = collectContentObjects(doc, page.dict);
      const chunks = [];
      for (const cobj of contentObjs) {
        const decoded = decodeStream(doc, cobj, pageNo, warnings);
        if (decoded && decoded.length) {
          chunks.push(decoded);
          chunks.push(Buffer.from('\n', 'latin1'));
        }
      }
      if (chunks.length) {
        const merged = Buffer.concat(chunks);
        text = extractContentText(merged, fonts, pageNo, warnings);
      }
    } catch (e) {
      warnings.push('page ' + pageNo + ': text extraction failed (' + String(e && e.message ? e.message : e) + ')');
      text = '';
    }
    resultPages.push({ page: pageNo, text });
  }

  // Deduplicate warnings while preserving order.
  const seenWarnings = new Set();
  const finalWarnings = [];
  for (const w of warnings) {
    if (seenWarnings.has(w)) continue;
    seenWarnings.add(w);
    finalWarnings.push(w);
  }

  return { pageCount, pages: resultPages, warnings: finalWarnings };
}
