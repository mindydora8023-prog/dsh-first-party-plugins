import { dirname, relative, resolve, join, basename, sep, isAbsolute } from 'node:path'
import { lstat, realpath, rename, rm, mkdir, rmdir, readdir, readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// User-facing refusal text lives in lib/reasons.js as escaped catalogue entries:
// this file must stay ASCII (see tools/build-reasons.py for why).
import { reason as t } from './reasons.js'
import { cleanupFile, loadCleanup, saveCleanupConfig, saveLastRun, runAutoCleanup } from './cleanup.js'

export const name = 'archived-sessions'
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions']
const endpoint = '/archived-sessions/manage'
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

/** A stable-enough identity for a workspace record (used by recycle restore). */
function workspaceKeyOf(workspace, index) {
  if (workspace && typeof workspace === 'object') {
    for (const field of ['path', 'id', 'title']) {
      const value = workspace[field]
      if (typeof value === 'string' && value !== '') return field + ':' + value
    }
  }
  return 'index:' + index
}

const recycleDirOf = root => join(dirname(root), `${basename(root)}-recycle`)
const quarantineDirOf = root => join(dirname(root), `${basename(root)}-deleted`)
const quarantineId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

async function statIfPresent(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function ownedDirectory(path) {
  const info = await statIfPresent(path)
  if (!info) return false
  if (!info.isDirectory() || relative(path, await realpath(path)) !== '') throw fail(t('storage-invalid'))
  return true
}

async function createOwnedDirectory(path) {
  if (await ownedDirectory(path)) return false
  await mkdir(path)
  return true
}

// This extension deliberately fails closed for other persistence implementations.
// Never construct a deletion path from an untrusted session id or its cwd.
const invalidSessionId = id => typeof id !== 'string' || !id.trim() || id.length > 1024 || /[\u0000-\u001f\u007f\\/]/.test(id) || id === '.' || id === '..'

const isLive = (ctx, id) => Boolean(ctx.sessions.get(id) ?? ctx.get('agents')?.get(id))

/** Every header this process can see: stored snapshots plus live sessions, deduplicated by id. */
async function snapshotHeaders(ctx) {
  const byId = new Map()
  for (const item of await ctx.sessionPersistence.list()) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !byId.has(header.id)) byId.set(header.id, header)
  }
  for (const item of ctx.sessions.list()) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !byId.has(header.id)) byId.set(header.id, header)
  }
  return byId
}

/** Session ids that a workspace accounts for; deleting one of those would corrupt membership. */
function workspaceMembers(registry) {
  const members = new Set()
  if (typeof registry.list !== 'function') return members
  for (const workspace of registry.list()) for (const id of workspace.sessionIds ?? []) members.add(id)
  return members
}

/** Parent id to child ids, built from headers alone (a parent with no log still names its children). */
function childIndex(headers) {
  const childrenOf = new Map()
  for (const [childId, header] of headers) {
    const parent = header.parentSession
    if (typeof parent !== 'string' || !parent) continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(childId)
  }
  return childrenOf
}

/**
 * Why one descendant may not be removed, or undefined when it is a plain hidden subagent.
 * Only hidden subagents qualify: a real branch, a workspace-accounted session, an archived
 * session of its own, or a live session is a reason to refuse instead of guessing.
 */
function refuseReason(ctx, childId, header, archived, members) {
  if (header?.origin !== 'subagent') return t('child-not-subagent')
  if (archived.has(childId)) return t('child-archived')
  if (members.has(childId)) return t('child-in-workspace')
  if (isLive(ctx, childId)) return t('child-live')
  return undefined
}

function rules(ctx, headers) {
  return {
    archived: new Set(ctx.workspaceRegistry.archivedSessionIds),
    members: workspaceMembers(ctx.workspaceRegistry),
    headers,
    // Built once per snapshot and reused by every planDeletion call in a batch,
    // so inspecting N archived ids is O(N + headers), not O(N * headers).
    childIndex: childIndex(headers),
  }
}

