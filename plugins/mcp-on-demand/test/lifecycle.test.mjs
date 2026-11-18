/**
 * Mount lifecycle without a host: enable, a second enable, disable, and the TTL.
 *
 * The timer is real but unref'd, so a forgotten assertion cannot pin the process.
 * Disposal is a fake, which is the whole contract these tools have with the host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools } from '../lib/tools.js'

function harness(ttlMs = 60000) {
  const disposed = []
  const live = new Map()
  let mounts = 0
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { list: () => [] },
  }
  const config = {
    servers: {
      REA: { entry: { transport: 'stdio' }, ttlMs },
    },
    defaultTtlMs: ttlMs,
  }
  const state = {
    live,
    manager: () => ({
      register(name) {
        mounts += 1
        return () => { disposed.push(name) }
      },
      list: () => [],
    }),
  }
  const tools = Object.fromEntries(buildTools(ctx, config, state).map((tool) => [tool.name, tool]))
  return { tools, live, disposed, mounts: () => mounts }
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

test('a time-to-live disposes the server without another call', async () => {
  // enable() waits 400ms so the client can connect. A shorter TTL fires during
  // that wait, which is a different case from "it was running, then it expired".
  const { tools, live, disposed } = harness()
  const enabled = await tools.mcpod_enable.execute({ name: 'REA', ttl_seconds: 1 })
  assert.equal(enabled.running, true)
  assert.equal(typeof live.get('REA').timer, 'object')
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.deepEqual(disposed, ['REA'])
  assert.equal(live.has('REA'), false)
})
