/**
 * historyRecallStep: pure ArrowUp/ArrowDown recall decision.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  memo: (fn) => fn,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

let captured
globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition } } }
await import('../lib/client.js')
const plugin = captured.factory((name) => {
  if (name === 'react') return REACT_STUB
  throw new Error('unexpected require: ' + name)
})
const I = plugin.__internals

const items = [{ text: 'one' }, { text: 'two' }, { text: 'three' }]

test('ArrowUp from empty draft recalls the newest prompt', () => {
  assert.deepEqual(I.historyRecallStep(items, null, '', 'ArrowUp'), { action: 'set', index: 2, text: 'three' })
})

test('ArrowUp cycles to older prompts while a recalled prompt is showing', () => {
  const first = I.historyRecallStep(items, null, '', 'ArrowUp')
  const second = I.historyRecallStep(items, { index: first.index, text: first.text }, 'three', 'ArrowUp')
  assert.deepEqual(second, { action: 'set', index: 1, text: 'two' })
  const third = I.historyRecallStep(items, { index: 1, text: 'two' }, 'two', 'ArrowUp')
  assert.deepEqual(third, { action: 'set', index: 0, text: 'one' })
  // Already at the oldest: stays there.
  assert.deepEqual(I.historyRecallStep(items, { index: 0, text: 'one' }, 'one', 'ArrowUp'), { action: 'set', index: 0, text: 'one' })
})

test('ArrowDown moves toward newer, then clears past the newest', () => {
  assert.deepEqual(I.historyRecallStep(items, { index: 1, text: 'two' }, 'two', 'ArrowDown'), { action: 'set', index: 2, text: 'three' })
  assert.deepEqual(I.historyRecallStep(items, { index: 2, text: 'three' }, 'three', 'ArrowDown'), { action: 'clear' })
})

test('ArrowDown does nothing when not recalling', () => {
  assert.equal(I.historyRecallStep(items, null, '', 'ArrowDown'), null)
})

test('does not hijack arrows when the user is typing a different draft', () => {
  assert.equal(I.historyRecallStep(items, { index: 2, text: 'three' }, 'three plus', 'ArrowUp'), null)
})

test('returns null for an empty pool or an unrelated key', () => {
  assert.equal(I.historyRecallStep([], null, '', 'ArrowUp'), null)
  assert.equal(I.historyRecallStep(items, null, '', 'ArrowLeft'), null)
})
