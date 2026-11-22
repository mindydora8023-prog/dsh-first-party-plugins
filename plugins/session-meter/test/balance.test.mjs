/**
 * createBalanceReader: key-gating, parsing, error-quieting, and the 60s cache.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, createBalanceReader } from '../lib/index.js'

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

test('returns no-key and never fetches without a key', async () => {
  let calls = 0
  const read = createBalanceReader({
    keyProvider: () => '',
    fetchImpl: async () => { calls += 1; return response({}) },
  })
  assert.deepEqual(await read(), { ok: false, reason: 'no-key' })
  assert.equal(calls, 0)
})

test('parses balance_infos into CNY strings', async () => {
  const read = createBalanceReader({
    keyProvider: () => 'sk-test',
    fetchImpl: async (url) => {
      assert.match(url, /user\/balance$/)
      return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })
    },
  })
  const value = await read()
  assert.equal(value.ok, true)
  assert.equal(value.available, true)
  assert.deepEqual(value.balances[0], { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' })
})

test('an HTTP error is a quiet ok:false', async () => {
  const read = createBalanceReader({ keyProvider: () => 'k', fetchImpl: async () => response({}, { ok: false, status: 401 }) })
  assert.deepEqual(await read(), { ok: false, reason: 'http', status: 401 })
})

test('fetch and JSON errors expose only a fixed reason', async () => {
  const fail = async () => { throw new Error('synthetic upstream details') }
  for (const fetchImpl of [fail, async () => ({ ok: true, json: fail })]) {
    const read = createBalanceReader({ keyProvider: () => 'k', fetchImpl })
    assert.deepEqual(await read(), { ok: false, reason: 'error' })
  }
})

test('caches a successful read for 60s, then refetches', async () => {
  let calls = 0
  let clock = 1_000_000
  const read = createBalanceReader({
    keyProvider: () => 'k',
    now: () => clock,
    fetchImpl: async () => { calls += 1; return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5' }] }) },
  })
  await read()
  clock += 30_000
  await read()
  assert.equal(calls, 1, 'within TTL reuses the cache')
  clock += 31_000
  await read()
  assert.equal(calls, 2, 'past TTL refetches')
})

function balanceResponse(total) {
  return response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total }] })
}

test('a key rotation, removal, or failed refresh never reuses another credential result', async () => {
  let key = 'fixture-a'
  const calls = []
  const read = createBalanceReader({
    keyProvider: () => key,
    fetchImpl: async (_url, { headers }) => {
      const authorization = headers.authorization
      calls.push(authorization)
      if (authorization === 'Bearer fixture-b') return response({}, { ok: false, status: 401 })
      return balanceResponse(String(calls.length))
    },
  })
  assert.equal((await read()).balances[0].total, '1')
  key = 'fixture-b'
  assert.deepEqual(await read(), { ok: false, reason: 'http', status: 401 })
  key = 'fixture-a'
  assert.equal((await read()).balances[0].total, '3')
  key = ''
  assert.deepEqual(await read(), { ok: false, reason: 'no-key' })
  key = 'fixture-a'
  assert.equal((await read()).balances[0].total, '4')
  assert.deepEqual(calls, ['Bearer fixture-a', 'Bearer fixture-b', 'Bearer fixture-a', 'Bearer fixture-a'])
})

test('an older in-flight read cannot replace the new key cache', async () => {
  let key = 'fixture-a'
  const oldResponse = Promise.withResolvers()
  const request = async (_url, { headers }) => {
    if (headers.authorization === 'Bearer fixture-a') return oldResponse.promise
    return balanceResponse('2')
  }
  const fetchImpl = test.mock.fn(request)
  const read = createBalanceReader({ keyProvider: () => key, fetchImpl })
  const oldRead = read()
  key = 'fixture-b'
  assert.equal((await read()).balances[0].total, '2')
  oldResponse.resolve(balanceResponse('1'))
  assert.equal((await oldRead).balances[0].total, '1')
  assert.equal((await read()).balances[0].total, '2')
  assert.equal(fetchImpl.mock.callCount(), 2)
})

test('the mounted route requires a loopback socket and pins its credential destination', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'session-meter-balance-'))
  const env = {
    SESSION_METER_OFFLINE: '0',
    SESSION_METER_STATUS_FILE: join(scratch, 'status.json'),
    SESSION_METER_CACHE_FILE: join(scratch, 'prices.json'),
    SESSION_METER_DEEPSEEK_KEY: 'fixture-balance-key',
    SESSION_METER_BALANCE_URL: 'https://fixture.invalid/balance',
  }
  Object.assign(process.env, env)
  const disposers = []
  t.after(() => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    for (const name of Object.keys(env)) delete process.env[name]
    rmSync(scratch, { recursive: true, force: true })
  })
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('synthetic upstream details')
  })
  const routes = new Map()
  apply({
    effect(factory) { disposers.push(factory()) },
    get(name) {
      assert.equal(name, 'webServer')
      return { register(spec) { routes.set(spec.path, spec.handler) } }
    },
  })
  const handler = routes.get('/session-meter/balance')
  assert.equal(typeof handler, 'function')
  async function call(request) {
    const result = {}
    await handler({ method: 'GET', ...request }, {
      writeHead(status, headers) { Object.assign(result, { status, headers }) },
      end(body) { result.body = body === undefined ? undefined : JSON.parse(body) },
    })
    return result
  }
  for (const socket of [undefined, null, {}, { remoteAddress: null }, { remoteAddress: '' }, { remoteAddress: '192.0.2.1' }]) {
    const result = await call({ socket, headers: { 'x-forwarded-for': '127.0.0.1' } })
    assert.equal(result.status, 403)
    assert.deepEqual(result.body, { ok: false, reason: 'forbidden' })
  }
  assert.equal((await call({ method: 'HEAD' })).body, undefined)
  assert.equal(fetchMock.mock.callCount(), 0)
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const result = await call({ socket: { remoteAddress } })
    assert.equal(result.status, 200)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.deepEqual(result.body, { ok: false, reason: 'error' })
  }
  assert.equal(fetchMock.mock.callCount(), 3)
  for (const { arguments: [url, options] } of fetchMock.mock.calls) {
    assert.equal(url, 'https://api.deepseek.com/user/balance')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer fixture-balance-key')
  }
})
