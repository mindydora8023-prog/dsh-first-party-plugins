import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { apply, deleteArchived, listRecycle, restoreRecycle, purgeExpiredRecycle } from '../lib/index.js'

const id = 'session-a'
const memberIds = ['before', id, 'after']
const remainingIds = ['before', 'after']
const later = () => Date.now() + 8 * 24 * 60 * 60 * 1000

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-recycle-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'sessions'), dir = join(root, 'project', id)
  const recycleRoot = join(base, 'sessions-recycle'), quarantine = join(base, 'sessions-deleted')
  const log = join(dir, 'v4.jsonl')
  await mkdir(dir, { recursive: true })
  await writeFile(log, 'fixture-only')
  const initialState = { archivedSessionIds: [id], pinnedSessionIds: [id] }
  let state = initialState, tail = Promise.resolve(), handler
  const workspace = {
    sessionIds: [...memberIds],
    detachSession: async (value) => { workspace.sessionIds = workspace.sessionIds.filter(candidate => candidate !== value) },
    mutate: async (fn) => { workspace.sessionIds = fn({ sessionIds: workspace.sessionIds }).sessionIds },
  }
  const registry = {
    get archivedSessionIds() { return state.archivedSessionIds },
    headers: new Map([[id, { id }]]),
    sessionPaths: new Map([[id, 'project']]),
    invalidSessionPaths: new Map([[id, 'fixture-invalid-path']]),
    list: () => [{ sessionIds: [] }, workspace],
    requireState: () => state,
    setState: async (value) => { state = value },
    enqueueOperation(fn) {
      const next = tail.then(fn)
      tail = next.catch(() => {})
      return next
    },
  }
  const removed = []
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: {
      root,
      findLog: async (value) => {
        if (value !== id) return
        try { await access(log) }
        catch (error) { if (error.code === 'ENOENT') return; throw error }
        return { currentPath: log }
      },
      list: async () => [],
      acquireLease: async () => ({ release: async () => {} }),
      open: async () => 'opened',
    },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    emit: (_event, value) => removed.push(value),
    logger: { warn() {} },
    effect(fn) { t.after(fn()) },
    webServer: { register: route => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
  }
  apply(ctx)
  const route = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'x-archived-sessions-action': 'manage', 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    let status, payload
    await handler(req, { writeHead: value => { status = value }, end: value => { payload = JSON.parse(value) } })
    return { status, ...payload }
  }
  return { ctx, registry, base, dir, log, recycleRoot, quarantine, workspace, removed, initialState, route }
}

async function readSidecar(f) {
  const [name] = await readdir(f.recycleRoot)
  const path = join(f.recycleRoot, name)
  return { path, record: JSON.parse(await readFile(path, 'utf8')) }
}

function assertRestoredMetadata(f) {
  assert.deepEqual(f.workspace.sessionIds, memberIds)
  assert.deepEqual(f.registry.requireState(), f.initialState)
  assert.deepEqual(f.registry.headers.get(id), { id })
  assert.equal(f.registry.sessionPaths.get(id), 'project')
  assert.equal(f.registry.invalidSessionPaths.get(id), 'fixture-invalid-path')
}

function assertRemovedMetadata(f) {
  assert.deepEqual(f.workspace.sessionIds, remainingIds)
  assert.deepEqual(f.registry.requireState(), { archivedSessionIds: [], pinnedSessionIds: [] })
  assert.equal(f.registry.headers.has(id), false)
  assert.equal(f.registry.sessionPaths.has(id), false)
  assert.equal(f.registry.invalidSessionPaths.has(id), false)
}

