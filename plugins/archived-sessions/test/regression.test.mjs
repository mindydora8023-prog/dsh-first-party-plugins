/**
 * Regression tests for P0 fixes in archived-sessions host and client.
 *
 * Pure ASCII + LF only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  apply,
  deleteArchived,
  listRecycle,
  restoreRecycle,
  purgeExpiredRecycle,
} from '../lib/index.js'
import {
  MAX_PERSISTED_ITEMS,
  loadCleanup,
  saveCleanupConfig,
  saveLastRun,
  runAutoCleanup,
} from '../lib/cleanup.js'

const DAY = 24 * 60 * 60 * 1000

function makeRouteCaller(handler) {
  return async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = {
      host: '127.0.0.1:19387',
      origin: 'http://127.0.0.1:19387',
      'content-type': 'application/json',
      'x-archived-sessions-action': 'manage',
    }
    req.socket = { remoteAddress: '127.0.0.1' }
    let status
    let payload
    await handler(req, {
      writeHead: (code) => { status = code },
      end: (text) => { payload = JSON.parse(text) },
    })
    return { status, payload }
  }
}

test('recycle bin handles spaces, @, non-ASCII, and colon segments without rejecting valid paths', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-recycle-unicode-'))
  t.after(() => rm(base, { recursive: true, force: true }))

  const projectName = 'team @ \u9879\u76ee workspace'
  const sessionId = 'user@im.wechat \u4f1a\u8bdd'
  const root = join(base, 'sessions')
  const dir = join(root, projectName, sessionId)
  const log = join(dir, 'v4.jsonl')
  await mkdir(dir, { recursive: true })
  await writeFile(log, 'unicode-fixture')

  let state = { archivedSessionIds: [sessionId], pinnedSessionIds: [] }
  const ctx = {
    workspaceRegistry: {
      get archivedSessionIds() { return state.archivedSessionIds },
      headers: new Map([[sessionId, { id: sessionId }]]),
      sessionPaths: new Map([[sessionId, projectName]]),
      invalidSessionPaths: new Map(),
      list: () => [],
      requireState: () => state,
      setState: async (next) => { state = next },
      enqueueOperation: (fn) => fn(),
    },
    sessionPersistence: {
      root,
      findLog: async (value) => {
        if (value !== sessionId) return undefined
        try { await access(log) } catch { return undefined }
        return { currentPath: log }
      },
      list: async () => [],
      acquireLease: async () => ({ release: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    emit: () => {},
    logger: { warn() {} },
  }

  await deleteArchived(ctx, sessionId, { recycle: true })
  const listed = await listRecycle(ctx)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, sessionId)

  const restored = await restoreRecycle(ctx, sessionId)
  assert.equal(restored.restored, true)
  assert.equal(await readFile(log, 'utf8'), 'unicode-fixture')

  // Also verify colon segments (e.g. IM session ids on POSIX) are accepted by readRecycleRecords.
  const recycleRoot = join(base, 'sessions-recycle')
  const quarantine = join(base, 'sessions-deleted')
  await rm(quarantine, { recursive: true, force: true })
  const key = randomUUID()
  const sidecar = join(recycleRoot, `${key}.json`)
  await writeFile(sidecar, JSON.stringify({
    version: 2,
    id: 'im:weixin:dm:user@im.wechat',
    originalPath: join(root, projectName, 'im:weixin:dm:user@im.wechat'),
    isolatedPath: join(quarantine, key),
    removedAt: Date.now() - 1000,
    archived: true,
    pinned: false,
    workspaces: [],
  }))
  // Quarantine dir does not exist; days: 0 must purge the orphan sidecar immediately.
  const purged = await purgeExpiredRecycle(ctx, 0)
  assert.deepEqual(purged, { purged: 1 })
  assert.deepEqual(await readdir(recycleRoot), [])
})

test('recyclePurge route validates days explicitly, allows 0, and honors baseConfig.recycleDays', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-recycle-route-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'sessions')
  const recycleRoot = join(base, 'sessions-recycle')
  const quarantine = join(base, 'sessions-deleted')
  await mkdir(root, { recursive: true })
  await mkdir(recycleRoot, { recursive: true })
  await mkdir(quarantine, { recursive: true })

  const addSidecar = async (ageDays) => {
    const key = randomUUID()
    const isolated = join(quarantine, key)
    await mkdir(isolated, { recursive: true })
    await writeFile(join(recycleRoot, `${key}.json`), JSON.stringify({
      version: 2,
      id: `s-${key}`,
      originalPath: join(root, 'proj', `s-${key}`),
      isolatedPath: isolated,
      removedAt: Date.now() - ageDays * DAY,
      archived: true,
      pinned: false,
      workspaces: [],
    }))
  }

  let handler
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [], list: () => [], enqueueOperation: (fn) => fn() },
    sessionPersistence: { root, list: async () => [] },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    effect: (fn) => t.after(fn()),
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    logger: { warn() {} },
  }
  apply(ctx, { recycleDays: 3 })
  const call = makeRouteCaller(handler)

  // Invalid days values must return 400 (not silently coerce to 7).
  for (const badDays of [-1, 1.5, '3', null, 4000]) {
    const res = await call({ action: 'recyclePurge', days: badDays })
    assert.equal(res.status, 400, `expected 400 for days=${JSON.stringify(badDays)}`)
  }

  // Omitted days honors baseConfig.recycleDays (3): 4-day item purged, 1-day item kept.
  await addSidecar(4)
  await addSidecar(1)
  const defaultRes = await call({ action: 'recyclePurge' })
  assert.equal(defaultRes.status, 200)
  assert.equal(defaultRes.payload.purged, 1)

  // Explicit days: 0 purges remaining fresh item immediately.
  const zeroRes = await call({ action: 'recyclePurge', days: 0 })
  assert.equal(zeroRes.status, 200)
  assert.equal(zeroRes.payload.purged, 1)
  assert.deepEqual(await readdir(recycleRoot), [])
})

test('previewCleanup does not block or collide with an in-flight real cleanup sweep', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-preview-mutex-'))
  const file = join(base, 'cleanup.json')
  const prev = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = file
  t.after(async () => {
    if (prev === undefined) delete process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
    else process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = prev
    await rm(base, { recursive: true, force: true })
  })

  const root = join(base, 'sessions')
  const dir = join(root, 'proj', 'old-1')
  const log = join(dir, 'v4.jsonl')
  await mkdir(dir, { recursive: true })
  await writeFile(log, 'old')
  const oldTime = new Date(Date.now() - 10 * DAY)
  await utimes(log, oldTime, oldTime)

  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let state = { archivedSessionIds: ['old-1'], pinnedSessionIds: [] }
  let handler
  const ctx = {
    workspaceRegistry: {
      get archivedSessionIds() { return state.archivedSessionIds },
      headers: new Map([['old-1', { id: 'old-1', createdAt: oldTime.getTime() }]]),
      sessionPaths: new Map([['old-1', 'proj']]),
      invalidSessionPaths: new Map(),
      list: () => [],
      requireState: () => state,
      setState: async (next) => {
        started.resolve()
        await release.promise
        state = next
      },
      enqueueOperation: (fn) => fn(),
    },
    sessionPersistence: {
      root,
      findLog: async (id) => (id === 'old-1' ? { currentPath: log, header: { id: 'old-1', createdAt: oldTime.getTime() } } : undefined),
      list: async () => [],
      acquireLease: async () => ({ release: async () => {} }),
    },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    effect: (fn) => t.after(fn()),
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    logger: { warn() {} },
  }
  apply(ctx)
  const call = makeRouteCaller(handler)

  const running = call({ action: 'runCleanup' })
  await started.promise
  try {
    // A second real runCleanup is busy (409), while read-only previewCleanup succeeds (200).
    const concurrentRun = await call({ action: 'runCleanup' })
    assert.equal(concurrentRun.status, 409)

    const preview = await call({ action: 'previewCleanup' })
    assert.equal(preview.status, 200)
    assert.equal(preview.payload.ok, true)
    assert.equal(preview.payload.preview.eligible, 1)
  } finally {
    release.resolve()
    const finished = await running
    assert.equal(finished.status, 200)
  }
})

test('baseConfig.enabled: false takes effect until user explicitly saves cleanup config', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-baseconfig-enabled-'))
  const file = join(base, 'cleanup.json')
  const prev = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = file
  t.after(async () => {
    if (prev === undefined) delete process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
    else process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = prev
    await rm(base, { recursive: true, force: true })
  })

  let handler
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [], headers: new Map(), list: () => [], enqueueOperation: (fn) => fn() },
    sessionPersistence: { root: join(base, 'sessions'), list: async () => [] },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    effect: (fn) => t.after(fn()),
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    logger: { warn() {} },
  }
  apply(ctx, { enabled: false, days: 12 })
  const call = makeRouteCaller(handler)

  const initial = await call({ action: 'cleanupStatus' })
  assert.equal(initial.status, 200)
  assert.equal(initial.payload.cleanup.enabled, false)
  assert.equal(initial.payload.cleanup.days, 12)

  // Manual run writes lastRun, which must NOT overwrite baseConfig.enabled: false.
  const run = await call({ action: 'runCleanup' })
  assert.equal(run.status, 200)

  const afterRun = await call({ action: 'cleanupStatus' })
  assert.equal(afterRun.payload.cleanup.enabled, false)
  assert.equal(afterRun.payload.cleanup.days, 12)
  assert.notEqual(afterRun.payload.cleanup.lastRun, null)

  // Explicit user override takes precedence over baseConfig.enabled: false.
  const saved = await call({ action: 'setCleanup', enabled: true, days: 9 })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.payload.cleanup, { enabled: true, days: 9 })
})

test('saveLastRun caps deletedIds and failures so cleanup.json stays well under 256 KiB', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-lastrun-cap-'))
  const file = join(base, 'cleanup.json')
  t.after(() => rm(base, { recursive: true, force: true }))

  await saveCleanupConfig({ enabled: false, days: 14 }, file)
  const hugeIds = Array.from({ length: 1500 }, (_, i) => `session-very-long-identifier-${String(i).padStart(6, '0')}`)
  const hugeFailures = Array.from({ length: 800 }, (_, i) => ({
    id: `fail-${i}`,
    status: 500,
    message: 'x'.repeat(2000),
  }))

  await saveLastRun({
    at: Date.now(),
    scanned: 2300,
    deleted: 1500,
    deletedIds: hugeIds,
    failures: hugeFailures,
  }, file)

  const info = await stat(file)
  assert.ok(info.size < 256 * 1024, `expected cleanup.json < 256 KiB, got ${info.size}`)

  const reloaded = await loadCleanup(file)
  assert.deepEqual(reloaded.config, { enabled: false, days: 14 })
  assert.equal(reloaded.lastRun.deletedIds.length, MAX_PERSISTED_ITEMS)
  assert.equal(reloaded.lastRun.deletedIdsTotal, 1500)
  assert.equal(reloaded.lastRun.failures.length, MAX_PERSISTED_ITEMS)
  assert.equal(reloaded.lastRun.failuresTotal, 800)
  assert.ok(reloaded.lastRun.failures[0].message.length <= 500)
})

test('HTTP 504 timeout response preserves effectState and retry fields', async (t) => {
  let handler
  const timeoutErr = Object.assign(new Error('delete timed out'), {
    status: 504,
    effectState: 'unknown',
    retry: 'never',
  })
  const ctx = {
    workspaceRegistry: {
      archivedSessionIds: ['session-a'],
      enqueueOperation: () => Promise.reject(timeoutErr),
    },
    sessionPersistence: { root: 'unused', findLog() {}, acquireLease() {}, list: async () => [] },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
    waterfall: async () => [],
    effect: (fn) => t.after(fn()),
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    logger: { warn() {} },
  }
  apply(ctx)
  const call = makeRouteCaller(handler)

  const res = await call({ action: 'delete', sessionId: 'session-a' })
  assert.equal(res.status, 504)
  assert.equal(res.payload.ok, false)
  assert.equal(res.payload.effectState, 'unknown')
  assert.equal(res.payload.retry, 'never')
})

test('AbortSignal stops runAutoCleanup mid-sweep without deleting remaining sessions', async () => {
  const now = Date.now()
  const oldStamp = now - 10 * DAY
  const controller = new AbortController()
  const ctx = {
    workspaceRegistry: {
      archivedSessionIds: ['s1', 's2', 's3'],
      headers: new Map([
        ['s1', { id: 's1', createdAt: oldStamp }],
        ['s2', { id: 's2', createdAt: oldStamp }],
        ['s3', { id: 's3', createdAt: oldStamp }],
      ]),
    },
    sessionPersistence: { list: async () => [] },
    sessions: { get: () => undefined, list: () => [] },
    get: () => undefined,
  }
  const deleted = []
  const report = await runAutoCleanup(ctx, {
    now,
    days: 5,
    signal: controller.signal,
    deleteOne: async (id) => {
      deleted.push(id)
      controller.abort()
      return { removed: 1, children: 0, ghosts: 0 }
    },
  })
  assert.deepEqual(deleted, ['s1'])
  assert.equal(report.deleted, 1)
  assert.equal(report.aborted, true)
})

test('client act() clears state on warning and distinguishes loading cleanup from disabled', async () => {
  let plugin
  let render
  let cursor = 0
  const state = []
  const effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useEffect: (fn) => { effects.push(fn) },
    useState: (initial) => {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], (val) => { state[i] = typeof val === 'function' ? val(state[i]) : val }]
    },
    useSyncExternalStore: (_sub, snapshot) => snapshot(),
  }

  const fetchCalls = []
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    fetchCalls.push(body.action)
    if (body.action === 'inspect') {
      return { ok: true, json: async () => ({ ok: true, items: [{ id: 'a', archived: true, hasLog: true, children: [], blocked: [] }] }) }
    }
    if (body.action === 'delete') {
      return { ok: true, json: async () => ({ ok: true, deleted: true, removed: 1, warning: 'quarantine cleanup warning' }) }
    }
    if (body.action === 'previewCleanup') {
      return { ok: true, json: async () => ({ ok: true, preview: { days: 5, scanned: 1, eligible: 0, ids: [] } }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  }

  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    fetch: mockFetch,
    window: { __ModuleLoader__: { load: (value) => { plugin = value.factory(() => React) } } },
  })

  let refreshed = 0
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { a: { id: 'a', title: 'Alpha' } } }) }, refresh: async () => { refreshed += 1 } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: ['a'] }) } },
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_slot, fn) => fn(), register: (_meta, component) => { render = component; return () => {} } },
  }
  plugin.apply(ctx)

  const flatten = (node) => (!node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(flatten)])
  const nodes = () => { cursor = 0; const el = render(); return flatten(el.type(el.props)) }

  // Open cleanup settings while cleanup is still null (loading): must NOT show cleanupOff.
  nodes().find((n) => n.type === 'button' && n.children.includes('cleanupSettings')).props.onClick()
  assert.equal(nodes().some((n) => n.children?.includes('cleanupOff')), false)

  // Once cleanup is explicitly disabled, cleanupOff MUST appear.
  state[8] = { enabled: false, days: 5, lastRun: null }
  assert.equal(nodes().some((n) => n.children?.includes('cleanupOff')), true)

  // Select 'a', open delete confirm, trigger delete returning a warning: confirm & selection must clear.
  nodes().find((n) => n.type === 'input' && n.props['aria-label'] === 'select: Alpha').props.onChange()
  assert.deepEqual(Array.from(state[4]), ['a'])
  await nodes().find((n) => n.type === 'button' && n.children.includes('delete')).props.onClick()
  assert.equal(state[2], 'a')
  await nodes().find((n) => n.type === 'button' && n.children.includes('confirm')).props.onClick()

  assert.deepEqual(Array.from(state[4]), [])
  assert.equal(state[2], null)
  assert.equal(state[6], null)
  assert.equal(state[3].error, true)
  assert.match(state[3].text, /quarantine cleanup warning/)
  assert.equal(refreshed, 1)
  assert.ok(fetchCalls.includes('previewCleanup'))
})
