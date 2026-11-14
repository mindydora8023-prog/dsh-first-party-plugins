import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { LineReader } from '../lib/reader.js'
import { readTaggedResponse } from '../lib/imap.js'
import { readReply, MAX_SMTP_LINES } from '../lib/smtp.js'

/** Minimal socket stand-in: only the events and methods the readers touch. */
function fakeSocket() {
  const socket = new EventEmitter()
  socket.write = () => true
  socket.end = () => {}
  socket.destroy = () => { socket.emit('close') }
  return socket
}

function push(socket, text) {
  socket.emit('data', Buffer.from(text))
}

test('a silent peer rejects the read instead of waiting forever', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket, { idleMs: 40 })
  const started = Date.now()
  await assert.rejects(reader.readLine(), /no data from the server for 40ms/)
  assert.ok(Date.now() - started < 2000, 'the idle deadline must fire without a long wait')
})

test('data that arrives inside the idle window is still delivered', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket, { idleMs: 500 })
  const pending = reader.readLine()
  push(socket, 'a1 OK done\r\n')
  assert.equal(await pending, 'a1 OK done')
})

test('a tagged reply is returned and an untagged line is kept', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket)
  const pending = readTaggedResponse(reader, 'a1')
  push(socket, '* 1 EXISTS\r\na1 OK [READ-ONLY] done\r\n')
  const response = await pending
  assert.equal(response.status, 'OK')
  assert.match(response.text, /EXISTS/)
  assert.equal(response.literals.length, 0)
})

test('a declared literal larger than the cap is refused before it is read', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket)
  const pending = readTaggedResponse(reader, 'a1', { maxLiteralBytes: 8 })
  push(socket, '* 1 FETCH (BODY[] {1000}\r\n')
  await assert.rejects(pending, /exceeds the 8-byte limit/)
})

test('untagged lines without a tag stop at the line cap', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket)
  const pending = readTaggedResponse(reader, 'a1', { maxLines: 3 })
  push(socket, '* 1 EXISTS\r\n* 2 EXISTS\r\n* 3 EXISTS\r\n* 4 EXISTS\r\n')
  await assert.rejects(pending, /exceeded 3 lines/)
})

test('an SMTP continuation flood stops at the line cap', async () => {
  const socket = fakeSocket()
  const reader = new LineReader(socket)
  const pending = readReply(reader)
  let body = ''
  for (let i = 0; i < MAX_SMTP_LINES + 2; i += 1) body += '250-still going\r\n'
  push(socket, body)
  await assert.rejects(pending, new RegExp(`exceeded ${MAX_SMTP_LINES} lines`))
})
