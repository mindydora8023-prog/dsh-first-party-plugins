import test from 'node:test'
import assert from 'node:assert/strict'

import { parseSheet } from '../lib/xlsx.js'

test('a far-column reference is dropped instead of building a huge row', () => {
  const sheet = '<sheetData><row r="1">'
    + '<c r="XFD1" t="inlineStr"><is><t>far</t></is></c>'
    + '<c r="A1" t="inlineStr"><is><t>ok</t></is></c>'
    + '</row></sheetData>'
  const { rows } = parseSheet(sheet, [], new Set(), { maxRows: 10, maxCells: 1000 })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].length < 1024, 'row width must stay bounded')
  assert.deepEqual(rows[0], ['ok'])
})
