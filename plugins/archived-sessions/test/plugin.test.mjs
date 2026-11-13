import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { readFile, mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteArchived, deleteOrphans, inspectArchived, inspectOrphans, apply } from '../lib/index.js'
import { reason } from '../lib/reasons.js'

/**
 * Escape a catalogue string for use inside a RegExp.
 *
 * Assertions name a KEY, not a literal: the text lives in lib/reasons.js as
 * escapes, and this file must stay ASCII. Matching the catalogue output also
 * keeps the assertion honest -- it verifies what the user is actually shown.
 */
function reasonRegex(key) {
  return new RegExp(reason(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/**
 * Match a stable FRAGMENT of a catalogue entry.
 *
 * Composite entries ("{count} children still reference...") contain placeholders
 * and can never be matched verbatim. This takes the text before the first
 * placeholder, which is the part a user always sees, and escapes it for RegExp.
 */
function reasonFragment(key) {
  const header = reason(key).split('{')[0]
  return new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

function context() {
  const ctx = { workspaceRegistry: { archivedSessionIds: ['session-a'], enqueueOperation: fn => fn() }, sessionPersistence: { root: 'unused', findLog() {}, acquireLease() {}, list: async () => [] }, sessions: { get: () => undefined, list: () => [] }, get: () => undefined, waterfall: async () => [], emitted: [] }
  // Record host events the plugin emits; deletion must announce api-session/removed.
  ctx.emit = (name, ...args) => { ctx.emitted.push({ name, args }) }
  return ctx
}

/** Ids named by every api-session/removed notification, in emit order. */
function removedIds(ctx) {
  return ctx.emitted.filter(event => event.name === 'api-session/removed').map(event => event.args[0])
}
test('refuses unarchived sessions without locating files', async () => {
  const ctx = context(); await assert.rejects(deleteArchived(ctx, 'other'), reasonRegex('not-archived'))
})
test('refuses live sessions without locating files', async () => {
  const ctx = context(); ctx.sessions.get = () => ({})
  await assert.rejects(deleteArchived(ctx, 'session-a'), reasonRegex('session-live'))
})
test('refuses referenced sessions until the cascade is explicit', async () => {
  const ctx = context(); ctx.sessionPersistence.list = async () => [{ header: { id: 'child', parentSession: 'session-a', origin: 'subagent' } }]
  await assert.rejects(deleteArchived(ctx, 'session-a'), reasonFragment('refuse-referenced', 0))
})
test('cascades hidden subagents below the archived parent', async () => {
  const ctx = context()
  ctx.sessionPersistence.list = async () => [
    { header: { id: 'child-1', parentSession: 'session-a', origin: 'subagent' } },
    { header: { id: 'grandchild', parentSession: 'child-1', origin: 'subagent' } },
    { header: { id: 'unrelated', parentSession: 'session-z', origin: 'subagent' } }
  ]
  const plan = await inspectArchived(ctx, ['session-a'])
  assert.deepEqual(plan[0].children, ['child-1', 'grandchild'])
  assert.equal(plan[0].hasLog, false)
})
test('refuses branches, workspace members and archived descendants inside a cascade', async () => {
  const ctx = context()
  ctx.sessionPersistence.list = async () => [
    { header: { id: 'branch', parentSession: 'session-a' } },
    { header: { id: 'member', parentSession: 'session-a', origin: 'subagent' } },
    { header: { id: 'archived-child', parentSession: 'session-a', origin: 'subagent' } }
  ]
  ctx.workspaceRegistry.list = () => [{ sessionIds: ['member'], detachSession: async () => {}, mutate: async () => {} }]
  ctx.workspaceRegistry.archivedSessionIds = ['session-a', 'archived-child']
  const plan = await inspectArchived(ctx, ['session-a'])
  assert.deepEqual(plan[0].children, [])
  assert.equal(plan[0].blocked.length, 3)
  await assert.rejects(deleteArchived(ctx, 'session-a', { cascade: true }), reasonFragment('refuse-children', 0))
})
test('refuses live descendants inside a cascade', async () => {
  const ctx = context()
  ctx.sessionPersistence.list = async () => [{ header: { id: 'busy', parentSession: 'session-a', origin: 'subagent' } }]
  ctx.get = () => new Map([['busy', {}]])
  await assert.rejects(deleteArchived(ctx, 'session-a', { cascade: true }), reasonFragment('refuse-children', 0))
})
test('reference refusal identifies hidden subagents and deduplicates live snapshots', async () => {
  const ctx = context()
  const child = { header: { id: 'child-agent', parentSession: 'session-a', origin: 'subagent' } }
  ctx.sessionPersistence.list = async () => [child]
  ctx.sessions.list = () => [child]
  await assert.rejects(deleteArchived(ctx, 'session-a'), error => {
    assert.match(error.message, reasonFragment('refuse-referenced', 0))
    assert.match(error.message, /child-agent/)
    assert.match(error.message, reasonFragment('refuse-referenced', 1))
    return true
  })
})
test('refuses active work', async () => {
  const ctx = context(); ctx.waterfall = async () => ['job']
  await assert.rejects(deleteArchived(ctx, 'session-a'), reasonRegex('session-activity'))
})
test('refuses unsupported persistence backends', async () => {
  const ctx = context(); ctx.sessionPersistence = {}
  await assert.rejects(deleteArchived(ctx, 'session-a'), reasonRegex('backend-unsupported'))
})
test('bundle patch inserts a new plugin instead of overriding a missing id', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^- insert:\s*\n\s+- id: archived-sessions/)
})
test('client registers the settings page with correct module id', async () => {
  let module, registration
  const sandbox = { window: { __ModuleLoader__: { load: value => { assert.equal(value.id, 'dsh-plugin-archived-sessions'); module = value.factory(() => ({ createElement() {} })) } } } }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  module.apply({ effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key }, slots: { inject: (slot, fn) => fn(), register: metadata => { registration = metadata; return () => {} } } })
  assert.equal(registration.name, 'settings.section'); assert.equal(registration.id, 'archived-sessions')
})
test('settings page renders with receiver-dependent host stores', async () => {
  let plugin, render
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useMemo: fn => fn(), useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect: () => {},
    useSyncExternalStore: (subscribe, snapshot) => { const off = subscribe(() => {}); off(); return snapshot() }
  }
  const sandbox = { window: { __ModuleLoader__: { load: value => { plugin = value.factory(() => React) } } } }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  const store = data => ({ data, listeners: new Set(), subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }, getSnapshot() { return this.data } })
  const ctx = { sessions: { list: store({ phase: 'ready', byId: {} }) }, workspaces: { list: store({ phase: 'ready', archivedSessionIds: [] }) }, effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key }, slots: { inject: (slot, fn) => fn(), register: (meta, component) => { render = component; return () => {} } } }
  plugin.apply(ctx)
  const element = render(), page = element.type(element.props)
  assert.equal(page.type, 'section')
  assert.match(JSON.stringify(page), /empty/)
})
test('bulk restore handles partial failure and retains failed selection', async () => {
  let plugin, render, cursor = 0
  const state = [], calls = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useMemo: fn => fn(), useRef: value => ({ current: value }), useEffect: () => {}, useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] }, useSyncExternalStore: (subscribe, snapshot) => snapshot() }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { plugin = value.factory(() => React) } } } })
  const ctx = { sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { a: { id: 'a' }, b: { id: 'b' } } }) }, refresh: async () => {} }, workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ['a', 'b'] }) }, unarchiveSession: async id => { calls.push(id); if (id === 'b') throw Error('fixture failure') } }, effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key }, slots: { inject: (slot, fn) => fn(), register: (meta, component) => { render = component; return () => {} } } }
  plugin.apply(ctx)
  const page = () => { cursor = 0; const element = render(); return element.type(element.props) }
  const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(flatten)]
  let nodes = flatten(page())
  nodes.find(node => node.type === 'input' && node.props.type === 'checkbox' && !node.props['aria-label']).props.onChange({ target: { checked: true } })
  nodes = flatten(page())
  const restore = nodes.find(node => node.type === 'button' && node.children.includes('restoreSelected'))
  assert.equal(restore.props.disabled, false)
  await restore.props.onClick()
  assert.deepEqual(calls, ['a', 'b'])
  assert.deepEqual(Array.from(state[4]), ['b'])
  assert.match(state[3].text, /fixture failure/)
  assert.equal(state[1], null)
  nodes = flatten(page())
  nodes.find(node => node.type === 'button' && node.children.includes('deleteSelected')).props.onClick()
  assert.deepEqual(Array.from(state[5]), ['b'])
  assert.ok(flatten(page()).some(node => node.type === 'button' && node.children.includes('confirm')))
})
test('host rejects unauthenticated requests before reading body', async () => {
  let handler, status, output
  apply({ sessionPersistence: {}, effect: fn => fn(), webServer: { register: route => { handler = route.handler; return () => {} } }, connection: { requestRejection: () => 401 }, logger: { warn() {} } })
  await handler({ headers: {} }, { writeHead: code => { status = code }, end: body => { output = JSON.parse(body) } })
  assert.equal(status, 403); assert.equal(output.ok, false)
})

