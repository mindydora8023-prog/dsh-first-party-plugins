/**
 * Mount lifecycle without a host: enable, a second enable, disable, and the TTL.
 *
 * The timer is real but unref'd, so a forgotten assertion cannot pin the process.
 * Disposal is a fake, which is the whole contract these tools have with the host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools } from '../lib/tools.js'

function harness(ttlMs = 60000, options = {}) {
  const disposed = []
  const live = new Map()
  let mounts = 0
  let clock = options.clock === 'real' ? Date.now() : 10_000
  const statuses = options.statuses || []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { definitions: () => options.tools || [] },
  }
  const config = {
    servers: {
      REA: { entry: { transport: 'stdio', startupTimeoutMs: options.startupTimeoutMs }, ttlMs, description: 'Ghidra' },
      desk: { entry: { transport: 'stdio' }, ttlMs, description: 'desktop clicks' },
    },
    defaultTtlMs: ttlMs,
    maxConcurrent: options.maxConcurrent,
  }
  const state = {
    live,
    now: () => (options.clock === 'real' ? Date.now() : clock),
    sleep: async () => { clock += 200 },
    catalog: options.catalog || { servers: {} },
    limit: options.limit,
    manager: () => ({
      register(name) {
        mounts += 1
        return () => { disposed.push(name) }
      },
      list: () => (mounts > 0 ? [{ name: 'REA', status: statuses.shift() || { state: 'connected', toolCount: 1 } }] : []),
      probe: options.probe,
    }),
  }
  const built = buildTools(ctx, config, state)
  const tools = Object.fromEntries(built.map((tool) => [tool.name, tool]))
  tools.noteActivity = built.noteActivity
  tools.hold = built.hold
  tools.prompt = built.prompt
  return { tools, live, disposed, mounts: () => mounts, clock: () => clock }
}

function textOf(parts) {
  assert.ok(Array.isArray(parts), 'render must return content parts, not a string')
  assert.equal(parts[0].type, 'text')
  return parts[0].text
}

test('list shows an idle server and enable mounts it once', async () => {
  const { tools, live, mounts } = harness()
  const listed = await tools.mcpod_list.execute({})
  assert.equal(listed.servers[0].name, 'REA')
  assert.equal(listed.servers[0].running, false)
  assert.match(textOf(tools.mcpod_list.output.render({}, listed)), /off/)

  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 })
  assert.equal(enabled.running, true)
  assert.equal(mounts(), 1)
  assert.equal(live.get('REA').timer, undefined)
  assert.match(enabled.note, /no time-to-live/)
})

test('enabling a mounted server extends its release instead of mounting again', async () => {
  const { tools, mounts } = harness()
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  const again = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 90 })
  assert.equal(mounts(), 1)
  assert.equal(again.running, true)
  assert.match(again.note, /90s/)
  await tools.mcpod_disable.execute({ name: 'REA' })
})

test('disable disposes the mount and a second disable is a no-op', async () => {
  const { tools, live, disposed } = harness()
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  const released = await tools.mcpod_disable.execute({ name: 'REA' })
  assert.equal(released.running, false)
  assert.deepEqual(disposed, ['REA'])
  assert.equal(live.has('REA'), false)
  const missing = await tools.mcpod_disable.execute({ name: 'REA' })
  assert.match(missing.note, /not mounted/)
  assert.equal(disposed.length, 1)
})

test('an unknown server is refused without touching the manager', async () => {
  const { tools, mounts } = harness()
  const refused = await tools.mcpod_enable.execute({ name: 'nope' })
  assert.equal(refused.running, false)
  assert.equal(refused.status, 'unknown server')
  assert.equal(mounts(), 0)
})

test('a real mcp tool call restarts the release clock', async () => {
  const { tools, live, disposed } = harness(60000, { clock: 'real' })
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  const before = live.get('REA').expiresAt
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(tools.noteActivity('mcp__REA__open_binary'), true)
  assert.ok(live.get('REA').expiresAt > before, 'the deadline moved forward')
  assert.equal(tools.noteActivity('mcpod_list'), false)
  assert.equal(tools.noteActivity('mcp__other__tool'), false)
  await tools.mcpod_disable.execute({ name: 'REA' })
  assert.deepEqual(disposed, ['REA'])
})

test('a server mounted without a time-to-live is not released by later calls', async () => {
  const { tools, live } = harness()
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 })
  assert.equal(tools.noteActivity('mcp__REA__open_binary'), false)
  assert.equal(live.get('REA').timer, undefined)
  await tools.mcpod_disable.execute({ name: 'REA' })
})

test('a time-to-live disposes the server without another call', async () => {
  const { tools, live, disposed } = harness()
  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 1 })
  assert.equal(enabled.running, true)
  assert.equal(typeof live.get('REA').timer, 'object')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.deepEqual(disposed, ['REA'])
  assert.equal(live.has('REA'), false)
})

test('enable returns once the host says connected and records the tool names', async () => {
  const { tools, clock } = harness(60000, {
    tools: [{ name: 'mcp__REA__open_binary', description: 'load a program' }],
  })
  const started = clock()
  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 })
  assert.equal(enabled.status, 'connected')
  assert.deepEqual(enabled.tools, ['mcp__REA__open_binary'])
  assert.ok(clock() - started < 8000)
  const found = await tools.mcpod_find.execute({ query: 'program' })
  assert.equal(found.hits[0].call, 'mcp__REA__open_binary')
  await tools.mcpod_disable.execute({ name: 'REA' })
})

test('a failed connection is released instead of left mounted', async () => {
  const { tools, live, disposed } = harness(60000, { statuses: [{ state: 'failed', lastError: 'exit 1' }] })
  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  assert.equal(enabled.running, false)
  assert.match(enabled.status, /failed/)
  assert.equal(live.has('REA'), false)
  assert.deepEqual(disposed, ['REA'])
})

test('a call in flight is not released when its idle timer expires', async () => {
  const { tools, live, disposed } = harness()
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 1 })
  const release = tools.hold('mcp__REA__open_binary')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(live.has('REA'), true)
  assert.deepEqual(disposed, [])
  release()
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.deepEqual(disposed, ['REA'])
})

test('two enables of one server share a single registration', async () => {
  const { tools, mounts } = harness(60000, {
    statuses: [{ state: 'connecting' }, { state: 'connecting' }, { state: 'connected' }],
  })
  const [first, second] = await Promise.all([
    tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 }),
    tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 }),
  ])
  assert.equal(mounts(), 1)
  assert.equal(first.running, true)
  assert.equal(second.running, true)
  await tools.mcpod_disable.execute({ name: 'REA' })
})
