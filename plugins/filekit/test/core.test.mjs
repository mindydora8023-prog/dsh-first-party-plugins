import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

import { buildWindow, formatWindow, decodeUtf8 } from '../lib/text.js'
import { detectDelimiter, parseDelimited, formatTable, decodeTable } from '../lib/csv.js'
import { listZipEntries, readZipEntry, looksLikeZip } from '../lib/zip.js'
import { parseDocumentXml, readDocx, unescapeXml } from '../lib/docx.js'
import { isCredentialPath, credentialDenied } from '../lib/guard.js'

// ---------------------------------------------------------------- text window

test('buildWindow numbers lines 1-based and stops at offset+limit', () => {
  const body = 'a\nb\nc\nd\ne\n'
  const w = buildWindow(body, { offset: 2, limit: 2, maxLineLength: 100, maxBytes: 10000 }, 'f.txt')
  assert.deepEqual(w.lines, [{ number: 2, text: 'b' }, { number: 3, text: 'c' }])
  assert.equal(w.totalLines, 5)
  assert.equal(w.truncatedByBytes, false)
})

test('a final LF adds no empty line and an empty file has zero lines', () => {
  assert.equal(buildWindow('x\n', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, 'f').totalLines, 1)
  assert.equal(buildWindow('', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, 'f').totalLines, 0)
})

test('CRLF counts once and trailing CR is stripped', () => {
  const w = buildWindow('a\r\nb\r\n', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, 'f')
  assert.deepEqual(w.lines.map((l) => l.text), ['a', 'b'])
})

test('long single line is truncated, not fatal', () => {
  const w = buildWindow('y'.repeat(500), { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 100000 }, 'f')
  assert.match(w.lines[0].text, /truncated to 100 chars/)
})

test('byte cap sets truncatedByBytes and reports how to resume', () => {
  const body = Array.from({ length: 50 }, (_, i) => `line-${i}-${'z'.repeat(20)}`).join('\n')
  const w = buildWindow(body, { offset: 1, limit: 50, maxLineLength: 200, maxBytes: 120 }, 'f')
  assert.equal(w.truncatedByBytes, true)
  assert.ok(w.lines.length < 50)
  const text = formatWindow('f', { offset: 1, ...w })
  assert.match(text, /Output capped/)
})

test('offset past EOF throws with the line count', () => {
  assert.throws(
    () => buildWindow('a\nb\n', { offset: 9, limit: 1, maxLineLength: 100, maxBytes: 1000 }, 'f.txt'),
    /offset 9 is out of range/,
  )
})

test('offset 1 on an empty file is allowed', () => {
  const w = buildWindow('', { offset: 1, limit: 5, maxLineLength: 100, maxBytes: 1000 }, 'f')
  assert.deepEqual(w.lines, [])
})

test('formatWindow footer marks end of file', () => {
  const w = buildWindow('one\ntwo', { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, 'p')
  const text = formatWindow('p', { offset: 1, ...w })
  assert.match(text, /End of file - total 2 lines/)
  assert.match(text, /1: one/)
})

test('decodeUtf8 rejects binary and invalid UTF-8 with readable errors', () => {
  assert.throws(() => decodeUtf8(Buffer.from([0x61, 0x00, 0x62]), 'b.bin'), /binary content/)
  assert.throws(() => decodeUtf8(Buffer.from([0xff, 0xfe, 0xfb]), 'x.txt'), /not valid UTF-8/)
  assert.equal(decodeUtf8(Buffer.from('hello', 'utf8'), 'x.txt'), 'hello')
})

// ---------------------------------------------------------------- CSV / TSV

test('detectDelimiter picks comma vs tab', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3', ''), ',')
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3', ''), '\t')
  assert.equal(detectDelimiter('a;b;c', ''), ';')
})

test('quoted fields keep delimiters, doubled quotes, and embedded newlines', () => {
  const text = 'name,note\n"Smith, J","say ""hi""\nsecond line"\n'
  const { rows } = parseDelimited(text, ',')
  assert.deepEqual(rows[0], ['name', 'note'])
  assert.deepEqual(rows[1], ['Smith, J', 'say "hi"\nsecond line'])
})