test('routes recycle, restore, then permanently delete the same session', async t => {
  const f = await fixture(t)
  assert.equal((await f.route({ action: 'delete', sessionId: id, recycle: true })).status, 200)
  await assert.rejects(access(f.dir), { code: 'ENOENT' })
  assertRemovedMetadata(f)
  const [item] = (await f.route({ action: 'recycleList' })).items
  const { record } = await readSidecar(f)
  assert.equal(item.id, id)
  assert.equal(item.recycleId, basename(record.isolatedPath) + '.json')
  assert.equal(await readFile(join(record.isolatedPath, 'v4.jsonl'), 'utf8'), 'fixture-only')

  assert.deepEqual(await f.route({ action: 'recycleRestore', sessionId: id }), { status: 200, ok: true, restored: true, id, archived: true })
  assert.equal(await readFile(f.log, 'utf8'), 'fixture-only')
  assertRestoredMetadata(f)
  assert.deepEqual(await readdir(f.recycleRoot), [])

  assert.deepEqual(await f.route({ action: 'delete', sessionId: id }), { status: 200, ok: true, deleted: true, removed: 1, children: 0, ghosts: 0 })
  await assert.rejects(access(f.dir), { code: 'ENOENT' })
  assertRemovedMetadata(f)
  assert.deepEqual(await readdir(f.recycleRoot), [])
  assert.deepEqual(await readdir(f.quarantine), [])
  assert.deepEqual(f.removed, [id, id])
})

test('a snapshot write failure leaves the log and all metadata in place', async t => {
  const f = await fixture(t)
  const header = f.registry.headers.get(id)
  header.cycle = header
  await assert.rejects(deleteArchived(f.ctx, id, { recycle: true }), /circular structure/)
  delete header.cycle
  assert.equal(await readFile(f.log, 'utf8'), 'fixture-only')
  assertRestoredMetadata(f)
  assert.deepEqual(f.removed, [])
  assert.deepEqual(await readdir(f.recycleRoot), [])
  assert.deepEqual(await readdir(f.quarantine), [])
})

test('a failing metadata commit sees the existing snapshot and rolls back a partial state write', async t => {
  const f = await fixture(t)
  const setState = f.registry.setState
  let calls = 0
  let observed
  f.registry.setState = async value => {
    if (++calls === 1) observed = await readSidecar(f)
    await setState(value)
    if (calls === 1) throw new Error('metadata failed after the write')
  }
  await assert.rejects(deleteArchived(f.ctx, id, { recycle: true }), /metadata failed after the write/)
  assert.deepEqual(observed.record.workspaces, [{ key: 'index:1', sessionIds: memberIds }])
  assert.equal(calls, 2)
  assert.equal(await readFile(f.log, 'utf8'), 'fixture-only')
  assertRestoredMetadata(f)
  assert.deepEqual(f.removed, [])
  assert.deepEqual(await readdir(f.recycleRoot), [])
  assert.deepEqual(await readdir(f.quarantine), [])
})

test('a detach that changes membership before throwing is rolled back', async t => {
  const f = await fixture(t)
  const detach = f.workspace.detachSession
  f.workspace.detachSession = async value => { await detach(value); throw new Error('detach failed') }
  await assert.rejects(deleteArchived(f.ctx, id, { recycle: true }), /detach failed/)
  assertRestoredMetadata(f)
  assert.equal(await readFile(f.log, 'utf8'), 'fixture-only')
  assert.deepEqual(await readdir(f.recycleRoot), [])
  assert.deepEqual(await readdir(f.quarantine), [])
})

test('a partially applied restore rolls back files, workspace, maps and flags and can be retried', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  const { record } = await readSidecar(f)
  const previousHeader = { id, old: true }
  f.registry.headers.set(id, previousHeader)
  const setState = f.registry.setState
  let calls = 0
  f.registry.setState = async value => {
    await setState(value)
    if (++calls === 1) throw new Error('restore state failed after the write')
  }
  await assert.rejects(restoreRecycle(f.ctx, id), /restore state failed after the write/)
  await assert.rejects(access(f.dir), { code: 'ENOENT' })
  assert.equal(await readFile(join(record.isolatedPath, 'v4.jsonl'), 'utf8'), 'fixture-only')
  assert.deepEqual(f.workspace.sessionIds, remainingIds)
  assert.deepEqual(f.registry.requireState(), { archivedSessionIds: [], pinnedSessionIds: [] })
  assert.equal(f.registry.headers.get(id), previousHeader)
  assert.equal(f.registry.sessionPaths.has(id), false)
  assert.equal(f.registry.invalidSessionPaths.has(id), false)
  assert.equal((await listRecycle(f.ctx)).length, 1)
  assert.equal((await restoreRecycle(f.ctx, id)).restored, true)
  assertRestoredMetadata(f)
})

