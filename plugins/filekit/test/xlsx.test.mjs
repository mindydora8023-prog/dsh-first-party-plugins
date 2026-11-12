/**
 * XLSX reader tests: pure-function units plus locally authored minimal OOXML
 * workbooks. Fixtures are committed under test/fixtures so the suite is
 * self-contained.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  columnIndex,
  parseSharedStrings,
  parseDateStyles,
  parseSheet,
  listSheets,
  serialToIso,
  readXlsx,
} from '../lib/xlsx.js'

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
  assert.match(r.text, /# Region \| Units \| Revenue \| Note/)
  assert.match(r.text, /1: North \| 120 \| 4800\.5 \| ok/)
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
  assert.match(page.text, /2: South/)
  assert.equal(page.returned, 1)
  assert.match(page.text, /Use offset=3 to continue/)
})

test('readXlsx renders a real date cell and a boolean cell', () => {
  const buf = fixture('dates.xlsx')
  const r = readXlsx(buf, { offset: 1, limit: 10, maxCellLength: 100, maxBytes: 50000 })
  assert.match(r.text, /a \| 2026-10-23 \| TRUE/)
  assert.match(r.text, /b \| 2026-01-02 03:04:05 \| FALSE/)
})

test('readXlsx rejects a non-ZIP buffer and an unknown sheet', () => {
  assert.throws(() => readXlsx(Buffer.from('not a workbook'), { offset: 1, limit: 5 }), /not an XLSX container/)
  assert.throws(
    () => readXlsx(fixture('sample.xlsx'), { offset: 1, limit: 5, sheet: 'Nope', maxCellLength: 100, maxBytes: 50000 }),
    /worksheet not found/,
  )
})