test('formatTable shows header once, numbers data rows, and pages', () => {
  const rows = [['id', 'val'], ['1', 'a'], ['2', 'b'], ['3', 'c']]
  const out = formatTable(rows, { offset: 2, limit: 1, hasHeader: true, maxCellLength: 50, maxBytes: 10000 })
  assert.match(out.text, /# id \| val/)
  assert.match(out.text, /2: 2 \| b/)
  assert.equal(out.returned, 1)
  assert.equal(out.totalDataRows, 3)
  assert.match(out.text, /Use offset=3 to continue/)
})

test('a cell containing a newline stays on ONE numbered line', () => {
  // Regression: emitting the raw newline split one data row across two output
  // lines, so the row numbers the model pages with no longer lined up.
  const rows = [['id', 'note'], ['1', 'multi\nline'], ['2', 'ok']]
  const out = formatTable(rows, { offset: 1, limit: 10, hasHeader: true, maxCellLength: 50, maxBytes: 10000 })
  const numbered = out.text.split('\n').filter((line) => /^\d+:/.test(line))
  assert.deepEqual(numbered.map((line) => line.split(':')[0]), ['1', '2'])
  assert.match(out.text, /multi\\nline/)
  assert.equal(out.text.includes('multi\nline'), false, 'the raw newline must not survive')
})

test('a cell containing a tab or backslash is escaped, not lost', () => {
  const rows = [['a', 'b'], ['x\ty', 'c\\d']]
  const out = formatTable(rows, { offset: 1, limit: 5, hasHeader: true, maxCellLength: 50, maxBytes: 10000 })
  assert.match(out.text, /x\\ty/)
  assert.match(out.text, /c\\\\d/)
})

test('decodeTable auto-detects a UTF-16LE BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,2', 'utf16le')])
  const { text, encoding } = decodeTable(buf, 'auto')
  assert.equal(encoding, 'utf-16le')
  assert.match(text, /a,b/)
})

// ---------------------------------------------------------------- ZIP + DOCX

/** Build a minimal single-entry ZIP with one deflated file. */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8')
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localRec = Buffer.concat([local, nameBuf, comp])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    locals.push(localRec)
    offset += localRec.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const DOC_XML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Title &amp; intro</w:t></w:r></w:p>
<w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>paragraph</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>After table</w:t></w:r></w:p>
</w:body></w:document>`

test('zip reader lists and extracts an entry', () => {
  const zip = makeZip([['word/document.xml', DOC_XML]])
  assert.equal(looksLikeZip(zip), true)
  const names = listZipEntries(zip).map((e) => e.name)
  assert.deepEqual(names, ['word/document.xml'])
  assert.equal(readZipEntry(zip, 'word/document.xml').toString('utf8'), DOC_XML)
  assert.throws(() => readZipEntry(zip, 'missing.xml'), /not found/)
})

test('docx: unescapeXml handles named and numeric entities', () => {
  assert.equal(unescapeXml('a &amp; b &#65; &#x42;'), 'a & b A B')
})

test('docx: unescapeXml replaces an out-of-range numeric reference instead of throwing', () => {
  assert.equal(unescapeXml('&#x110000;'), '\uFFFD')
  assert.equal(unescapeXml('&#999999999;'), '\uFFFD')
})

test('docx: parseDocumentXml orders paragraphs and tables in the body', () => {
  const blocks = parseDocumentXml(DOC_XML)
  assert.equal(blocks.length, 4)
  assert.deepEqual(blocks[0], { kind: 'para', text: 'Title & intro' })
  assert.deepEqual(blocks[1], { kind: 'para', text: 'Second\tparagraph' })
  assert.equal(blocks[2].kind, 'table')
  assert.deepEqual(blocks[2].rows, [['A1', 'B1'], ['A2', 'B2']])
  assert.deepEqual(blocks[3], { kind: 'para', text: 'After table' })
})

test('docx: readDocx pages blocks and reports totals', () => {
  const zip = makeZip([['word/document.xml', DOC_XML]])
  const one = readDocx(zip, { offset: 1, limit: 2, maxCellLength: 50, maxBytes: 100000 })
  assert.equal(one.totalBlocks, 4)
  assert.equal(one.returned, 2)
  assert.match(one.text, /Title & intro/)
  assert.match(one.text, /Use offset=3 to continue/)
  const two = readDocx(zip, { offset: 3, limit: 5, maxCellLength: 50, maxBytes: 100000 })
  assert.match(two.text, /\[table 2x2\]/)
  assert.match(two.text, /A1 \| B1/)
})

test('docx: a non-ZIP buffer is a readable rejection', () => {
  assert.throws(() => readDocx(Buffer.from('not a docx'), { offset: 1, limit: 5 }), /not a DOCX container/)
})

// ---------------------------------------------------------------- credential guard

test('credential paths are refused, ordinary files are not', () => {
  assert.equal(isCredentialPath('C:\\Users\\x\\.ssh\\id_rsa'), true)
  assert.equal(isCredentialPath('/home/x/.aws/credentials'), true)
  assert.equal(isCredentialPath('/proj/.npmrc'), true)
  assert.equal(isCredentialPath('E:\\proj\\credentials.json'), true)
  assert.equal(isCredentialPath('E:\\proj\\server.pem'), true)
  assert.equal(isCredentialPath('E:\\proj\\app.env'), true)
  assert.equal(isCredentialPath('E:\\proj\\src\\index.js'), false)
  assert.equal(isCredentialPath('E:\\proj\\notes.txt'), false)
  assert.throws(() => { throw credentialDenied() }, /credential material/)
})
