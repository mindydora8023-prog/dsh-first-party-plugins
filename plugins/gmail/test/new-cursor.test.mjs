import test from 'node:test'
import assert from 'node:assert/strict'

import { selectNewMessages } from '../lib/tools.js'

// `Imap.search` returns UIDs descending (newest first); the cursor logic must
// never skip a message when a burst is larger than one page (`limit`).

test('baseline samples the newest `limit` and moves the cursor to the newest uid', () => {
  const r = selectNewMessages(['100', '99', '98', '97', '96'], 0, 2, { baseline: true })
  assert.deepEqual(r.fresh, ['100', '99'])
  assert.equal(r.cursor, 100)
})

test('a burst larger than `limit` returns the oldest page and does NOT skip messages', () => {
  // previous = 20, new = 21..30 (descending). A naive cursor jump to 30 would
  // drop 21..27 forever. Instead the oldest `limit` are returned and the cursor
  // only advances to the newest one actually returned.
  const uids = ['30', '29', '28', '27', '26', '25', '24', '23', '22', '21']
  const r = selectNewMessages(uids, 20, 3)
  assert.deepEqual(r.fresh, ['23', '22', '21'])
  assert.equal(r.cursor, 23)
})

test('a large burst is fully drained across successive calls with no duplicates or gaps', () => {
  const all = ['30', '29', '28', '27', '26', '25', '24', '23', '22', '21']
  let previous = 20
  const seen = []
  for (let guard = 0; guard < 20; guard += 1) {
    const r = selectNewMessages(all, previous, 3)
    if (r.fresh.length === 0) break
    seen.push(...r.fresh)
    previous = r.cursor
  }
  assert.deepEqual(seen.slice().sort(), all.slice().sort())
  assert.equal(new Set(seen).size, seen.length)
})

test('no new mail keeps the stored cursor', () => {
  const r = selectNewMessages(['10', '9', '8'], 10, 5)
  assert.deepEqual(r.fresh, [])
  assert.equal(r.cursor, 10)
})

test('non-numeric uids are ignored and an empty result keeps the cursor', () => {
  const r = selectNewMessages(['abc', '', '12'], 12, 5)
  assert.deepEqual(r.fresh, [])
  assert.equal(r.cursor, 12)
})
