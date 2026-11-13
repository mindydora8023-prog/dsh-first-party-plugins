import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { LineReader } from '../lib/reader.js'

/** Minimal socket stand-in: only the events/methods LineReader touches. */
function fakeSocket() {
  const s = new EventEmitter()
  s.write = () => true
  s.end = () => {}
  s.destroy = () => {}
  return s
}

test('readLine reassembles a line split across chunks', async () => {
  const s = fakeSocket()
  const r = new LineReader(s)
  const p = r.readLine()
  s.emit('data', Buffer.from('hel'))
  s.emit('data', Buffer.from('lo\r'))
  s.emit('data', Buffer.from('\n'))
  assert.equal(await p, 'hello')
})

test('readBytes reassembles a large literal across many chunks', async () => {
  const s = fakeSocket()
  const r = new LineReader(s)
  const total = 100000
  const p = r.readBytes(total)
  for (let i = 0; i < total; i += 1000) s.emit('data', Buffer.alloc(1000, (i / 1000) % 256))
  const out = await p
  assert.equal(out.length, total)
  for (let i = 0; i < total; i += 1000) assert.equal(out[i], (i / 1000) % 256)
})

test('a line, then a literal, then a line are read in order from one stream', async () => {
  const s = fakeSocket()
  const r = new LineReader(s)
  const p1 = r.readLine()
  s.emit('data', Buffer.from('A1 OK\r\n'))
  assert.equal(await p1, 'A1 OK')
  const p2 = r.readBytes(3)
  s.emit('data', Buffer.from('xyz'))
  assert.equal((await p2).toString(), 'xyz')
  const p3 = r.readLine()
  s.emit('data', Buffer.from('tail\r\n'))
  assert.equal(await p3, 'tail')
})

test('a closed connection with too few bytes rejects the read', async () => {
  const s = fakeSocket()
  const r = new LineReader(s)
  const p = r.readBytes(10)
  s.emit('data', Buffer.from('abc'))
  s.emit('close')
  await assert.rejects(p, /closed/)
})