test('restore holds the registry queue and writer fence through sidecar consumption', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  const started = Promise.withResolvers(), finish = Promise.withResolvers()
  const setState = f.registry.setState
  f.registry.setState = async value => { started.resolve(); await finish.promise; await setState(value) }
  const restoring = f.route({ action: 'recycleRestore', sessionId: id })
  // A failed restore must also unblock the test if it never reaches setState.
  await Promise.race([started.promise, restoring])
  let purgeFinished = false
  const purging = purgeExpiredRecycle(f.ctx, 7, later()).then(value => { purgeFinished = true; return value })
  try {
    await assert.rejects(f.ctx.sessionPersistence.open(id), { status: 409 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(purgeFinished, false)
    assert.equal((await readdir(f.recycleRoot)).length, 1)
  } finally {
    finish.resolve()
    await Promise.allSettled([restoring, purging])
  }
  assert.equal((await restoring).status, 200)
  assert.deepEqual(await purging, { purged: 0 })
  assert.equal(await f.ctx.sessionPersistence.open(id), 'opened')
  assertRestoredMetadata(f)
})

test('expired recycle purge removes both owned records and logs', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  assert.deepEqual(await purgeExpiredRecycle(f.ctx, 7, later()), { purged: 1 })
  assert.deepEqual(await readdir(f.recycleRoot), [])
  assert.deepEqual(await readdir(f.quarantine), [])
})

test('purge and restore skip sidecars pointing outside quarantine or at another slot', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  const { path, record } = await readSidecar(f)
  const other = join(f.quarantine, randomUUID()), outside = join(f.base, randomUUID())
  for (const target of [other, outside]) {
    await mkdir(target)
    await writeFile(join(target, 'marker'), 'keep')
    await writeFile(path, JSON.stringify({ ...record, isolatedPath: target }))
    assert.deepEqual(await purgeExpiredRecycle(f.ctx, 7, later()), { purged: 0 })
    await assert.rejects(restoreRecycle(f.ctx, id), { status: 404 })
    assert.equal(await readFile(join(target, 'marker'), 'utf8'), 'keep')
  }
  assert.equal(await readFile(join(record.isolatedPath, 'v4.jsonl'), 'utf8'), 'fixture-only')
})

test('junctions are rejected at the quarantine slot and the restore project', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  const { record } = await readSidecar(f)
  const outside = join(f.base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'marker'), 'keep')
  const moved = join(f.base, 'moved-fixture')
  await rename(record.isolatedPath, moved)
  await symlink(outside, record.isolatedPath, 'junction')
  assert.deepEqual(await purgeExpiredRecycle(f.ctx, 7, later()), { purged: 0 })
  await assert.rejects(restoreRecycle(f.ctx, id), { status: 404 })
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'keep')
  await rm(record.isolatedPath)
  await rename(moved, record.isolatedPath)

  const project = dirname(f.dir)
  await rm(project, { recursive: true })
  await symlink(outside, project, 'junction')
  await assert.rejects(restoreRecycle(f.ctx, id), { status: 409 })
  await assert.rejects(access(join(outside, id)), { code: 'ENOENT' })
  assert.equal(await readFile(join(record.isolatedPath, 'v4.jsonl'), 'utf8'), 'fixture-only')
})

test('version 1 sidecars retain access to their legacy quarantine slot', async t => {
  const f = await fixture(t)
  await deleteArchived(f.ctx, id, { recycle: true })
  const { path, record } = await readSidecar(f)
  await writeFile(join(f.recycleRoot, randomUUID() + '.json'), JSON.stringify({ ...record, version: 1 }))
  await rm(path)
  assert.equal((await restoreRecycle(f.ctx, id)).restored, true)
  assertRestoredMetadata(f)
})