/** Walk the parentSession closure below one archived session. */
function planDeletion(ctx, id, headers, shared) {
  const { archived, members } = shared ?? rules(ctx, headers)
  const childrenOf = shared?.childIndex ?? childIndex(headers)
  const order = [], refused = [], seen = new Set([id]), queue = [{ id, depth: 0 }]
  // Index, not shift: shift copies the queue on every node, so a wide
  // parentSession closure was quadratic in the number of descendants.
  let head = 0
  while (head < queue.length) {
    const current = queue[head]
    head += 1
    for (const childId of childrenOf.get(current.id) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      const reason = refuseReason(ctx, childId, headers.get(childId), archived, members)
      if (reason) { refused.push({ id: childId, reason }); continue }
      const entry = { id: childId, depth: current.depth + 1 }
      order.push(entry)
      queue.push(entry)
    }
  }
  return { order, refused }
}

/**
 * Hidden subagents whose parent session has no log at all. Nothing else in the product
 * surfaces them: they are absent from every list and no archive entry names them, so
 * without this pass they can never be removed.
 */
function planOrphans(ctx, headers, shared) {
  const { archived, members } = shared ?? rules(ctx, headers)
  const orphans = [], blocked = []
  for (const [id, header] of headers) {
    if (header.origin !== 'subagent') continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || !parent) continue
    if (headers.has(parent)) continue
    // An archived parent with no log is still reachable: deleting that archive record
    // cascades these children. Reporting them again would offer the same log twice.
    if (archived.has(parent)) continue
    const blockedReason = archived.has(id) ? t('orphan-archived')
      : members.has(id) ? t('orphan-in-workspace')
        : isLive(ctx, id) ? t('child-live')
          : undefined
    if (blockedReason) { blocked.push({ id, missingParent: parent, reason: blockedReason }); continue }
    orphans.push({ id, missingParent: parent })
  }
  return { orphans, blocked }
}

function refusalMessage(refused) {
  const lines = refused.map(item => t('line-child', { id: item.id, reason: item.reason })).join('\n')
  return t('refuse-children', { lines })
}

function referenceMessage(children) {
  const lines = children.map(child => t('line-child-plain', { id: child.id })).join('\n')
  return t('refuse-referenced', { count: children.length, lines })
}

function orphanRefusalMessage(blocked) {
  const lines = blocked
    .map(item => t('line-orphan', { id: item.id, missingParent: item.missingParent, reason: item.reason }))
    .join('\n')
  return t('refuse-orphans', { lines })
}

/** Default budget for one delete transaction. Overridable per call. */
export const DEFAULT_DELETE_TIMEOUT_MS = 30000

/**
 * Run a delete transaction under a deadline.
 *
 * Why this exists: a delete performs a dozen awaits (realpath, lease, rename,
 * registry.setState, workspace.detachSession, rm) and every one of them can stall
 * -- a network share, a busy antivirus scanner, a locked log file. Before this,
 * a stalled filesystem simply hung the Settings request with no bound at all.
 *
 * The failure is reported as a TIMEOUT with status 504 and, crucially, the message
 * does NOT claim nothing happened: the transaction may be half-applied (a log may
 * be sitting in the quarantine directory), so the caller is told to refresh and
 * re-inspect rather than to retry blindly. That mirrors the workspace rule that
 * effects dominate retry advice.
 *
 * The work itself is not abandoned -- a Promise cannot be cancelled from outside --
 * but the caller stops waiting. Real cancellation on Windows needs cooperation
 * from each await, which the fs APIs here do not offer.
 *
 * @param {Promise<any>} work the transaction.
 * @param {number} timeoutMs budget; 0 or negative disables the deadline.
 * @returns {Promise<any>}
 */
export function withDeadline(work, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work
  let timer
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(t('delete-timeout', { seconds: Math.round(timeoutMs / 1000) }))
      error.status = 504
      error.effectState = 'unknown'
      error.retry = 'never'
      reject(error)
    }, timeoutMs)
    // Do not keep the process alive just for this timer.
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

function enqueueMutation(ctx, operation, budget = DEFAULT_DELETE_TIMEOUT_MS) {
  let expired = false
  const queued = ctx.workspaceRegistry.enqueueOperation(() => {
    // A request that expired while waiting must not start later. A running
    // transaction retains the host queue and its writer fence until it settles.
    if (!expired) return operation()
  })
  return withDeadline(queued, budget).catch(error => {
    expired = error.status === 504
    throw error
  })
}

/** Resolve one stored session's directory without trusting the id: the backend decides the path. */
async function locate(backend, id) {
  const selected = await backend.findLog(id)
  if (!selected) return undefined
  const raw = dirname(selected.currentPath)
  return { raw, path: await realpath(raw) }
}