function routeHarness(unarchiveSession = async () => {}) {
  let handler
  apply({ sessionPersistence: {}, workspaceRegistry: { unarchiveSession }, effect: fn => fn(), webServer: { register: route => { handler = route.handler; return () => {} } }, connection: { requestRejection: () => undefined }, logger: { warn() {} } })
  return async (body, headers = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'
    req.headers = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json', 'x-archived-sessions-action': 'manage', ...headers }; req.socket = { remoteAddress: '127.0.0.1' }
    let status, result
    await handler(req, { writeHead: code => { status = code }, end: text => { result = JSON.parse(text) } })
    return { status, result }
  }
}
test('authenticated restore calls the registry and returns success', async () => {
  let restored
  const route = routeHarness(async id => { restored = id })
  const output = await route({ sessionId: 'session-a', action: 'restore' })
  assert.equal(restored, 'session-a'); assert.equal(output.status, 200); assert.equal(output.result.restored, true)
})
test('opaque IM session ids containing colon and at-sign can be restored', async () => {
  const id = 'im:weixin_test:dm:1790920171516:user@im.wechat'
  let restored
  const output = await routeHarness(async value => { restored = value })({ sessionId: id, action: 'restore' })
  assert.equal(output.status, 200); assert.equal(restored, id)
})
test('cross-origin mutation is rejected', async () => {
  const output = await routeHarness(() => { throw Error('must not execute') })({ sessionId: 'session-a', action: 'restore' }, { origin: 'http://evil.invalid' })
  assert.equal(output.status, 403)
})
test('mutation without the explicit action header is rejected', async () => {
  const output = await routeHarness()({ sessionId: 'session-a', action: 'restore' }, { 'x-archived-sessions-action': undefined })
  assert.equal(output.status, 400)
})
test('path traversal session identities are rejected', async () => {
  const output = await routeHarness()({ sessionId: '../session-a', action: 'delete' })
  assert.equal(output.status, 400)
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-archive-test-'))
  const root = join(base, 'sessions'), dir = join(root, 'project', 'session-a')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'v4.jsonl'), 'fixture-only')
  const ctx = context(), registry = ctx.workspaceRegistry
  let state = { archivedSessionIds: ['session-a'], pinnedSessionIds: [] }, released = false
  Object.defineProperty(registry, 'archivedSessionIds', { get: () => state.archivedSessionIds })
  registry.headers = new Map([['session-a', { id: 'session-a' }]])
  registry.sessionPaths = new Map([['session-a', 'project']]); registry.invalidSessionPaths = new Map()
  const workspace = { sessionIds: ['session-a'], detachSession: async () => { workspace.sessionIds = [] }, mutate: async fn => { workspace.sessionIds = fn({ sessionIds: workspace.sessionIds }).sessionIds } }
  registry.list = () => [workspace]; registry.requireState = () => state; registry.setState = async value => { state = value }
  ctx.sessionPersistence = { root, findLog: async () => ({ currentPath: join(dir, 'v4.jsonl') }), list: async () => [], acquireLease: async () => ({ release: async () => { released = true } }) }
  return { ctx, base, dir, workspace, released: () => released }
}
test('permanent deletion removes only a disposable fixture and metadata', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await deleteArchived(f.ctx, 'session-a'), { deleted: true, removed: 1, children: 0, ghosts: 0 })
    await assert.rejects(access(f.dir), { code: 'ENOENT' })
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
    assert.deepEqual(f.workspace.sessionIds, [])
    assert.equal(f.released(), true)
    assert.deepEqual(removedIds(f.ctx), ['session-a'])
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('failed metadata write restores fixture log and workspace membership', async () => {
  const f = await fixture()
  f.ctx.workspaceRegistry.setState = async () => { throw Error('fixture metadata failure') }
  try {
    await assert.rejects(deleteArchived(f.ctx, 'session-a'), /fixture metadata failure/)
    assert.equal(await readFile(join(f.dir, 'v4.jsonl'), 'utf8'), 'fixture-only')
    assert.deepEqual(f.workspace.sessionIds, ['session-a'])
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, ['session-a'])
    assert.equal(f.released(), true)
    assert.deepEqual(removedIds(f.ctx), [])
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('failed metadata write on a ghost-only batch restores workspace membership and registry entries', async () => {
  // A "ghost" has an archive record but no log on disk, so nothing is moved to
  // quarantine (moved.length === 0). The metadata steps (detach workspace,
  // delete registry entries) still run, and if registry.setState then throws the
  // rollback must still restore them -- otherwise the workspace membership is
  // gone while the archive record survives (a half-deleted state).
  const f = await fixture()
  f.ctx.sessionPersistence.findLog = async () => undefined
  f.ctx.workspaceRegistry.setState = async () => { throw Error('fixture metadata failure') }
  try {
    await assert.rejects(deleteArchived(f.ctx, 'session-a'), /fixture metadata failure/)
    assert.deepEqual(f.workspace.sessionIds, ['session-a'])
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, ['session-a'])
    assert.equal(f.ctx.workspaceRegistry.headers.has('session-a'), true)
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})

test('a log path that resolves outside the sessions root is refused as storage-invalid', async () => {
  const f = await fixture()
  const outside = join(f.base, 'outside.jsonl')
  await writeFile(outside, 'outside')
  f.ctx.sessionPersistence.findLog = async () => ({ currentPath: outside })
  try {
    await assert.rejects(deleteArchived(f.ctx, 'session-a'), reasonRegex('storage-invalid'))
    // Nothing on disk or in metadata may change when a path fails validation.
    assert.equal(await readFile(join(f.dir, 'v4.jsonl'), 'utf8'), 'fixture-only')
    assert.deepEqual(f.workspace.sessionIds, ['session-a'])
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})

async function treeFixture({ ghost = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-archive-test-'))
  const root = join(base, 'sessions'), project = join(root, 'project')
  const parentDir = join(project, 'session-a'), childDir = join(project, 'child-1'), grandDir = join(project, 'grandchild')
  for (const dir of ghost ? [childDir, grandDir] : [parentDir, childDir, grandDir]) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'v4.jsonl'), 'fixture') }
  const paths = new Map([['session-a', join(parentDir, 'v4.jsonl')], ['child-1', join(childDir, 'v4.jsonl')], ['grandchild', join(grandDir, 'v4.jsonl')]])
  if (ghost) paths.delete('session-a')
  const ctx = context(), registry = ctx.workspaceRegistry
  let state = { archivedSessionIds: ['session-a'], pinnedSessionIds: [] }
  Object.defineProperty(registry, 'archivedSessionIds', { get: () => state.archivedSessionIds })
  registry.headers = new Map([...paths.keys()].map(id => [id, { id }]))
  registry.sessionPaths = new Map([...paths.keys()].map(id => [id, 'project'])); registry.invalidSessionPaths = new Map()
  const workspace = { sessionIds: ['session-a'], detachSession: async id => { workspace.sessionIds = workspace.sessionIds.filter(value => value !== id) }, mutate: async fn => { workspace.sessionIds = fn({ sessionIds: workspace.sessionIds }).sessionIds } }
  registry.list = () => [workspace]; registry.requireState = () => state; registry.setState = async value => { state = value }
  ctx.sessionPersistence = {
    root,
    findLog: async id => paths.has(id) ? { currentPath: paths.get(id) } : undefined,
    list: async () => [
      { header: { id: 'child-1', parentSession: 'session-a', origin: 'subagent' } },
      { header: { id: 'grandchild', parentSession: 'child-1', origin: 'subagent' } },
      ...[...paths.keys()].filter(id => id.startsWith('session-')).map(id => ({ header: { id } }))
    ],
    acquireLease: async () => ({ release: async () => {} })
  }
  return { ctx, base, root, parentDir, childDir, grandDir }
}
test('cascade deletion removes hidden descendants from disk and metadata', async () => {
  const f = await treeFixture()
  try {
    await assert.rejects(deleteArchived(f.ctx, 'session-a'), reasonFragment('refuse-referenced', 0))
    const result = await deleteArchived(f.ctx, 'session-a', { cascade: true })
    assert.deepEqual(result, { deleted: true, removed: 3, children: 2, ghosts: 0 })
    for (const dir of [f.parentDir, f.childDir, f.grandDir]) await assert.rejects(access(dir), { code: 'ENOENT' })
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
    assert.equal(f.ctx.workspaceRegistry.headers.size, 0)
    assert.deepEqual(removedIds(f.ctx).sort(), ['child-1', 'grandchild', 'session-a'])
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('a stale archive record without a log is cleaned up on its own', async () => {
  const f = await treeFixture({ ghost: true })
  try {
    assert.deepEqual(await inspectArchived(f.ctx, ['session-a']), [{ id: 'session-a', archived: true, hasLog: false, children: ['child-1', 'grandchild'], blocked: [] }])
    const result = await deleteArchived(f.ctx, 'session-a', { cascade: true })
    assert.equal(result.deleted, true); assert.equal(result.ghosts, 1); assert.equal(result.removed, 3)
    await assert.rejects(access(f.childDir), { code: 'ENOENT' })
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('delete without an explicit cascade refuses before touching disk', async () => {
  const f = await treeFixture()
  try {
    await assert.rejects(deleteArchived(f.ctx, 'session-a'), reasonFragment('refuse-referenced', 0))
    assert.equal(await readFile(join(f.parentDir, 'v4.jsonl'), 'utf8'), 'fixture')
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('a confirmation that does not list every descendant is refused', async () => {
  const f = await treeFixture()
  try {
    // Simulates a subagent that appeared after the confirmation dialog was rendered.
    await assert.rejects(deleteArchived(f.ctx, 'session-a', { cascade: true, expect: ['child-1'] }), reasonRegex('cascade-mismatch'))
    await assert.rejects(deleteArchived(f.ctx, 'session-a', { cascade: true, expect: [] }), reasonRegex('cascade-mismatch'))
    assert.equal(await readFile(join(f.parentDir, 'v4.jsonl'), 'utf8'), 'fixture')
    assert.equal(await readFile(join(f.childDir, 'v4.jsonl'), 'utf8'), 'fixture')
    assert.deepEqual(await deleteArchived(f.ctx, 'session-a', { cascade: true, expect: ['child-1', 'grandchild'] }), { deleted: true, removed: 3, children: 2, ghosts: 0 })
  } finally { assert.ok(f.base.startsWith(join(tmpdir(), 'dsh-archive-test-'))); await rm(f.base, { recursive: true, force: true }) }
})
test('inspect route reports archived state and rejects bad payloads', async () => {
  let handler
  const ctx = { sessionPersistence: { list: async () => [] }, sessions: { list: () => [] }, workspaceRegistry: { archivedSessionIds: [], list: () => [], enqueueOperation: fn => fn() }, effect: fn => fn(), webServer: { register: route => { handler = route.handler; return () => {} } }, connection: { requestRejection: () => undefined }, logger: { warn() {} } }
  apply(ctx)
  const call = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'
    req.headers = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json', 'x-archived-sessions-action': 'manage' }; req.socket = { remoteAddress: '127.0.0.1' }
    let status, result
    await handler(req, { writeHead: code => { status = code }, end: text => { result = JSON.parse(text) } })
    return { status, result }
  }
  const ok = await call({ action: 'inspect', sessionIds: ['session-a'] })
  assert.equal(ok.status, 200); assert.deepEqual(ok.result.items, [{ id: 'session-a', archived: false }])
  const bad = await call({ action: 'inspect', sessionIds: '../escape' })
  assert.equal(bad.status, 400)
  const missing = await call({ sessionId: 'session-a', action: 'delete' })
  assert.equal(missing.status, 409)
  const orphanReport = await call({ action: 'orphans' })
  assert.equal(orphanReport.status, 200); assert.deepEqual(orphanReport.result.orphans, [])
  const orphanBad = await call({ action: 'deleteOrphans', sessionIds: [{ evil: true }] })
  assert.equal(orphanBad.status, 400)
  const orphanEmpty = await call({ action: 'deleteOrphans', sessionIds: [] })
  assert.equal(orphanEmpty.status, 200); assert.equal(orphanEmpty.result.removed, 0)
})
