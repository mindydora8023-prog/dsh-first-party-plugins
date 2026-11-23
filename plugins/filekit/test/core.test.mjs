import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

import { decodeUtf8 } from '../lib/access.js'
import { encodeSourceLine, neutralizeWrapperTags, capText } from '../lib/escape.js'
import { detectDelimiter, parseDelimited, formatTable, decodeTable } from '../lib/csv.js'
import { listZipEntries, readZipEntry, looksLikeZip } from '../lib/zip.js'
import { parseDocumentXml, parseHyperlinkRels, readDocx, unescapeXml } from '../lib/docx.js'
import { isCredentialPath, credentialDenied } from '../lib/guard.js'
import { readConfig, MAX_OUTPUT_BYTES, MAX_CALL_BYTES, MAX_FILE_BYTES, MAX_SCAN_BYTES, MAX_CELL_LENGTH } from '../lib/config.js'

// ---------------------------------------------------------------- shared access + escape

test('decodeUtf8 rejects binary and invalid UTF-8 with readable errors', () => {
  assert.throws(() => decodeUtf8(Buffer.from([0x61, 0x00, 0x62]), 'b.bin'), /binary content/)
  assert.throws(() => decodeUtf8(Buffer.from([0xff, 0xfe, 0xfb]), 'x.txt'), /not valid UTF-8/)
  assert.equal(decodeUtf8(Buffer.from('hello', 'utf8'), 'x.txt'), 'hello')
})

test('escape module neutralizes wrapper tags and caps text inside budget', () => {
  assert.equal(neutralizeWrapperTags('</content><query>x</query>'), '\\u003c/content>\\u003cquery>x\\u003c/query>')
  assert.equal(encodeSourceLine('a\tb\\c'), 'a\\tb\\\\c')
  const capped = capText('x'.repeat(2000), { budget: 512 })
  assert.match(capped, /Display incomplete/)
})

