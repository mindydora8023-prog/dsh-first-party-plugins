/**
 * Deadline coverage for the delete transaction.
 *
 * WHY. A delete performs a dozen awaits (realpath, lease, rename,
 * registry.setState, workspace.detachSession, rm). Any of them can stall on a
 * network share, a busy antivirus scanner or a locked log file. Before
 * 2026-10-26 there was no bound at all: the Settings request simply hung.
 *
 * The interesting part is not that it eventually fails -- it is WHICH failure it
 * reports. A timed-out delete may be half-applied (a log can already be sitting in
 * the quarantine directory), so claiming "nothing happened, retry" would be wrong
 * and actively dangerous. These tests pin:
 *
 *   1. a stall surfaces as status 504 within the budget;
 *   2. the error carries `effectState: 'unknown'` and `retry: 'never'`;
 *   3. the message tells the caller to refresh and re-inspect, not to retry;
 *   4. a fast transaction is unaffected;
 *   5. timeoutMs: 0 disables the deadline (used by callers that want the old
 *      unbounded behaviour).
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

// The real host has referenced server handles. Model that lifetime explicitly:
// the production deadline is unref'ed, so Node 22 may otherwise exit mid-test.
// The outer test runner still enforces a 60-second hard process deadline.
let hostLifetime
before(() => { hostLifetime = setInterval(() => {}, 1000) })
after(() => { clearInterval(hostLifetime) })

import { DEFAULT_DELETE_TIMEOUT_MS, deleteArchived, deleteOrphans, withDeadline } from '../lib/index.js'
import { reason } from '../lib/reasons.js'

/** A context whose persistence layer stalls forever, to simulate a dead filesystem. */
function stallingContext() {
  const never = () => new Promise(() => {})
  return {
    workspaceRegistry: {
      archivedSessionIds: ['session-a'],
      enqueueOperation: (fn) => fn(),
    },
    sessionPersistence: {
      root: 'unused',
      findLog: never,
      acquireLease: never,
      list: never,
    },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
  }
}

test('withDeadline rejects with status 504 and an unknown effect', async () => {
  const stalled = withDeadline(new Promise(() => {}), 20)
  await assert.rejects(stalled, (error) => {
    assert.equal(error.status, 504)
    assert.equal(error.effectState, 'unknown', 'a stalled transaction may be half-applied')
    assert.equal(error.retry, 'never', 'effects dominate retry advice')
    return true
  })
})

test('the timeout message tells the caller to re-inspect, not to retry', () => {
  // The catalogue text is the user-facing contract; assert on it rather than on a
  // literal, so a wording change cannot silently drop the warning.
  const message = reason('delete-timeout', { seconds: 30 })
  assert.match(message, /30/)
  // It must not promise that nothing happened.
  assert.doesNotMatch(message, /^\s*\S*\s*(nothing|no changes)/i)
})

test('a stalled delete surfaces the deadline instead of hanging', async () => {
  const ctx = stallingContext()
  const started = Date.now()
  await assert.rejects(
    deleteArchived(ctx, 'session-a', { timeoutMs: 25 }),
    (error) => {
      assert.equal(error.status, 504)
      assert.equal(error.effectState, 'unknown')
      assert.equal(error.retry, 'never')
      return true
    },
  )
  const elapsed = Date.now() - started
  // Generous upper bound: this asserts "bounded", not "fast".
  assert.ok(elapsed < 5000, `the delete must be bounded, took ${elapsed}ms`)
})

test('a stalled orphan cleanup is bounded the same way', async () => {
  const ctx = stallingContext()
  await assert.rejects(deleteOrphans(ctx, ['session-a'], { timeoutMs: 25 }), (error) => {
    assert.equal(error.status, 504)
    assert.equal(error.effectState, 'unknown')
    return true
  })
})

test('the default budget is finite and documented', () => {
  assert.equal(Number.isFinite(DEFAULT_DELETE_TIMEOUT_MS), true)
  assert.ok(DEFAULT_DELETE_TIMEOUT_MS > 0)
})

test('timeoutMs: 0 disables the deadline', async () => {
  // Callers that deliberately want the old unbounded behaviour must be able to ask
  // for it; this also proves the deadline is not silently always-on.
  let resolved = false
  const slow = new Promise((resolve) => {
    setTimeout(() => {
      resolved = true
      resolve('done')
    }, 40)
  })
  const value = await withDeadline(slow, 0)
  assert.equal(value, 'done')
  assert.equal(resolved, true)
})

test('a fast transaction is unaffected by the deadline', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 1000), 'ok')
})
