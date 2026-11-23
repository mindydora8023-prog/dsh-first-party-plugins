/**
 * mcpod_health: config validation + catalog freshness + optional live probe.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools } from '../lib/tools.js'

function harness(options = {}) {
  const live = new Map()
  const ctx = { logger: { info() {}, warn() {} }, tools: { definitions: () => [] } }
  const config = {
    servers: {
      REA: { entry: { transport: 'stdio', command: 'node' }, ttlMs: 30000, description: 'Ghidra' },
      bad: { entry: { transport: 'stdio' } },
      web: { entry: { transport: 'streamable-http' } },
    },
    defaultTtlMs: 60000,
  }
  const state = {
    live,
    now: () => 10_000,
    catalog: options.catalog || { servers: { REA: { toolCount: 5, at: 10_000 - 3600 * 1000 } } },
    manager: () => ({ list: () => [], probe: options.probe }),
  }
  const built = buildTools(ctx, config, state)
  return { h: Object.fromEntries(built.map((t) => [t.name, t])), live }
}

function textOf(parts) {
  assert.ok(Array.isArray(parts))
  return parts[0].text
}

test('mcpod_health reports config, mount and catalog freshness', async () => {
  const { h } = harness()
  const out = await h.mcpod_health.execute({ name: 'REA' })
  assert.equal(out.ok, true)
  assert.match(out.text, /configured: yes/)
  assert.match(out.text, /mounted: no/)
  assert.match(out.text, /catalog: 5 tool\(s\), age 3600s/)
})

test('mcpod_health flags a malformed definition', async () => {
  const { h } = harness()
  const bad = await h.mcpod_health.execute({ name: 'bad' })
  assert.equal(bad.ok, false)
  assert.match(bad.text, /stdio needs a command/)
  const web = await h.mcpod_health.execute({ name: 'web' })
  assert.match(web.text, /streamable-http needs a url/)
})

test('mcpod_health shows an active mount with remaining ttl', async () => {
  const { h, live } = harness()
  live.set('REA', { ttlMs: 30000, expiresAt: 10_000 + 12_000, busy: 0, dispose() {} })
  const out = await h.mcpod_health.execute({ name: 'REA' })
  assert.match(out.text, /mounted: yes/)
  assert.match(out.text, /ttl=12s/)
})

test('mcpod_health probe:true does a bounded live check', async () => {
  const { h } = harness({ probe: async () => ({ ok: true, toolNames: ['a', 'b'] }) })
  const out = await h.mcpod_health.execute({ name: 'REA', probe: true })
  assert.match(out.text, /probe: reachable, 2 tool\(s\)/)
})

test('mcpod_health rejects an unknown server', async () => {
  const { h } = harness()
  const out = await h.mcpod_health.execute({ name: 'nope' })
  assert.equal(out.ok, false)
  assert.match(out.text, /No server called nope/)
})

test('mcpod_health propagates ok:false when probe fails or throws, and surfaces cached error', async () => {
  const failedProbe = harness({
    probe: async () => ({ ok: false, message: 'connection refused' }),
  })
  const outFail = await failedProbe.h.mcpod_health.execute({ name: 'REA', probe: true })
  assert.equal(outFail.ok, false)
  assert.match(outFail.text, /probe: failed: connection refused/)

  const throwingProbe = harness({
    probe: async () => { throw new Error('spawn ENOENT') },
  })
  const outThrow = await throwingProbe.h.mcpod_health.execute({ name: 'REA', probe: true })
  assert.equal(outThrow.ok, false)
  assert.match(outThrow.text, /probe: failed: spawn ENOENT/)

  const withCachedError = harness({
    catalog: { servers: { REA: { ok: false, toolCount: 0, at: 9000, error: 'prior timeout', tools: [] } } },
  })
  const outCached = await withCachedError.h.mcpod_health.execute({ name: 'REA' })
  assert.match(outCached.text, /prior timeout/)
})

test('mcpod_health shows active (in-flight) instead of stale ttl=0s while a call is running', async () => {
  const { h, live } = harness()
  // Even though expiresAt is already in the past, busy > 0 means a call is running.
  live.set('REA', { ttlMs: 30000, expiresAt: 5_000, busy: 1, inFlight: true, dispose() {} })
  const out = await h.mcpod_health.execute({ name: 'REA' })
  assert.match(out.text, /active \(in-flight\)/)
  assert.doesNotMatch(out.text, /ttl=0s/)
})
