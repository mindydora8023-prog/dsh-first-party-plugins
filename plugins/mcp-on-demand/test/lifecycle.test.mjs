/**
 * Mount lifecycle without a host: enable, renew, disable, TTL, probe, races, and unload.
 *
 * The timer is real but unref'd, so a forgotten assertion cannot pin the process.
 * Disposal is a fake, which is the whole contract these tools have with the host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiter, createNameLock } from '../lib/limit.js'
import { buildTools } from '../lib/tools.js'

function harness(ttlMs = 60000, options = {}) {
  const disposed = []
  const live = new Map()
  let mounts = 0
  let clock = options.clock === 'real' ? Date.now() : 10_000
  const statuses = options.statuses || []
  const registered = new Set()
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      definitions: () => {
        if (typeof options.tools === 'function') return options.tools(registered)
        return options.tools || []
      },
    },
  }
  const config = {
    servers: {
      REA: { entry: { transport: 'stdio', command: 'node', startupTimeoutMs: options.startupTimeoutMs }, ttlMs, description: 'Ghidra' },
      desk: { entry: { transport: 'stdio', command: 'node' }, ttlMs, description: 'desktop clicks' },
      ...(options.extraServers || {}),
    },
    defaultTtlMs: ttlMs,
    maxConcurrent: options.maxConcurrent,
  }
  const state = {
    live,
    now: () => (options.clock === 'real' ? Date.now() : clock),
    sleep: 'sleep' in options ? options.sleep : (async () => { clock += 200 }),
    catalog: options.catalog || { servers: {} },
    limit: options.limit || createLimiter(options.maxConcurrent || 2),
    lock: options.lock || createNameLock(),
    isDisposed: options.isDisposed,
    signal: options.signal,
    manager: () => ({
      register(name) {
        mounts += 1
        registered.add(name)
        return () => {
          if (typeof options.onDispose === 'function') options.onDispose(name)
          registered.delete(name)
          disposed.push(name)
        }
      },
      list: () => [...registered].map((name) => ({
        name,
        status: statuses.shift() || { state: 'connected', toolCount: 1 },
      })),
      probe: options.probe,
    }),
  }
  const built = buildTools(ctx, config, state)
  const tools = Object.fromEntries(built.map((tool) => [tool.name, tool]))
  tools.noteActivity = built.noteActivity
  tools.hold = built.hold
  tools.prompt = built.prompt
  return { tools, built, live, disposed, registered, mounts: () => mounts, clock: () => clock }
}

function textOf(parts) {
  assert.ok(Array.isArray(parts), 'render must return content parts, not a string')
  assert.equal(parts[0].type, 'text')
  return parts[0].text
}

test('all six tools declare isConcurrencySafe, timeoutMs, and valid schemas', () => {
  const { built } = harness()
  assert.equal(built.length, 6)
  for (const tool of built) {
    assert.equal(typeof tool.isConcurrencySafe, 'function', `${tool.name} missing isConcurrencySafe`)
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `${tool.name} missing timeoutMs`)
  }
  const listTool = built.find((t) => t.name === 'mcpod_list')
  assert.ok(Array.isArray(listTool.output.schema.properties.servers.items.properties.catalog.oneOf))
})

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

test('disable keeps the entry in live if dispose throws', async () => {
  const { tools, live } = harness(60000, {
    onDispose() { throw new Error('busy child process') },
  })
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 })
  const res = await tools.mcpod_disable.execute({ name: 'REA' })
  assert.equal(res.running, true)
  assert.match(res.note, /busy child process/)
  assert.equal(live.has('REA'), true)
})

test('an unknown server is refused without touching the manager', async () => {
  const { tools, mounts } = harness()
  const refused = await tools.mcpod_enable.execute({ name: 'nope' })
  assert.equal(refused.running, false)
  assert.equal(refused.status, 'unknown server')
  assert.equal(mounts(), 0)
})

test('a real mcp tool call restarts the release clock and matches underscored server names', async () => {
  const { tools, live, disposed } = harness(60000, {
    clock: 'real',
    extraServers: {
      my_srv: { entry: { transport: 'stdio', command: 'node' }, ttlMs: 60000 },
      my_srv_v2: { entry: { transport: 'stdio', command: 'node' }, ttlMs: 60000 },
    },
  })
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  await tools.mcpod_enable.execute({ name: 'my_srv_v2', ttl_seconds: 30 })
  const before = live.get('REA').expiresAt
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(tools.noteActivity('mcp__REA__open_binary'), true)
  assert.ok(live.get('REA').expiresAt > before, 'the deadline moved forward')
  assert.equal(tools.noteActivity('mcp__my_srv_v2__run'), true)
  assert.equal(tools.noteActivity('mcpod_list'), false)
  assert.equal(tools.noteActivity('mcp__other__tool'), false)
  await tools.mcpod_disable.execute({ name: 'REA' })
  await tools.mcpod_disable.execute({ name: 'my_srv_v2' })
  assert.deepEqual(disposed, ['REA', 'my_srv_v2'])
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
  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0.05 })
  assert.equal(enabled.running, true)
  assert.equal(typeof live.get('REA').timer, 'object')
  await new Promise((resolve) => setTimeout(resolve, 110))
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

test('a call in flight is not released when its idle timer expires and reports in_flight', async () => {
  const { tools, live, disposed } = harness()
  await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0.05 })
  const release = tools.hold('mcp__REA__open_binary')
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(live.has('REA'), true)
  assert.deepEqual(disposed, [])
  const listed = await tools.mcpod_list.execute({})
  const row = listed.servers.find((s) => s.name === 'REA')
  assert.equal(row.in_flight, true)
  assert.match(textOf(tools.mcpod_list.output.render({}, listed)), /in-flight/)
  release()
  await new Promise((resolve) => setTimeout(resolve, 110))
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

test('probing an unmounted server temporarily registers, learns descriptions, and disposes cleanly', async () => {
  // Realistic dsh-mcp-manager behavior: probe(name) throws unknown server unless registered.
  const { tools, live, disposed, registered } = harness(60000, {
    tools: (reg) => (reg.has('REA')
      ? [{ name: 'mcp__REA__decompile', description: 'decompile a binary function' }]
      : []),
    probe: async (name) => {
      if (!registered.has(name)) throw new Error(`unknown server: ${name}`)
      return { ok: true, toolNames: ['decompile'] }
    },
  })
  const probed = await tools.mcpod_probe.execute({ name: 'REA' })
  assert.equal(probed.ok, true)
  assert.deepEqual(probed.tools, ['decompile'])
  assert.equal(live.has('REA'), false, 'probe must not leave server in live map')
  assert.equal(registered.has('REA'), false, 'probe must dispose temporary registration')
  assert.deepEqual(disposed, ['REA'])
  // Description from host was preserved in the catalog so mcpod_find can match it!
  const found = await tools.mcpod_find.execute({ query: 'binary' })
  assert.equal(found.hits[0].call, 'mcp__REA__decompile')
  assert.match(found.hits[0].description, /decompile a binary function/)
})

test('disable during in-flight enable serializes through the lock and releases cleanly', async () => {
  let resumeConnect
  let step = 0
  const { tools, live, disposed } = harness(60000, {
    statuses: [{ state: 'connecting' }, { state: 'connected' }],
    sleep: () => new Promise((resolve) => {
      step += 1
      if (step === 1) resumeConnect = resolve
      else resolve()
    }),
  })
  const enablePromise = tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 0 })
  // Wait a microtask so enable enters waitUntilReady.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const disablePromise = tools.mcpod_disable.execute({ name: 'REA' })
  resumeConnect()
  const [enabled, disabled] = await Promise.all([enablePromise, disablePromise])
  assert.equal(enabled.running, true)
  assert.equal(disabled.running, false)
  assert.equal(live.has('REA'), false)
  assert.deepEqual(disposed, ['REA'])
})

test('unloading during an in-flight mount aborts promptly and leaves no dangling registration', async () => {
  let isDisposedFlag = false
  const unload = new AbortController()
  const { tools, live, disposed, registered } = harness(60000, {
    statuses: [{ state: 'connecting' }, { state: 'connecting' }, { state: 'connecting' }],
    isDisposed: () => isDisposedFlag,
    signal: unload.signal,
    sleep: undefined,
  })
  const enablePromise = tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 30 })
  await new Promise((resolve) => setTimeout(resolve, 15))
  isDisposedFlag = true
  unload.abort()
  const result = await enablePromise
  assert.equal(result.running, false)
  assert.equal(result.status, 'disposed')
  assert.equal(live.has('REA'), false)
  assert.equal(registered.has('REA'), false)
  assert.deepEqual(disposed, ['REA'])
})
