/**
 * Auto-cleanup contract tests.
 *
 * These drive the pure helpers and one full sweep against real temp files, so the
 * age decision (log mtime vs header createdAt), the skip rules and the error
 * isolation are all exercised without touching the user's real sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { readFile, mkdtemp, writeFile, utimes, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { normalizeCleanup, loadCleanup, saveCleanupConfig, saveLastRun, runAutoCleanup, DEFAULT_CLEANUP } from '../lib/cleanup.js'
import { apply } from '../lib/index.js'

const DAY = 24 * 60 * 60 * 1000

function cleanupFileFor(base) {
  return join(base, 'cleanup.json')
}

function contextOf(archived, entries) {
  return {
    workspaceRegistry: {
      archivedSessionIds: archived,
      headers: new Map(Object.entries(entries).map(([id, entry]) => [id, entry.header])),
    },
    sessionPersistence: {
      list: async () => Object.entries(entries)
        .filter(([, entry]) => typeof entry.path === 'string')
        .map(([id, entry]) => ({ header: entry.header, location: { kind: 'jsonl', path: entry.path } })),
    },
    sessions: { get: id => entries[id]?.live ? {} : undefined, list: () => [] },
    get: () => undefined,
  }
}

async function agesFixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cleanup-test-'))
  const now = Date.now()
  const oldPath = join(base, 'old.jsonl')
  const newPath = join(base, 'new.jsonl')
  await writeFile(oldPath, 'old')
  await writeFile(newPath, 'new')
  await utimes(oldPath, new Date(now - 10 * DAY), new Date(now - 10 * DAY))
  await utimes(newPath, new Date(now - 1 * DAY), new Date(now - 1 * DAY))
  const entries = {
    old: { header: { id: 'old', createdAt: now - 10 * DAY }, path: oldPath },
    recent: { header: { id: 'recent', createdAt: now - 10 * DAY }, path: newPath },
    live: { header: { id: 'live', createdAt: now - 10 * DAY }, path: newPath, live: true },
    'ghost-old': { header: { id: 'ghost-old', createdAt: now - 10 * DAY } },
    'ghost-unknown': { header: { id: 'ghost-unknown' } },
  }
  return { base, now, entries }
}

test('normalizeCleanup applies defaults and clamps days', () => {
  assert.deepEqual(normalizeCleanup(undefined), { enabled: DEFAULT_CLEANUP.enabled, days: DEFAULT_CLEANUP.days })
  assert.deepEqual(normalizeCleanup({ enabled: false, days: 7 }), { enabled: false, days: 7 })
  assert.deepEqual(normalizeCleanup({ enabled: true, days: 0 }), { enabled: true, days: 1 })
  assert.deepEqual(normalizeCleanup({ enabled: true, days: 99999 }), { enabled: true, days: 3650 })
  assert.deepEqual(normalizeCleanup({ enabled: 'yes', days: '3' }), { enabled: true, days: 3 })
})

test('a sweep deletes old sessions and skips live, recent and unknown-age ones', async () => {
  const f = await agesFixture()
  try {
    const ctx = contextOf(['old', 'recent', 'live', 'ghost-old', 'ghost-unknown'], f.entries)
    const deleted = []
    const report = await runAutoCleanup(ctx, {
      now: f.now, days: 5,
      deleteOne: async id => { deleted.push(id); return { removed: 1, children: 0, ghosts: 0 } },
    })
    assert.equal(report.scanned, 5)
    assert.equal(report.live, 1)
    assert.equal(report.recent, 1)
    assert.equal(report.unknownAge, 1)
    assert.equal(report.eligible, 2)
    assert.equal(report.deleted, 2)
    assert.deepEqual(deleted.sort(), ['ghost-old', 'old'])
    assert.deepEqual(report.deletedIds.sort(), ['ghost-old', 'old'])
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('one failing deletion does not abort the rest of the sweep', async () => {
  const f = await agesFixture()
  try {
    const ctx = contextOf(['old', 'ghost-old'], f.entries)
    const seen = []
    const report = await runAutoCleanup(ctx, {
      now: f.now, days: 5,
      deleteOne: async id => {
        seen.push(id)
        if (id === 'old') throw Object.assign(new Error('blocked'), { status: 409 })
        return { removed: 1, children: 2, ghosts: 0 }
      },
    })
    assert.deepEqual(seen.sort(), ['ghost-old', 'old'])
    assert.equal(report.blocked, 1)
    assert.equal(report.errors, 0)
    assert.equal(report.deleted, 1)
    assert.equal(report.children, 2)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('dry run reports eligible ids without deleting', async () => {
  const f = await agesFixture()
  try {
    const ctx = contextOf(['old', 'recent'], f.entries)
    let called = false
    const report = await runAutoCleanup(ctx, { now: f.now, days: 5, dryRun: true, deleteOne: async () => { called = true; return {} } })
    assert.equal(called, false)
    assert.equal(report.deleted, 0)
    assert.deepEqual(report.deletedIds, ['old'])
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('cleanup state persists config and lastRun outside the source tree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cleanup-state-'))
  const file = cleanupFileFor(base)
  const previous = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = file
  try {
    const fresh = await loadCleanup()
    assert.deepEqual(fresh.config, { enabled: DEFAULT_CLEANUP.enabled, days: DEFAULT_CLEANUP.days })
    assert.equal(fresh.lastRun, null)

    const saved = await saveCleanupConfig({ enabled: false, days: 7 })
    assert.deepEqual(saved, { enabled: false, days: 7 })
    await saveLastRun({ at: 123, scanned: 9, deleted: 2 })
    const reread = await loadCleanup()
    assert.deepEqual(reread.config, { enabled: false, days: 7 })
    assert.equal(reread.lastRun.deleted, 2)
    assert.equal(reread.lastRun.at, 123)
  } finally {
    if (previous === undefined) delete process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
    else process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('concurrent config and lastRun writes do not lose each other', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cleanup-race-'))
  const file = cleanupFileFor(base)
  const previous = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = file
  try {
    // A background sweep (saveLastRun) and a settings change (saveCleanupConfig)
    // can land together; without a per-file write lock the later one clobbers the
    // other's field. Exercise several interleaved rounds.
    for (let round = 0; round < 5; round += 1) {
      await Promise.all([
        saveCleanupConfig({ enabled: true, days: 4 + (round % 3) }, file),
        saveLastRun({ at: 100 + round, scanned: round, deleted: round }, file),
        saveCleanupConfig({ enabled: true, days: 4 + ((round + 1) % 3) }, file),
      ])
    }
    const final = await loadCleanup(file)
    assert.equal(typeof final.config.days, 'number')
    assert.ok(final.config.days >= 1)
    assert.notEqual(final.lastRun, null, 'a concurrent config write must not drop lastRun')
    assert.equal(typeof final.lastRun.at, 'number')
  } finally {
    if (previous === undefined) delete process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
    else process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('cleanup endpoints report, save settings and run a sweep', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cleanup-route-'))
  const previous = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = cleanupFileFor(base)
  try {
    const ctx = {
      workspaceRegistry: { archivedSessionIds: [], headers: new Map(), list: () => [], enqueueOperation: fn => fn() },
      sessionPersistence: { list: async () => [] },
      sessions: { get: () => undefined, list: () => [] },
      get: () => undefined,
      waterfall: async () => [],
      effect: fn => fn(),
      webServer: { register: route => { ctx._handler = route.handler; return () => {} } },
      connection: { requestRejection: () => undefined },
      logger: { warn() {} },
    }
    // Capture the handler through apply.
    let handler
    apply(ctx)
    handler = ctx._handler
    const call = async body => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))])
      req.method = 'POST'
      req.headers = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json', 'x-archived-sessions-action': 'manage' }
      req.socket = { remoteAddress: '127.0.0.1' }
      let status, result
      await handler(req, { writeHead: code => { status = code }, end: text => { result = JSON.parse(text) } })
      return { status, result }
    }
    const status = await call({ action: 'cleanupStatus' })
    assert.equal(status.status, 200)
    assert.equal(status.result.cleanup.enabled, true)
    assert.equal(status.result.cleanup.days, 5)

    const bad = await call({ action: 'setCleanup', enabled: true, days: 0 })
    assert.equal(bad.status, 400)

    const saved = await call({ action: 'setCleanup', enabled: false, days: 8 })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.result.cleanup, { enabled: false, days: 8 })

    const run = await call({ action: 'runCleanup' })
    assert.equal(run.status, 200)
    assert.equal(run.result.report.scanned, 0)
    assert.equal(run.result.report.deleted, 0)
  } finally {
    if (previous === undefined) delete process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
    else process.env['ARCHIVED_SESSIONS_CLEANUP_FILE'] = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('settings page renders the automatic cleanup panel', async () => {
  let plugin, render
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useMemo: fn => fn(), useState: value => [value, () => {}], useRef: value => ({ current: value }),
    useEffect: () => {}, useSyncExternalStore: () => ({ phase: 'ready', byId: {}, archivedSessionIds: [] }),
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { plugin = value.factory(() => React) } } } })
  const ctx = {
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
    workspaces: { list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }) } },
    effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (slot, fn) => fn(), register: (meta, component) => { render = component; return () => {} } },
  }
  plugin.apply(ctx)
  const element = render()
  const page = element.type(element.props)
  const flat = []
  const walk = node => { if (!node || typeof node !== 'object') return; flat.push(node); for (const child of node.children ?? []) walk(child) }
  walk(page)
  const text = JSON.stringify(flat)
  assert.match(text, /cleanupTitle/)
  assert.match(text, /cleanupNow/)
})