async function validateLocation(root, location) {
  const rel = relative(root, location.path)
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== location.path || rel.split(/[\\/]/).length !== 2) throw fail(t('storage-invalid'))
  if ((await lstat(location.raw)).isSymbolicLink()) throw fail(t('storage-invalid'))
}

async function assertParentIdle(ctx, id) {
  if (isLive(ctx, id)) throw fail(t('session-live'))
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => [])
  if (activity.length) throw fail(t('session-activity'))
}

/**
 * Tell connected clients that these stored sessions no longer exist.
 *
 * The Workspace feed only drops their ids from the archived set; a client's
 * session-list row is maintained incrementally from the host's api-session/*
 * frames and is NOT re-read on a background delete. The Settings page calls its
 * own `sessions.refresh()` after a manual delete, but the hourly auto sweep runs
 * with no page involved -- so without this frame a cleaned session stayed in the
 * sidebar until a full restart. `api-session/removed` is the host's own cold
 * session removal frame (its live twin fires on `session/disposed`), forwarded to
 * the owner client through the api-remotes allowlist, so reusing it keeps the
 * sidebar, archived filter and list store consistent.
 */
function announceRemoved(ctx, ids) {
  if (typeof ctx.emit !== 'function') return
  for (const id of ids) {
    try { ctx.emit('api-session/removed', id) }
    catch (error) { ctx.logger?.warn('archived-sessions: removal notification failed for %s: %s', id, error?.message ?? String(error)) }
  }
}

const registryFields = { header: 'headers', sessionPath: 'sessionPaths', invalidSessionPath: 'invalidSessionPaths' }

function snapshotEntries(registry, id) {
  return Object.entries(registryFields).flatMap(([field, key]) => {
    const map = registry[key]
    return map ? [{ field, map, present: map.has(id), value: map.get(id) }] : []
  })
}

function restoreEntries(id, entries) {
  for (const { map, present, value } of entries) {
    if (present) map.set(id, value)
    else map.delete(id)
  }
}

function snapshotState(registry) {
  const state = registry.requireState()
  return { ...state, archivedSessionIds: [...state.archivedSessionIds], pinnedSessionIds: [...state.pinnedSessionIds] }
}

const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index])

async function restoreState(registry, before) {
  const current = registry.requireState()
  if (!sameIds(current.archivedSessionIds, before.archivedSessionIds) || !sameIds(current.pinnedSessionIds, before.pinnedSessionIds)) {
    await registry.setState(before)
  }
}

async function rollback(ctx, steps) {
  let complete = true
  for (const step of steps.reverse()) {
    try { await step() }
    catch (error) {
      complete = false
      ctx.logger?.warn('archived-sessions: rollback step failed: %s', error.message)
    }
  }
  return complete
}

