/**
 * listArchivedInventory: read-only archived-list export.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { listArchivedInventory } from '../lib/index.js'

function makeCtx(ids, headers) {
  return {
    workspaceRegistry: { archivedSessionIds: ids, list: () => [] },
    sessionPersistence: { list: async () => headers.map((header) => ({ header })), findLog: async () => undefined },
    sessions: { list: () => [], get: () => undefined },
    get: () => undefined,
    waterfall: async () => [],
    emit: () => {},
    logger: { warn() {} },
  }
}

test('inventory reports every archived id without mutating anything', async () => {
  const ctx = makeCtx(['a', 'b'], [{ id: 'b' }])
  const out = await listArchivedInventory(ctx)
  assert.equal(out.total, 2)
  assert.equal(out.shown, 2)
  const byId = Object.fromEntries(out.items.map((item) => [item.id, item]))
  assert.equal(byId.b.archived, true)
  assert.equal(byId.b.hasLog, false)
  assert.equal(byId.a.archived, true)
  assert.equal(byId.a.hasLog, false)
  // Nothing about registry state changed.
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['a', 'b'])
})

test('inventory caps at 500 ids but reports the true total', async () => {
  const ids = Array.from({ length: 620 }, (_, index) => 's' + index)
  const ctx = makeCtx(ids, [])
  const out = await listArchivedInventory(ctx)
  assert.equal(out.total, 620)
  assert.equal(out.shown, 500)
  assert.equal(out.items.length, 500)
})
