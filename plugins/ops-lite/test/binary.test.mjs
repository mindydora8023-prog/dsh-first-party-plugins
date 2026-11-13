import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeUtf8 } from '../lib/access.js'

test('a NUL byte past the first 8 KiB is refused as binary', () => {
  // Text head long enough that a first-8-KiB-only sniff would miss the NUL.
  const buf = Buffer.concat([Buffer.from('a'.repeat(9000), 'utf8'), Buffer.from([0]), Buffer.from('b')])
  assert.throws(() => decodeUtf8(buf, 'late-nul.txt'), /binary content/)
})

test('clean text longer than 8 KiB still decodes', () => {
  const buf = Buffer.from('b'.repeat(20000), 'utf8')
  assert.equal(decodeUtf8(buf, 'big.txt').length, 20000)
})