async function writeRecycleSnapshot(path, record, onCreate) {
  const file = await open(path, 'wx')
  try {
    onCreate()
    await file.writeFile(JSON.stringify(record), 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

/**
 * The one removal transaction. `targets` are already authorised by the caller; this only
 * resolves, locks, isolates and cleans up, rolling metadata back if any step fails.
 * A target without a log is not an error: its metadata entry is still removed, which is
 * the only way a stale record can ever be cleaned up.
 */
async function runRemoval(ctx, targets, options) {
  const registry = ctx.workspaceRegistry, backend = ctx.sessionPersistence
  const root = await realpath(backend.root)
  const removed = new Set(targets.map(target => target.id))
  const releaseFence = options.fence?.([...removed])
  const leases = [], undo = [], warnings = [], files = []
  const quarantine = quarantineDirOf(root), recycleRoot = recycleDirOf(root)
  const recycle = options.recycle === true
  let committed = false
  try {
    for (const id of removed) {
      if (isLive(ctx, id)) throw fail(t('session-live'))
      const location = await locate(backend, id)
      if (!location) continue
      await validateLocation(root, location)
      const key = randomUUID()
      files.push({ id, location, isolated: join(quarantine, key), sidecar: join(recycleRoot, key + '.json'), moved: false })
    }
    for (const { id, location } of files) leases.push(await backend.acquireLease(id, undefined, location.path))
    const before = snapshotState(registry)
    const prior = new Map([...removed].map(id => [id, snapshotEntries(registry, id)]))
    const workspaces = [...registry.list()].map((workspace, index) => ({
      workspace, key: workspaceKeyOf(workspace, index), sessionIds: [...workspace.sessionIds],
    })).filter(({ sessionIds }) => sessionIds.some(id => removed.has(id)))

    if (files.length) await createOwnedDirectory(quarantine)
    if (recycle && files.length) {
      await createOwnedDirectory(recycleRoot)
      const removedAt = Date.now()
      for (const file of files) {
        const { id, location, isolated, sidecar } = file
        const entries = Object.fromEntries(prior.get(id).map(({ field, value }) => [field, value ?? null]))
        await writeRecycleSnapshot(sidecar, {
          ...entries, version: 2, id, originalPath: location.path, isolatedPath: isolated, removedAt,
          archived: before.archivedSessionIds.includes(id), pinned: before.pinnedSessionIds.includes(id),
          workspaces: workspaces.filter(({ sessionIds }) => sessionIds.includes(id)).map(({ key, sessionIds }) => ({ key, sessionIds })),
        }, () => undo.push(() => {
          // A failed move back still needs the snapshot for recovery.
          if (!file.moved) return rm(sidecar, { force: true })
        }))
      }
    }
    for (const file of files) {
      const { location, isolated } = file
      await rename(location.path, isolated)
      file.moved = true
      undo.push(async () => {
        await rename(isolated, location.path)
        file.moved = false
      })
    }
    for (const { workspace, sessionIds } of workspaces) {
      undo.push(() => workspace.mutate(record => sameIds(record.sessionIds, sessionIds) ? record : { ...record, sessionIds }))
      for (const id of sessionIds) if (removed.has(id)) await workspace.detachSession(id)
    }
    for (const [id, entries] of prior) {
      undo.push(() => restoreEntries(id, entries))
      for (const { map } of entries) map.delete(id)
    }
    undo.push(() => restoreState(registry, before))
    await registry.setState({ ...before, pinnedSessionIds: before.pinnedSessionIds.filter(id => !removed.has(id)), archivedSessionIds: before.archivedSessionIds.filter(id => !removed.has(id)) })

    committed = true
  } catch (error) {
    if (!await rollback(ctx, undo)) throw fail(t('delete-incomplete'), 500)
    throw error
  } finally {
    try {
      for (const lease of leases) {
        try { await lease.release() }
        catch (error) { ctx.logger?.warn('archived-sessions: lease release failed: %s', error.message) }
      }
      if (committed) {
        announceRemoved(ctx, [...removed])
        if (!recycle) {
          for (const { id, isolated } of files) {
            try { await rm(isolated, { recursive: true, force: false }) }
            catch { warnings.push(t('quarantine-failed', { id })) }
          }
        }
      }
    } finally { releaseFence?.() }
  }
  return { removed: removed.size, ghosts: removed.size - files.length, warnings }
}

/**
 * Permanent deletion of one archived session, optionally together with the hidden subagent
 * sessions below it.
 */
export async function deleteArchived(ctx, id, options = {}) {
  const budget = options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS
  return enqueueMutation(ctx, () => deleteArchivedLocked(ctx, id, options), budget)
}

async function deleteArchivedLocked(ctx, id, options) {
  const registry = ctx.workspaceRegistry, backend = ctx.sessionPersistence
  if (!registry.archivedSessionIds.includes(id)) throw fail(t('not-archived'))
  if (typeof backend.findLog !== 'function' || typeof backend.acquireLease !== 'function' || typeof backend.root !== 'string') throw fail(t('backend-unsupported'))
  await assertParentIdle(ctx, id)

  const headers = await snapshotHeaders(ctx)
  const shared = rules(ctx, headers)
  const plan = planDeletion(ctx, id, headers, shared)
  if (plan.refused.length) throw fail(refusalMessage(plan.refused))
  if (plan.order.length && options.cascade !== true) throw fail(referenceMessage(plan.order))
  // The page sends the exact descendant list it showed the user; a session that appeared in
  // between must never be deleted by a confirmation that never listed it.
  if (options.expect !== undefined) {
    const expected = new Set(Array.isArray(options.expect) ? options.expect.filter(value => typeof value === 'string') : [])
    const planned = new Set(plan.order.map(child => child.id))
    if (expected.size !== planned.size || [...planned].some(value => !expected.has(value))) throw fail(t('cascade-mismatch'))
  }

  const result = await runRemoval(ctx, [{ id, depth: 0 }, ...plan.order], options)
  const body = { deleted: true, removed: result.removed, children: plan.order.length, ghosts: result.ghosts }
  if (result.warnings.length) body.warning = result.warnings.join('\n')
  return body
}

/**
 * Remove orphaned hidden subagents: subagent sessions whose parent has no log anywhere.
 * Every id is re-validated here, so a stale page cannot delete a session that has since
 * gained a parent, joined a workspace, or become live.
 */
export async function deleteOrphans(ctx, ids, options = {}) {
  const budget = options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS
  return enqueueMutation(ctx, () => deleteOrphansLocked(ctx, [...new Set(ids)], options), budget)
}

async function deleteOrphansLocked(ctx, ids, options) {
  const registry = ctx.workspaceRegistry, backend = ctx.sessionPersistence
  if (!ids.length) return { deleted: true, removed: 0, ghosts: 0 }
  if (typeof backend.findLog !== 'function' || typeof backend.acquireLease !== 'function' || typeof backend.root !== 'string') throw fail(t('backend-unsupported'))
  const headers = await snapshotHeaders(ctx)
  const plan = planOrphans(ctx, headers)
  const allowed = new Map(plan.orphans.map(item => [item.id, item]))
  const blocked = plan.blocked.filter(item => ids.includes(item.id))
  if (blocked.length) throw fail(orphanRefusalMessage(blocked))
  const stale = ids.filter(id => !allowed.has(id))
  if (stale.length) throw fail(t('orphans-stale', { lines: stale.join('\n') }))
  const targets = ids.map(id => ({ id, depth: 1 }))
  for (const target of targets) if (isLive(ctx, target.id)) throw fail(t('session-live'))
  const result = await runRemoval(ctx, targets, options)
  const body = { deleted: true, removed: result.removed, children: result.removed, ghosts: result.ghosts }
  if (result.warnings.length) body.warning = result.warnings.join('\n')
  return body
}

/** Read-only description of what a delete would do, used by the settings page. */
export async function inspectArchived(ctx, ids) {
  const registry = ctx.workspaceRegistry
  const headers = await snapshotHeaders(ctx)
  const shared = rules(ctx, headers)
  const items = []
  for (const id of ids) {
    if (!shared.archived.has(id)) { items.push({ id, archived: false }); continue }
    const plan = planDeletion(ctx, id, headers, shared)
    let location
    try { location = typeof ctx.sessionPersistence.findLog === 'function' ? await ctx.sessionPersistence.findLog(id) : undefined }
    catch { location = undefined }
    items.push({ id, archived: true, hasLog: location !== undefined, children: plan.order.map(child => child.id), blocked: plan.refused })
  }
  return items
}

/** Read-only orphan report: hidden subagents whose parent log is gone. */
export async function inspectOrphans(ctx) {
  const headers = await snapshotHeaders(ctx)
  const plan = planOrphans(ctx, headers)
  return plan
}

/**
 * Read-only inventory of every archived session, for backup or audit before a
 * cleanup. Never mutates anything: it reuses `inspectArchived`'s read-only
 * description (hasLog / children / blocked) over the registry's archived ids.
 * Capped like the inspect route so a huge registry cannot flood a response.
 */
export async function listArchivedInventory(ctx) {
  const all = Array.isArray(ctx.workspaceRegistry?.archivedSessionIds) ? ctx.workspaceRegistry.archivedSessionIds : []
  const ids = all.slice(0, 500)
  const items = await inspectArchived(ctx, ids)
  return { total: all.length, shown: ids.length, items }
}

async function readRecycleRecords(ctx, { includeMissing = false } = {}) {
  const backend = ctx.sessionPersistence
  if (typeof backend?.root !== 'string') throw fail(t('backend-unsupported'))
  const root = await realpath(backend.root)
  const recycleRoot = recycleDirOf(root), quarantine = quarantineDirOf(root)
  if (!await ownedDirectory(recycleRoot) || !await ownedDirectory(quarantine)) return []
  const records = []
  for (const name of await readdir(recycleRoot)) {
    if (!name.endsWith('.json') || !quarantineId.test(name.slice(0, -5))) continue
    const sidecar = join(recycleRoot, name)
    try {
      if (!(await statIfPresent(sidecar))?.isFile()) continue
      const record = JSON.parse(await readFile(sidecar, 'utf8'))
      if (!record || ![1, 2].includes(record.version) || typeof record.id !== 'string' || !Number.isFinite(record.removedAt)) continue
      if (typeof record.isolatedPath !== 'string' || typeof record.originalPath !== 'string' || !isAbsolute(record.originalPath)) continue
      const key = record.version === 2 ? name.slice(0, -5) : basename(record.isolatedPath)
      const isolated = join(quarantine, key)
      if (!quarantineId.test(key) || record.isolatedPath !== isolated) continue
      const segments = relative(root, record.originalPath).split(sep)
      if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..')) continue
      const original = join(root, ...segments)
      if (record.originalPath !== original) continue
      if (!await ownedDirectory(isolated) && !includeMissing) continue
      records.push({ record, sidecar, isolated, original })
    } catch { /* Ignore corrupt or inaccessible records. */ }
  }
  return records.sort((left, right) => right.record.removedAt - left.record.removedAt)
}

/** Read-only list of sessions currently held in the recycle bin. */
export async function listRecycle(ctx) {
  return (await readRecycleRecords(ctx)).map(({ record, sidecar, original }) => ({
    recycleId: basename(sidecar), id: record.id, removedAt: record.removedAt,
    originalPath: original, archived: record.archived === true,
  }))
}

function restoreMember(ids, snapshot, id) {
  if (ids.includes(id)) return ids
  const at = snapshot.indexOf(id)
  const next = snapshot.slice(at + 1).find(value => ids.includes(value))
  const index = next === undefined ? ids.length : ids.indexOf(next)
  return [...ids.slice(0, index), id, ...ids.slice(index)]
}

/** Restore a recycled session within the same host queue as delete and purge. */
export async function restoreRecycle(ctx, id, options = {}) {
  return enqueueMutation(ctx, () => restoreRecycleLocked(ctx, id, options), options.timeoutMs)
}

async function restoreRecycleLocked(ctx, id, options) {
  const registry = ctx.workspaceRegistry, backend = ctx.sessionPersistence
  const chosen = (await readRecycleRecords(ctx)).find(item => item.record.id === id)
  if (!chosen) throw fail('recycle record not found', 404)
  const { record, sidecar, isolated, original } = chosen
  const releaseFence = options.fence?.([id])
  const undo = []
  try {
    await assertParentIdle(ctx, id)
    if (await backend.findLog?.(id)) throw fail('restore target already exists', 409)
    const project = dirname(original)
    if (await createOwnedDirectory(project)) undo.push(() => rmdir(project))
    if (await statIfPresent(original)) throw fail('restore target already exists', 409)
    const before = snapshotState(registry)
    if (!await ownedDirectory(dirname(isolated)) || !await ownedDirectory(isolated)) throw fail(t('storage-invalid'))
    await rename(isolated, original)
    undo.push(() => rename(original, isolated))

    const prior = snapshotEntries(registry, id)
    undo.push(() => restoreEntries(id, prior))
    for (const { map, field } of prior) {
      if (record[field] !== null && record[field] !== undefined) map.set(id, record[field])
    }
    const workspaces = new Map([...registry.list()].map((workspace, index) => [workspaceKeyOf(workspace, index), workspace]))
    for (const snapshot of Array.isArray(record.workspaces) ? record.workspaces : []) {
      const workspace = workspaces.get(snapshot?.key)
      if (!workspace || !Array.isArray(snapshot.sessionIds) || !snapshot.sessionIds.includes(id)) continue
      let previousIds
      undo.push(() => {
        if (previousIds) return workspace.mutate(current => ({ ...current, sessionIds: previousIds }))
      })
      await workspace.mutate(current => {
        const ids = restoreMember(current.sessionIds, snapshot.sessionIds, id)
        if (ids === current.sessionIds) return current
        previousIds = [...current.sessionIds]
        return { ...current, sessionIds: ids }
      })
    }
    const archived = new Set(before.archivedSessionIds), pinned = new Set(before.pinnedSessionIds)
    if (record.archived === true) archived.add(id)
    if (record.pinned === true) pinned.add(id)
    undo.push(() => restoreState(registry, before))
    await registry.setState({ ...before, archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] })
    await rm(sidecar)
    return { restored: true, id, archived: record.archived === true }
  } catch (error) {
    if (!await rollback(ctx, undo)) throw fail('recycle restore rollback incomplete', 500)
    throw error
  } finally { releaseFence?.() }
}

/** Delete recycled sessions older than `days`. Returns how many were purged. */
export async function purgeExpiredRecycle(ctx, days = 7, now = Date.now()) {
  return enqueueMutation(ctx, async () => {
    const limit = (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000
    let purged = 0
    for (const { record, isolated, sidecar } of await readRecycleRecords(ctx, { includeMissing: true })) {
      if (now - record.removedAt < limit) continue
      try {
        if (await ownedDirectory(dirname(isolated)) && await ownedDirectory(isolated)) await rm(isolated, { recursive: true })
        await rm(sidecar)
        purged += 1
      } catch (error) { ctx.logger?.warn('archived-sessions: recycle purge failed: %s', error.message) }
    }
    return { purged }
  })
}

function sameOrigin(req) {
  const origin = req.headers.origin, host = req.headers.host
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (origin === undefined) return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  try { return new URL(origin).origin === `${req.socket.encrypted ? 'https' : 'http'}://${host}` } catch { return false }
}
async function bodyOf(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw fail(t('body-too-large'), 413); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(t('body-malformed'), 400) }
}
/** One minute in ms; fixed because a day threshold is the only thing users tune. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** Delay before the first pass so host startup is never blocked by cleanup I/O. */
const STARTUP_DELAY_MS = 90 * 1000

export function apply(ctx, config) {
  const locks = new Set()
  const fence = ids => {
    if (ids.some(id => locks.has(id))) throw fail(t('busy'))
    for (const id of ids) locks.add(id)
    return () => { for (const id of ids) locks.delete(id) }
  }
  const baseConfig = config && typeof config === 'object' ? config : {}
  let sweeping = false

  /**
   * Run one cleanup pass against the live context. Config is re-read from disk on
   * every pass so an enabled/days change in Settings applies without a restart.
   * Manual runs ignore the enabled switch (the user clicked the button).
   */
  const sweep = async (reason, dryRun = false) => {
    if (sweeping) return { busy: true }
    sweeping = true
    try {
      const file = cleanupFile()
      const state = await loadCleanup(file)
      const enabled = typeof state.config.enabled === 'boolean' ? state.config.enabled : baseConfig.enabled !== false
      if (!dryRun && reason !== 'manual' && !enabled) return { disabled: true }
      const report = await runAutoCleanup(ctx, {
        now: Date.now(),
        days: state.config.days,
        dryRun,
        reason,
        deleteOne: (id, options) => deleteArchived(ctx, id, { ...options, fence }),
      })
      if (!dryRun) {
        try { await saveLastRun(report, file) } catch (error) { ctx.logger?.warn('archived-sessions: cleanup status write failed: %s', error?.message ?? String(error)) }
        try { await purgeExpiredRecycle(ctx, Number.isFinite(baseConfig.recycleDays) && baseConfig.recycleDays > 0 ? baseConfig.recycleDays : 7) } catch (error) { ctx.logger?.warn('archived-sessions: recycle purge failed: %s', error?.message ?? String(error)) }
      }
      return report
    } finally {
      sweeping = false
    }
  }

  // Background sweep: one deferred startup pass, then hourly. Timers are unref'd
  // so they never keep the process alive, and `ctx.effect` disposes them on unload.
  ctx.effect(() => {
    const guard = error => ctx.logger?.warn('archived-sessions: cleanup failed: %s', error?.message ?? String(error))
    const initial = setTimeout(() => { sweep('startup').catch(guard) }, STARTUP_DELAY_MS)
    const timer = setInterval(() => { sweep('scheduled').catch(guard) }, SWEEP_INTERVAL_MS)
    if (typeof initial.unref === 'function') initial.unref()
    if (typeof timer.unref === 'function') timer.unref()
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, 'archived-sessions auto cleanup')

  // Fence new writers while the asynchronous delete transaction owns an id.
  ctx.effect(() => {
    const backend = ctx.sessionPersistence, original = backend.open
    if (typeof original !== 'function') return () => {}
    const guarded = function (id, ...args) {
      if (locks.has(id)) return Promise.reject(fail(t('delete-in-progress')))
      return original.call(this, id, ...args)
    }
    backend.open = guarded
    return () => { if (backend.open === guarded) backend.open = original }
  }, 'archived-sessions writer fence')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: endpoint, handler: async (req, res) => {
    try {
      if (ctx.connection.requestRejection(req) !== undefined || !sameOrigin(req)) throw fail(t('untrusted-origin'), 403)
      if (req.method !== 'POST' || req.headers['x-archived-sessions-action'] !== 'manage' || !/^application\/json(?:;.*)?$/i.test(req.headers['content-type'] ?? '')) throw fail(t('unsupported-request'), 400)
      const body = await bodyOf(req)
      if (body?.action === 'inspect') {
        const ids = body?.sessionIds
        if (!Array.isArray(ids) || ids.length > 500) throw fail(t('ids-invalid'), 400)
        for (const value of ids) if (invalidSessionId(value)) throw fail(t('id-invalid'), 400)
        json(res, 200, { ok: true, items: await inspectArchived(ctx, ids) })
        return
      }
      if (body?.action === 'orphans') {
        json(res, 200, { ok: true, ...await inspectOrphans(ctx) })
        return
      }
      if (body?.action === 'export') {
        json(res, 200, { ok: true, ...await listArchivedInventory(ctx) })
        return
      }
      if (body?.action === 'recycleList') {
        json(res, 200, { ok: true, items: await listRecycle(ctx) })
        return
      }
      if (body?.action === 'recycleRestore') {
        const sid = body?.sessionId
        if (invalidSessionId(sid)) throw fail(t('id-invalid'), 400)
        json(res, 200, { ok: true, ...await restoreRecycle(ctx, sid, { fence }) })
        return
      }
      if (body?.action === 'recyclePurge') {
        const days = Number.isInteger(body?.days) && body.days > 0 ? body.days : 7
        json(res, 200, { ok: true, ...await purgeExpiredRecycle(ctx, days) })
        return
      }
      if (body?.action === 'deleteOrphans') {
        const ids = body?.sessionIds
        if (!Array.isArray(ids) || ids.length > 500) throw fail(t('ids-invalid'), 400)
        for (const value of ids) if (invalidSessionId(value)) throw fail(t('id-invalid'), 400)
        json(res, 200, { ok: true, ...await deleteOrphans(ctx, ids, { fence }) })
        return
      }
      if (body?.action === 'cleanupStatus') {
        const state = await loadCleanup(cleanupFile())
        json(res, 200, { ok: true, cleanup: { enabled: state.config.enabled, days: state.config.days, lastRun: state.lastRun } })
        return
      }
      if (body?.action === 'setCleanup') {
        const enabled = body?.enabled
        const days = body?.days
        if (typeof enabled !== 'boolean' || !Number.isInteger(days) || days < 1 || days > 3650) throw fail(t('cleanup-config-invalid'), 400)
        const saved = await saveCleanupConfig({ enabled, days }, cleanupFile())
        json(res, 200, { ok: true, cleanup: { enabled: saved.enabled, days: saved.days } })
        return
      }
      if (body?.action === 'runCleanup') {
        const report = await sweep('manual')
        if (report?.busy) throw fail(t('busy'), 409)
        json(res, 200, { ok: true, report })
        return
      }
      // Read-only: which archived sessions the next cleanup would delete.
      // Same scan as a real sweep, but dryRun never calls the removal transaction.
      if (body?.action === 'previewCleanup') {
        const report = await sweep('manual', true)
        if (report?.busy) throw fail(t('busy'), 409)
        const ids = Array.isArray(report.deletedIds) ? report.deletedIds.slice(0, 500) : []
        json(res, 200, {
          ok: true,
          preview: {
            days: report.days,
            scanned: report.scanned ?? 0,
            eligible: report.eligible ?? 0,
            recent: report.recent ?? 0,
            live: report.live ?? 0,
            unknownAge: report.unknownAge ?? 0,
            ids,
          },
        })
        return
      }
      const id = body?.sessionId
      // SessionId is an opaque host identity, not a filename (IM ids contain ':' and '@').
      // Deletion resolves it through the backend and independently validates the real directory.
      if (invalidSessionId(id)) throw fail(t('id-invalid'), 400)
      if (!['restore', 'delete'].includes(body.action)) throw fail(t('action-invalid'), 400)
      if (body.action === 'restore') {
        await ctx.workspaceRegistry.unarchiveSession(id) // The host method holds the same registry queue.
        json(res, 200, { ok: true, restored: true })
        return
      }
      const result = await deleteArchived(ctx, id, {
        cascade: body.cascade === true, recycle: body.recycle === true || baseConfig.recycle === true,
        expect: Array.isArray(body.children) ? body.children : undefined, fence,
      })
      json(res, 200, { ok: true, ...result })
    } catch (error) { ctx.logger.warn('archived-sessions: %s', error.message); json(res, error.status ?? 500, { ok: false, error: error.status ? error.message : t('internal') }) }
  } }), 'archived-sessions management endpoint')
}
