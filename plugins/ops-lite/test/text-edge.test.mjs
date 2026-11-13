import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeUtf8 } from '../lib/access.js'
import { buildWindow } from '../lib/text.js'

test('decodeUtf8 strips a UTF-8 BOM', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
  assert.equal(decodeUtf8(bom, 'bom.txt'), 'hello')
})

test('decodeUtf8 rejects UTF-16LE (its NUL bytes mark it binary)', () => {
  assert.throws(() => decodeUtf8(Buffer.from('abc', 'utf16le'), 'u16.txt'), /binary content/)
})

test('a lone CR does not end a line; only LF does', () => {
  const w = buildWindow('a\rb\r', { offset: 1, limit: 10, maxLineLength: 1000, maxBytes: 10000 })
  assert.equal(w.lineCount, 1)
  assert.equal(w.lines[0].text, 'a\rb')
})

test('CRLF counts as one line end and a trailing LF adds no phantom line', () => {
  const w = buildWindow('a\r\nb\r\n', { offset: 1, limit: 10, maxLineLength: 1000, maxBytes: 10000 })
  assert.equal(w.lineCount, 2)
  assert.equal(w.complete, true)
})
