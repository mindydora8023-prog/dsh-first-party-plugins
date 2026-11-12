/**
 * The structured-failure contract.
 *
 * The property under test is not "the function returns an object"; it is that
 * EFFECTS DOMINATE RETRY ADVICE. Reversing that precedence would make a
 * half-applied mutation look safe to replay, which is the exact failure this
 * module exists to prevent -- so the assertion fails if it is reverted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EFFECT_STATES,
  RETRY_POLICIES,
  ERROR_POLICIES,
  errorPolicy,
  failure,
  fromThrown,
  isFailure,
  FS_CODE_MAP,
} from '../lib/outcome.js'

test('a failure always answers code, effect state and retry advice', () => {
  const result = failure('NOT_FOUND', { message: 'no such file' })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'NOT_FOUND')
  assert.equal(result.error.effectState, 'none')
  assert.equal(result.error.retry, 'after-input-change')
  assert.ok(RETRY_POLICIES.includes(result.error.retry))
  assert.ok(EFFECT_STATES.includes(result.error.effectState))
  assert.ok(result.error.message.length > 0)
})

test('an omitted effect state means nothing happened', () => {
  assert.equal(failure('IO_ERROR').error.effectState, 'none')
})

test('an invalid effect state never reaches the record', () => {
  assert.equal(failure('IO_ERROR', { effectState: 'probably' }).error.effectState, 'none')
})

test('once an effect may have happened, retry advice is never permissive', () => {
  for (const effectState of ['applied', 'partial', 'unknown']) {
    const result = failure('NOT_FOUND', { effectState, })
    assert.equal(result.error.retry, 'never', `${effectState} must not license a retry`)
  }
})

test('an unknown outcome overrides a code that would otherwise be retryable', () => {
  assert.equal(errorPolicy('NOT_FOUND', 'unknown').retry, 'never')
  assert.equal(errorPolicy('NOT_FOUND', 'applied').retry, 'never')
  assert.equal(errorPolicy('NOT_FOUND', 'none').retry, 'after-input-change')
})

test('effects dominate even for a policy-denied code', () => {
  assert.equal(errorPolicy('POLICY_DENIED', 'none').status, 'rejected')
  assert.equal(errorPolicy('POLICY_DENIED', 'partial').retry, 'never')
})

test('unknown codes settle instead of guessing', () => {
  assert.equal(errorPolicy('SOMETHING_NEW').retry, 'never')
  assert.equal(errorPolicy('SOMETHING_NEW').status, 'error')
})

test('the result-unknown codes are never retryable', () => {
  assert.equal(errorPolicy('RESULT_UNKNOWN').retry, 'never')
  assert.equal(errorPolicy('EXECUTION_RESTRICTED').retry, 'never')
})

test('every table entry uses the declared vocabularies', () => {
  for (const [code, entry] of Object.entries(ERROR_POLICIES)) {
    assert.ok(RETRY_POLICIES.includes(entry.retry), `${code} retry`)
    assert.ok(['rejected', 'conflict', 'error', 'unknown'].includes(entry.status), `${code} status`)
  }
})

test('a host fs error keeps its identity through the mapping', () => {
  const error = new Error('cannot read: stale')
  error.code = 'FS_STALE_VERSION'
  const result = fromThrown(error)
  assert.equal(result.error.code, 'REVISION_CONFLICT')
  assert.equal(result.error.retry, 'after-state-change')
  assert.match(result.error.message, /stale/)
})

test('an unclassified throw is never retryable', () => {
  const result = fromThrown(new Error('something odd'))
  assert.equal(result.error.code, 'IO_ERROR')
  assert.equal(result.error.retry, 'never')
})

test('every mapped fs code resolves to a known policy', () => {
  for (const mapped of Object.values(FS_CODE_MAP)) {
    assert.equal(typeof mapped, 'string')
    assert.ok(mapped.length > 0)
    assert.ok(RETRY_POLICIES.includes(errorPolicy(mapped).retry), `${mapped} has a policy`)
  }
})

test('isFailure recognizes a record and rejects a success', () => {
  assert.equal(isFailure(failure('IO_ERROR')), true)
  assert.equal(isFailure({ items: [] }), false)
  assert.equal(isFailure(null), false)
  assert.equal(isFailure('nope'), false)
})

test('nextAction survives only when it is actionable', () => {
  assert.equal(failure('IO_ERROR', { nextAction: '' }).error.nextAction, undefined)
  assert.equal(failure('IO_ERROR', { nextAction: 're-read first' }).error.nextAction, 're-read first')
})
