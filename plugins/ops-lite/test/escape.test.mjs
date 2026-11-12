/**
 * Escaping and byte budgets.
 *
 * Two properties are load-bearing enough to fail loudly if reverted:
 *
 *   1. ONE SOURCE LINE IS ALWAYS ONE RENDERED ROW. If a raw CR, LF or U+2028
 *      survived escaping, file content could forge extra line numbers and
 *      headers into the model's view of the file.
 *   2. THE BUDGET COUNTS ESCAPED BYTES. Measuring source characters instead
 *      lets a result blow the context window while believing it was under the
 *      limit.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { encodeSourceLine, quote, escapedBytes, capText, DEFAULT_TEXT_BUDGET } from '../lib/escape.js'

test('backslashes are doubled so escapes stay reversible', () => {
  assert.equal(encodeSourceLine('a\\tb'), 'a\\\\tb')
  assert.equal(encodeSourceLine('a\tb'), 'a\\tb')
  // The two source characters backslash + t must not collide with a real tab.
  assert.notEqual(encodeSourceLine('\\t'), encodeSourceLine('\t'))
})

test('a raw newline can never survive into one rendered row', () => {
  const escaped = encodeSourceLine('a\nb')
  assert.equal(escaped, 'a\\u000ab')
  assert.equal(escaped.includes('\n'), false)
})

test('carriage returns and controls are escaped', () => {
  for (const char of ['\r', '\u0000', '\u001f', '\u007f']) {
    const escaped = encodeSourceLine(`x${char}y`)
    assert.equal(/[\r\n\t\u0000-\u001f\u007f]/.test(escaped), false, `control ${JSON.stringify(char)} leaked`)
  }
})

test('unicode line separators are escaped so they cannot break a row', () => {
  for (const char of ['\u0085', '\u2028', '\u2029']) {
    const escaped = encodeSourceLine(`x${char}y`)
    assert.equal(escaped.includes(char), false)
    assert.match(escaped, /\\u(0085|2028|2029)/)
  }
})

test('ordinary text and tabs are preserved byte-for-byte otherwise', () => {
  assert.equal(encodeSourceLine('const x = 1 // ok'), 'const x = 1 // ok')
  assert.equal(encodeSourceLine('  indented'), '  indented')
  assert.equal(encodeSourceLine('quote " stays'), 'quote " stays')
})

test('an astral character is not split by escaping', () => {
  const escaped = encodeSourceLine('a\u{1F600}b')
  assert.equal(escaped, 'a\u{1F600}b')
})

test('quote keeps a heading on one row', () => {
  const quoted = quote('a\nb\u2028c')
  assert.equal(quoted.includes('\n'), false)
  assert.equal(quoted.startsWith('"'), true)
  assert.equal(quoted.endsWith('"'), true)
})

test('escaped cost is measured on the encoded block, not the source', () => {
  // A tab costs two escaped characters, so escaped cost exceeds source cost.
  const withTab = '\t'.repeat(10)
  assert.ok(escapedBytes(withTab) > Buffer.byteLength(withTab, 'utf8'))
})

test('a body inside the budget is returned untouched', () => {
  const text = 'short body'
  assert.equal(capText(text, { budget: 512 }), text)
})

test('an oversized body is cut and carries a recovery notice', () => {
  const text = 'x'.repeat(5000)
  const capped = capText(text, { budget: 512, reason: 'output-budget', recovery: 'Use a smaller limit.' })
  assert.ok(escapedBytes(capped) <= 512, 'the notice itself must fit inside the budget')
  assert.match(capped, /Display incomplete/)
  assert.match(capped, /TruncatedBy: output-budget/)
  assert.match(capped, /Use a smaller limit\./)
})

test('the cut respects multi-byte characters', () => {
  const text = '\u4e2d'.repeat(2000)
  const capped = capText(text, { budget: 512 })
  assert.ok(escapedBytes(capped) <= 512)
  // A cut inside a character would decode to U+FFFD.
  assert.equal(capped.includes('\ufffd'), false)
})

test('the cut never splits a surrogate pair', () => {
  const text = '\u{1F600}'.repeat(1000)
  for (const budget of [512, 700, 1024]) {
    const capped = capText(text, { budget })
    assert.ok(escapedBytes(capped) <= budget)
    assert.equal(capped.includes('\ufffd'), false)
    // A lone high surrogate at the boundary shows up as an unpaired code unit.
    const body = capped.split('\n[Notice:')[0]
    for (let index = 0; index < body.length; index += 1) {
      const code = body.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = body.charCodeAt(index + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff, 'a high surrogate was left unpaired')
      }
    }
  }
})

test('an out-of-range budget is rejected rather than clamped silently', () => {
  assert.throws(() => capText('x', { budget: 1 }), RangeError)
  assert.throws(() => capText('x', { budget: 2 * 1024 * 1024 }), RangeError)
  assert.throws(() => capText('x', { budget: 1.5 }), RangeError)
})

test('the default budget is a sane positive number', () => {
  assert.equal(Number.isSafeInteger(DEFAULT_TEXT_BUDGET), true)
  assert.ok(DEFAULT_TEXT_BUDGET >= 4096)
})

test('a custom measure can be injected for deterministic boundary tests', () => {
  const measure = (text) => text.length
  const capped = capText('y'.repeat(100), { budget: 512, measure })
  assert.equal(capped, 'y'.repeat(100))
  const tight = capText('y'.repeat(5000), { budget: 512, measure })
  assert.ok(measure(tight) <= 512)
})
