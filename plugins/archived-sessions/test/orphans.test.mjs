import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteOrphans, inspectOrphans } from '../lib/index.js'

function orphanContext({ files, state = { archivedSessionIds: [], pinnedSessionIds: [] }, members = [], live = [] }) {
  const ctx = {
    workspaceRegistry: {
      enqueueOperation: fn => fn(),
      list: () => members.length ? [{ sessionIds: [...members], detachSession: async () => {}, mutate: async () => {} }] : [],
      requireState: () => state,
      setState: async value => { Object.assign(state, value) }
    },
    sessionPersistence: {},
    sessions: { get: id => live.includes(id) ? {} : undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => []
  }
  Object.defineProperty(ctx.workspaceRegistry, 'archivedSessionIds', { get: () => state.archivedSessionIds })
  return ctx
}

async function fixture(headers) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-orphan-test-'))
  const root = join(base, 'sessions'), project = join(root, 'project')
  const paths = new Map()
  for (const [id, header] of Object.entries(headers)) {
    const dir = join(project, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'v4.jsonl'), 'fixture')
    paths.set(id, join(dir, 'v4.jsonl'))
    header.id = id
  }
  const ctx = orphanContext({ files: paths })
  ctx.sessionPersistence = {
    root,
    findLog: async id => paths.has(id) ? { currentPath: paths.get(id) } : undefined,
    // Mirror the backend: a removed log disappears from the listing too.
    list: async () => {
      const listed = []
      for (const [id, header] of Object.entries(headers)) {
        try { await access(paths.get(id)) } catch { continue }
        listed.push({ header })
      }
      return listed
    },
    acquireLease: async () => ({ release: async () => {} })
  }
  ctx.workspaceRegistry.headers = new Map(Object.keys(headers).map(id => [id, headers[id]]))
  ctx.workspaceRegistry.sessionPaths = new Map(Object.keys(headers).map(id => [id, 'project']))
  ctx.workspaceRegistry.invalidSessionPaths = new Map()
  return { ctx, base, root, paths, dir: id => join(project, id) }
}

test('orphaned subagents are reported when their parent log is gone', async () => {
  const f = await fixture({
    'session-live-parent': { origin: undefined, parentSession: undefined },
    child: { origin: 'subagent', parentSession: 'session-live-parent' },
    orphan: { origin: 'subagent', parentSession: 'session-gone-forever' }
  })
  try {
    const report = await inspectOrphans(f.ctx)
    assert.deepEqual(report.orphans, [{ id: 'orphan', missingParent: 'session-gone-forever' }])
    assert.deepEqual(report.blocked, [])
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('a subagent whose parent is archived without a log is left to the archive cascade', async () => {
  const f = await fixture({
    child: { origin: 'subagent', parentSession: 'session-ghost-parent' }
  })
  try {
    // The archived parent has no log; its own delete cascades this child, so it is not an orphan.
    f.ctx.workspaceRegistry.setState = async value => { Object.assign(f.ctx.workspaceRegistry.requireState(), value) }
    const report = await inspectOrphans(f.ctx)
    assert.deepEqual(report.orphans.map(item => item.id), ['child'])
    f.ctx.workspaceRegistry.requireState().archivedSessionIds = ['session-ghost-parent']
    const second = await inspectOrphans(f.ctx)
    assert.deepEqual(second.orphans, [])
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('orphans attached to a workspace, archived themselves, or live are blocked', async () => {
  const f = await fixture({
    member: { origin: 'subagent', parentSession: 'gone-1' },
    archivedOrphan: { origin: 'subagent', parentSession: 'gone-2' },
    liveOrphan: { origin: 'subagent', parentSession: 'gone-3' }
  })
  try {
    f.ctx.workspaceRegistry.requireState().archivedSessionIds = ['archivedOrphan']
    f.ctx.workspaceRegistry.list = () => [{ sessionIds: ['member'], detachSession: async () => {}, mutate: async () => {} }]
    f.ctx.sessions.get = id => id === 'liveOrphan' ? {} : undefined
    const report = await inspectOrphans(f.ctx)
    assert.deepEqual(report.orphans, [])
    assert.deepEqual(report.blocked.map(item => item.id).sort(), ['archivedOrphan', 'liveOrphan', 'member'])
    await assert.rejects(deleteOrphans(f.ctx, ['member']), /\u4e0d\u80fd\u6e05\u7406/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('orphan deletion refuses ids that stopped being orphans', async () => {
  const f = await fixture({
    parent: {},
    child: { origin: 'subagent', parentSession: 'parent' }
  })
  try {
    // The page still has the old orphan list, but the parent's log exists again.
    await assert.rejects(deleteOrphans(f.ctx, ['child']), /\u5df2\u4e0d\u518d\u662f\u5b64\u513f/)
    assert.ok(f.paths.has('child'))
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('orphan deletion removes logs and reports counts', async () => {
  const f = await fixture({
    orphanA: { origin: 'subagent', parentSession: 'gone-1' },
    orphanB: { origin: 'subagent', parentSession: 'gone-2' }
  })
  try {
    const result = await deleteOrphans(f.ctx, ['orphanA', 'orphanB'])
    assert.equal(result.deleted, true)
    assert.equal(result.removed, 2)
    await assert.rejects(access(f.dir('orphanA')), { code: 'ENOENT' })
    await assert.rejects(access(f.dir('orphanB')), { code: 'ENOENT' })
    assert.equal((await inspectOrphans(f.ctx)).orphans.length, 0)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('orphan deletion of an empty list is a no-op', async () => {
  const f = await fixture({})
  try {
    assert.deepEqual(await deleteOrphans(f.ctx, []), { deleted: true, removed: 0, ghosts: 0 })
  } finally { await rm(f.base, { recursive: true, force: true }) }
})