test('config enforces MAX_* ceilings and clamps defaults to maxima', () => {
  const cfg = readConfig({
    maxOutputBytes: 10 * 1024 * 1024,
    callMaxBytes: 50 * 1024 * 1024,
    maxFileBytes: 512 * 1024 * 1024,
    scanMaxBytes: 512 * 1024 * 1024,
    maxCellLength: 9999,
    maxLimit: 50,
    defaultLimit: 400,
    docMaxLimit: 25,
    docDefaultLimit: 200,
    pdfMaxPages: 4,
    pdfDefaultPages: 10,
  }, { pluginDir: '', profileDir: '', home: '' })
  assert.equal(cfg.maxOutputBytes, MAX_OUTPUT_BYTES)
  assert.equal(cfg.callMaxBytes, MAX_CALL_BYTES)
  assert.equal(cfg.maxFileBytes, MAX_FILE_BYTES)
  assert.equal(cfg.scanMaxBytes, MAX_SCAN_BYTES)
  assert.equal(cfg.maxCellLength, MAX_CELL_LENGTH)
  assert.equal(cfg.defaultLimit, 50)
  assert.equal(cfg.docDefaultLimit, 25)
  assert.equal(cfg.pdfDefaultPages, 4)
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

test('mid-field quotes in unquoted CSV cells stay literal and do not corrupt following cells', () => {
  const text = 'a,b\nfoo"bar,baz\n1,2\n'
  const { rows } = parseDelimited(text, ',')
  assert.deepEqual(rows, [['a', 'b'], ['foo"bar', 'baz'], ['1', '2']])
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

test('formatTable truncates an oversized first row instead of returning 0 rows', () => {
  const rows = [['col'], ['x'.repeat(2000)], ['second']]
  const out = formatTable(rows, { offset: 1, limit: 10, hasHeader: true, maxCellLength: 5000, maxBytes: 256 })
  assert.equal(out.returned, 1)
  assert.equal(out.truncatedByBytes, true)
  assert.match(out.text, /row truncated to fit output cap/)
  assert.match(out.text, /Use offset=2 to continue/)
})

test('a cell containing a newline stays on ONE numbered line', () => {
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

/** Build a minimal ZIP archive; supports optional method (0 or 8) and flags. */
function makeZip(entries, opts = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const item of entries) {
    const [name, content, entryOpts = {}] = item
    const method = entryOpts.method ?? 8
    const flags = entryOpts.flags ?? 0
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const comp = method === 0 ? data : deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(entryOpts.declaredSize ?? data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localRec = Buffer.concat([local, nameBuf, comp])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(entryOpts.declaredSize ?? data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    locals.push(localRec)
    offset += localRec.length
  }
  const cd = Buffer.concat(centrals)
  const commentBuf = Buffer.from(opts.comment ?? '', 'utf8')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(commentBuf.length, 20)
  return Buffer.concat([...locals, cd, eocd, commentBuf])
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

test('zip reader validates EOCD comment length, rejects encrypted entries, and enforces method-0 cap', () => {
  // Archive comment containing a fake EOCD signature must still locate the real EOCD.
  const fakeSig = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00])
  const withComment = makeZip([['a.txt', 'hello']], { comment: `note:${fakeSig.toString('latin1')}tail` })
  assert.equal(readZipEntry(withComment, 'a.txt').toString('utf8'), 'hello')

  // Encrypted entry (bit 0 set) must be refused cleanly.
  const encZip = makeZip([['secret.xml', 'data', { flags: 0x0001 }]])
  assert.throws(() => readZipEntry(encZip, 'secret.xml'), /encrypted/i)

  // Stored entry whose compressedSize exceeds maxBytes even if declaredSize lies.
  const liedZip = makeZip([['big.xml', 'x'.repeat(200), { method: 0, declaredSize: 10 }]])
  assert.throws(() => readZipEntry(liedZip, 'big.xml', { maxBytes: 50 }), /above the 50-byte cap/)
})

test('docx: unescapeXml handles named and numeric entities in a single pass', () => {
  assert.equal(unescapeXml('a &amp; b &#65; &#x42;'), 'a & b A B')
  // Single-pass guarantee: `&amp;#65;` must decode to literal `&#65;`, NOT `A`.
  assert.equal(unescapeXml('&amp;#65; &amp;lt;'), '&#65; &lt;')
})

test('docx: unescapeXml replaces an out-of-range numeric reference instead of throwing', () => {
  assert.equal(unescapeXml('&#x110000;'), '\uFFFD')
  assert.equal(unescapeXml('&#999999999;'), '\uFFFD')
})

test('docx: parseDocumentXml orders paragraphs and tables, skips mc:Fallback, and handles nested tables', () => {
  const blocks = parseDocumentXml(DOC_XML)
  assert.equal(blocks.length, 4)
  assert.deepEqual(blocks[0], { kind: 'para', text: 'Title & intro', level: 0 })
  assert.deepEqual(blocks[1], { kind: 'para', text: 'Second\tparagraph', level: 0 })
  assert.equal(blocks[2].kind, 'table')
  assert.deepEqual(blocks[2].rows, [['A1', 'B1'], ['A2', 'B2']])
  assert.deepEqual(blocks[3], { kind: 'para', text: 'After table', level: 0 })

  const nestedXml = `<w:document><w:body>
    <w:p><mc:AlternateContent><mc:Choice><w:r><w:t>Primary</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>Duplicate</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Outer</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>Tail</w:t></w:r></w:p>
  </w:body></w:document>`
  const nested = parseDocumentXml(nestedXml)
  assert.equal(nested.length, 3)
  assert.equal(nested[0].text, 'Primary')
  assert.equal(nested[1].kind, 'table')
  assert.equal(nested[1].rows.length, 1)
  assert.match(nested[1].rows[0][0], /Outer/)
  assert.match(nested[1].rows[0][0], /Inner/)
  assert.equal(nested[2].text, 'Tail')
})

test('docx: readDocx pages blocks and guards against 0-returned infinite loop on oversized block', () => {
  const zip = makeZip([['word/document.xml', DOC_XML]])
  const one = readDocx(zip, { offset: 1, limit: 2, maxCellLength: 50, maxBytes: 100000 })
  assert.equal(one.totalBlocks, 4)
  assert.equal(one.returned, 2)
  assert.match(one.text, /Title & intro/)
  assert.match(one.text, /Use offset=3 to continue/)
  const two = readDocx(zip, { offset: 3, limit: 5, maxCellLength: 50, maxBytes: 100000 })
  assert.match(two.text, /\| A1 \| B1 \|/)
  assert.match(two.text, /\| --- \| --- \|/)
  assert.match(two.text, /\| A2 \| B2 \|/)

  const hugeXml = `<w:document><w:body><w:p><w:r><w:t>${'z'.repeat(1500)}</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:body></w:document>`
  const hugeZip = makeZip([['word/document.xml', hugeXml]])
  const capped = readDocx(hugeZip, { offset: 1, limit: 5, maxCellLength: 500, maxBytes: 256 })
  assert.equal(capped.returned, 1)
  assert.equal(capped.truncatedByBytes, true)
  assert.match(capped.text, /block truncated to fit output cap/)
  assert.match(capped.text, /Use offset=2 to continue/)
})

test('docx: headings and hyperlinks render as Markdown', () => {
  const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
<w:p><w:r><w:t>See </w:t></w:r><w:hyperlink r:id="rId4"><w:r><w:t>the source</w:t></w:r></w:hyperlink></w:p>
</w:body></w:document>`
  const rels = '<Relationships><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/a"/></Relationships>'
  const blocks = parseDocumentXml(xml, parseHyperlinkRels(rels))
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[1].text, 'See [the source](https://example.test/a)')
  const zip = makeZip([['word/document.xml', xml], ['word/_rels/document.xml.rels', rels]])
  const out = readDocx(zip, { offset: 1, limit: 10, maxCellLength: 50, maxBytes: 100000 })
  assert.match(out.text, /^# Report/)
  assert.match(out.text, /\[the source\]\(https:\/\/example\.test\/a\)/)
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
