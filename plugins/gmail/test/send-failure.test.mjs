/**
 * The send-failure contract for gmail_send.
 *
 * Why this suite exists: `gmail_send` used to `throw` on any SMTP problem. A
 * bare throw tells the model "the call failed" and nothing else, and the one
 * case where that is dangerous is the one this suite covers -- a failure after
 * the message body has been written to the server. The mail may already have
 * been delivered, so re-sending would duplicate it.
 *
 * The assertion that matters: a failure after the DATA body must report
 * effectState "unknown" and retry "never". Reverting to a bare throw, or
 * reporting "none" there, fails this suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { sendFailureRecord } from '../lib/tools.js'
import { sendMail } from '../lib/smtp.js'

const envelope = { from: 'me@example.com', to: ['you@example.com'], cc: [] }

/** Build an error shaped the way lib/smtp.js raises one. */
function smtpFailure(phase, message = 'simulated failure') {
  const error = new Error(message)
  error.smtpPhase = phase
  error.deliveryPossible = phase === 'data-body' || phase === 'data-reply'
  return error
}

test('a failure before the DATA body is retryable and changed nothing', () => {
  for (const phase of ['greeting', 'ehlo', 'auth', 'mail-from', 'rcpt', 'data-command']) {
    const record = sendFailureRecord(smtpFailure(phase), envelope)
    assert.equal(record.sent, false)
    assert.equal(record.error.effectState, 'none', `${phase} cannot have delivered anything`)
    assert.equal(record.error.retry, 'after-input-change', `${phase} should be safely retryable`)
    assert.equal(record.error.code, 'SEND_FAILED')
    assert.equal(record.error.phase, phase)
  }
})

test('a failure after the DATA body is an unknown outcome that must not be retried', () => {
  for (const phase of ['data-body', 'data-reply']) {
    const record = sendFailureRecord(smtpFailure(phase), envelope)
    assert.equal(record.sent, false)
    assert.equal(record.status, 'unknown')
    assert.equal(record.error.effectState, 'unknown', `${phase} may already have delivered`)
    assert.equal(record.error.retry, 'never', `${phase} must never license a resend`)
    assert.equal(record.error.code, 'DELIVERY_OUTCOME_UNKNOWN')
    assert.match(record.error.nextAction, /Do not resend/)
  }
})

test('an unclassified transport error is treated as retryable but never as delivered', () => {
  // A refused connection carries no phase. It cannot have delivered, so the safe
  // reading is effectState none -- but the record must still be complete.
  const record = sendFailureRecord(new Error('connect ECONNREFUSED'), envelope)
  assert.equal(record.error.effectState, 'none')
  assert.equal(record.error.retry, 'after-input-change')
  assert.equal(record.error.phase, 'unknown')
  assert.equal(record.status, 'error')
})

test('a non-Error throw is still classified without crashing', () => {
  const record = sendFailureRecord('plain string failure', envelope)
  assert.equal(record.error.message, 'plain string failure')
  assert.equal(record.error.effectState, 'none')
})

test('the recipient envelope is echoed back so the model can see what was attempted', () => {
  const record = sendFailureRecord(smtpFailure('rcpt'), { from: 'me@example.com', to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'] })
  assert.equal(record.from, 'me@example.com')
  assert.deepEqual(record.to, ['a@x.com', 'b@x.com'])
  assert.deepEqual(record.cc, ['c@x.com'])
})

test('the credential is never part of the failure record', () => {
  const record = sendFailureRecord(smtpFailure('auth', 'SMTP authentication failed'), envelope)
  const serialized = JSON.stringify(record)
  assert.equal(/password|app password/i.test(serialized), false)
  assert.match(record.error.message, /authentication failed/)
})

test('a real send against a closed port fails without claiming delivery', async () => {
  try {
    await sendMail({
      host: '127.0.0.1',
      port: 1,
      user: 'nobody@example.com',
      password: 'x',
      from: 'nobody@example.com',
      recipients: ['nobody@example.com'],
      message: 'Subject: test\r\n\r\nbody',
      timeoutMs: 2000,
    })
    assert.fail('expected the send to fail against a closed port')
  } catch (error) {
    const record = sendFailureRecord(error, envelope)
    assert.equal(record.error.effectState, 'none', 'a refused connection cannot have delivered')
    assert.equal(record.error.retry, 'after-input-change')
  }
})