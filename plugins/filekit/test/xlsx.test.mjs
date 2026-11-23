/**
 * XLSX reader tests: pure-function units plus a real workbook written by
 * openpyxl. Fixtures are committed under test/fixtures so the suite is
 * self-contained.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import {
  columnIndex,
  isDate1904,
  parseSharedStrings,
  parseDateStyles,
  parseSheet,
  listSheets,
  serialToIso,
  readXlsx,
} from '../lib/xlsx.js'
import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name))

test('columnIndex maps Excel letters to 0-based columns', () => {
  assert.equal(columnIndex('A'), 0)
  assert.equal(columnIndex('B'), 1)
  assert.equal(columnIndex('Z'), 25)
  assert.equal(columnIndex('AA'), 26)
  assert.equal(columnIndex('AB'), 27)
  assert.equal(columnIndex('BA'), 52)
})

test('parseSharedStrings joins rich-text runs and decodes entities', () => {
  const xml = '<sst><si><t>plain</t></si><si><r><t>ri</t></r><r><t>ch &amp; text</t></r></si></sst>'
  assert.deepEqual(parseSharedStrings(xml), ['plain', 'rich & text'])
})

test('serialToIso covers whole dates and date-times', () => {
  assert.equal(serialToIso(46318), '2026-10-23') // 2026-10-23 in the 1900 system
  assert.match(serialToIso(46318.5), /^2026-10-23 12:00/)
})

test('parseDateStyles recognises builtin and custom date formats', () => {
  const xml = `<styleSheet>
    <numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
    <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="2"/></cellXfs>
  </styleSheet>`
  const set = parseDateStyles(xml)
  assert.equal(set.has(0), false) // General
  assert.equal(set.has(1), true) // builtin date
  assert.equal(set.has(2), true) // custom date
  assert.equal(set.has(3), false) // number
})

test('parseSheet handles shared, inline, boolean, error and numeric cells', () => {
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline</t></is></c></row>
    <row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><v>DIV/0!</v></c></row>
  </sheetData></worksheet>`
  const { rows } = parseSheet(sheet, ['shared'], new Set(), {})
  assert.deepEqual(rows[0], ['shared', 'inline'])
  assert.deepEqual(rows[1], ['42', 'TRUE', '#DIV/0!'])
})

test('parseSheet converts a date-styled numeric cell', () => {
  // The cell's `s` attribute is a cellXfs index; index 1 is the date style here.
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>46318</v></c></row></sheetData></worksheet>'
  const { rows } = parseSheet(sheet, [], new Set([1]), {})
  assert.deepEqual(rows[0], ['2026-10-23'])
})

test('listSheets resolves r:id through the rels map', () => {
  const wb = '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Meta" sheetId="2" r:id="rId2"/></sheets></workbook>'
  // Both a relative target and an absolute "/xl/..." target normalise to the
  // same xl-relative spelling, which is what sheetPart() later re-prefixes.
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'
  const sheets = listSheets(wb, rels)
  assert.deepEqual(sheets, [
    { name: 'Sales', rid: 'rId1', target: 'worksheets/sheet1.xml' },
    { name: 'Meta', rid: 'rId2', target: 'worksheets/sheet2.xml' },
  ])
})

test('readXlsx reads the real workbook, pages rows, and lists sheets', () => {
  const buf = fixture('sample.xlsx')
  const r = readXlsx(buf, { offset: 1, limit: 50, maxCellLength: 100, maxBytes: 50000 })
  assert.equal(r.sheetName, 'Sales')
  assert.deepEqual(r.sheets, ['Sales', 'Meta'])
  assert.equal(r.totalRows, 3)
  assert.match(r.text, /## Sales/)
  assert.match(r.text, /\| Region \| Units \| Revenue \| Note \|/)
  assert.match(r.text, /\| North \| 120 \| 4800\.5 \| ok \|/)
  assert.match(r.text, /## Meta/)
  assert.match(r.text, /End of sheet "Sales" - 3 data rows/)
})

test('readXlsx selects an alternate sheet by name and by index', () => {
  const buf = fixture('sample.xlsx')
  const byName = readXlsx(buf, { offset: 1, limit: 10, sheet: 'Meta', maxCellLength: 100, maxBytes: 50000 })
  assert.equal(byName.sheetName, 'Meta')
  assert.match(byName.text, /generated \| 2026-10-23/)
  const byIndex = readXlsx(buf, { offset: 1, limit: 10, sheet: 2, maxCellLength: 100, maxBytes: 50000 })
  assert.equal(byIndex.sheetName, 'Meta')
})

test('readXlsx pages with offset and reports continuation', () => {
  const buf = fixture('sample.xlsx')
  const page = readXlsx(buf, { offset: 2, limit: 1, maxCellLength: 100, maxBytes: 50000 })
  assert.match(page.text, /\| South \|/)
  assert.equal(page.returned, 1)
  assert.match(page.text, /Use offset=3 to continue/)
})

test('readXlsx renders a real date cell and a boolean cell', () => {
  const buf = fixture('dates.xlsx')
  const r = readXlsx(buf, { offset: 1, limit: 10, maxCellLength: 100, maxBytes: 50000 })
  assert.match(r.text, /\| a \| 2026-10-23 \| TRUE \|/)
  assert.match(r.text, /\| b \| 2026-01-02 03:04:05 \| FALSE \|/)
})

test('readXlsx rejects a non-ZIP buffer and an unknown sheet', () => {
  assert.throws(() => readXlsx(Buffer.from('not a workbook'), { offset: 1, limit: 5 }), /not an XLSX container/)
  assert.throws(
    () => readXlsx(fixture('sample.xlsx'), { offset: 1, limit: 5, sheet: 'Nope', maxCellLength: 100, maxBytes: 50000 }),
    /worksheet not found/,
  )
})

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
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const localRec = Buffer.concat([local, nameBuf, comp])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
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

test('has_header: false keeps data row 0 without dropping it', () => {
  const buf = fixture('sample.xlsx')
  const r = readXlsx(buf, { offset: 1, limit: 10, sheet: 'Sales', hasHeader: false, maxCellLength: 100, maxBytes: 50000 })
  assert.equal(r.totalRows, 4)
  assert.equal(r.returned, 4)
  assert.match(r.text, /\| Region \| Units \| Revenue \| Note \|/)
  assert.match(r.text, /\| North \| 120 \| 4800\.5 \| ok \|/)
  assert.doesNotMatch(r.text, /\| --- \|/)
})

test('parseDateStyles keeps currency/color formats as numbers, skips rPh ruby, handles date1904 and #DIV/0!', () => {
  const stylesXml = `<styleSheet>
    <numFmts>
      <numFmt numFmtId="164" formatCode="[$USD] 0.00"/>
      <numFmt numFmtId="165" formatCode="[Red]#,##0.00"/>
      <numFmt numFmtId="166" formatCode="[Blue]yyyy-mm-dd"/>
    </numFmts>
    <cellXfs><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs>
  </styleSheet>`
  const set = parseDateStyles(stylesXml)
  assert.equal(set.has(0), false, '[$USD] must remain a number')
  assert.equal(set.has(1), false, '[Red]#,##0 must remain a number')
  assert.equal(set.has(2), true, '[Blue]yyyy-mm-dd must be a date')

  assert.equal(isDate1904('<workbook><workbookPr date1904="1"/></workbook>'), true)
  assert.equal(serialToIso(0, true), '1904-01-01')

  // Phonetic ruby <rPh> inside <si> must be skipped.
  const sst = '<sst><si><t>Kanji</t><rPh sb="0" eb="1"><t>kana</t></rPh></si></sst>'
  assert.deepEqual(parseSharedStrings(sst), ['Kanji'])

  // Error cell already starting with `#` must not become `##DIV/0!`.
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>'
  const { rows } = parseSheet(sheet, [], new Set(), {})
  assert.deepEqual(rows[0], ['#DIV/0!'])
})

test('readXlsx enforces maxBytes row-by-row on primary sheet and supports numeric sheet name match', async () => {
  const rowsXml = Array.from({ length: 20 }, (_, i) =>
    `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>row-${i + 1}-${'v'.repeat(40)}</t></is></c></row>`,
  ).join('')
  const wb = makeZip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="2" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`],
    ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SecondSheet</t></is></c></row></sheetData></worksheet>'],
  ])

  // Primary sheet row-by-row maxBytes cap with continuation hint.
  const capped = readXlsx(wb, { offset: 1, limit: 20, sheet: '2', hasHeader: false, maxCellLength: 100, maxBytes: 260 })
  assert.equal(capped.truncatedByBytes, true)
  assert.ok(capped.returned >= 1 && capped.returned < 20)
  assert.match(capped.text, new RegExp(`Use offset=${capped.returned + 1} to continue`))

  // Tool layer must not pre-convert sheet="2" into index 2 before exact name match!
  const ctx = {
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      async stat() { return { type: 'file', size: wb.length, version: 'v1' } },
      async readBytes() { return wb },
    },
    emit() {},
  }
  const cfg = readConfig({ statusFile: false }, { pluginDir: '', profileDir: '', home: '' })
  const xlsxTool = buildTools(cfg, ctx).find((t) => t.name === 'filekit_read_xlsx')
  const out = await xlsxTool.execute({ path: 'num.xlsx', sheet: '2', limit: 2 }, { signal: new AbortController().signal })
  assert.equal(out.sheet, '2')
  assert.match(out.text, /row-1-/)
})
