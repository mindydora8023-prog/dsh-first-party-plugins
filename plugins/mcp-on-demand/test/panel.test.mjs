/**
 * The settings panel reads one route. These tests cover that route and the
 * fields the page renders, without a host and without mounting a process.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { handleServersRequest, SERVERS_PATH } from '../lib/routes.js'
import { buildTools, targetOf } from '../lib/tools.js'

function harness() {
  const disposed = []
  const live = new Map()
  const ctx = { logger: { info() {}, warn() {} }, tools: { list: () => ['mcp__REA__open_binary'] } }
  const config = {
    servers: {
      REA: {
        entry: {
          transport: 'stdio',
          command: 'node',
          args: ['rea.mjs', 'mcp'],
          env: { TOKEN: 'hidden' },
        },
        ttlMs: 60000,
      },
      desk: { entry: { transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }, ttlMs: 0 },
    },
    defaultTtlMs: 60000,
  }
  const tools = Object.fromEntries(buildTools(ctx, config, {
    live,
    manager: () => ({
      register(name) { return () => { disposed.push(name) } },
      list: () => [{ name: 'REA', status: 'connected' }],
    }),
  }).map((tool) => [tool.name, tool]))
  return { tools, disposed }
}

function call(tools, method, body) {
  return handleServersRequest({
    method,
    path: SERVERS_PATH,
    bodyText: body === undefined ? '' : JSON.stringify(body),
    tools,
  })
}

test('a GET lists every configured server and hides credentials', async () => {
  const { tools } = harness()
  const result = await call(tools, 'GET')
  assert.equal(result.status, 200)
  assert.deepEqual(result.value.servers.map((server) => server.name), ['REA', 'desk'])
  assert.equal(result.value.servers[0].running, false)
  assert.equal(result.value.servers[0].release, 'default')
  assert.equal(result.value.servers[0].target, 'node rea.mjs mcp')
  assert.equal(result.value.servers[1].target, 'http://127.0.0.1:9/mcp')
  assert.equal(JSON.stringify(result.value).includes('hidden'), false)
})

test('enable then disable through the route matches the tool result', async () => {
  const { tools, disposed } = harness()
  const enabled = await call(tools, 'POST', { name: 'REA', action: 'enable', ttl_seconds: 0 })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.value.result.running, true)
  const row = enabled.value.servers.find((server) => server.name === 'REA')
  assert.equal(row.running, true)
  assert.equal(row.release, 'off')
  assert.deepEqual(row.tools, ['mcp__REA__open_binary'])

  const released = await call(tools, 'POST', { name: 'REA', action: 'disable' })
  assert.equal(released.value.result.running, false)
  assert.equal(released.value.servers.find((server) => server.name === 'REA').running, false)
  assert.deepEqual(disposed, ['REA'])
})

test('a bad body is refused before any tool runs', async () => {
  const { tools } = harness()
  const missing = await handleServersRequest({ method: 'POST', path: SERVERS_PATH, bodyText: '{', tools })
  assert.equal(missing.status, 400)
  assert.equal(missing.value.error, 'invalid-json')
  const unknown = await call(tools, 'POST', { name: 'REA', action: 'restart' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.value.error, 'unknown-action')
  const elsewhere = await handleServersRequest({ method: 'GET', path: '/api/other', bodyText: '', tools })
  assert.equal(elsewhere.status, 404)
})

test('targetOf never prints env or headers', () => {
  assert.equal(targetOf({ transport: 'stdio', command: 'node', args: ['a'], env: { SECRET: 'x' } }), 'node a')
  assert.equal(targetOf({ transport: 'streamable-http', url: 'http://h', headers: { Authorization: 'x' } }), 'http://h')
  assert.equal(targetOf(undefined), '')
})
