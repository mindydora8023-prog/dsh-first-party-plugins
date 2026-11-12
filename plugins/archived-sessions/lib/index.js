import { dirname, relative, resolve, join, basename } from 'node:path'
import { lstat, realpath, rename, rm, mkdir } from 'node:fs/promises'
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
  return { archived: new Set(ctx.workspaceRegistry.archivedSessionIds), members: workspaceMembers(ctx.workspaceRegistry), headers }
}

/** Walk the parentSession closure below one archived session. */
function planDeletion(ctx, id, headers, shared) {
  const { archived, members } = shared ?? rules(ctx, headers)
  const childrenOf = childIndex(headers)
  const order = [], refused = [], seen = new Set([id]), queue = [{ id, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
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

/**
 * The one removal transaction. `targets` are already authorised by the caller; this only
 * resolves, locks, isolates and cleans up, rolling metadata back if any step fails.
 * A target without a log is not an error: its metadata entry is still removed, which is
 * the only way a stale record can ever be cleaned up.
 */
async function runRemoval(ctx, targets, options) {
  const registry = ctx.workspaceRegistry, backend = ctx.sessionPersistence
  const root = await realpath(backend.root)
  const resolved = []
  for (const entry of targets) {
    const location = await locate(backend, entry.id)
    if (location) await validateLocation(root, location)
    resolved.push({ ...entry, location })
  }
  // Keep new writers out while the transaction owns these ids (ghost ids included).
  options.fence?.(resolved.map(target => target.id))

  const leases = [], moved = [], detached = new Map(), prior = new Map()
  try {
    for (const target of resolved) if (target.location) leases.push(await backend.acquireLease(target.id, undefined, target.location.path))
    const quarantine = join(dirname(root), `${basename(root)}-deleted`)
    if (resolved.some(target => target.location)) await mkdir(quarantine, { recursive: true })
    for (const target of resolved) {
      if (!target.location) continue
      const isolated = join(quarantine, randomUUID())
      await rename(target.location.path, isolated)
      moved.push({ target, isolated })
    }
    for (const target of resolved) {
      if (registry.headers?.has(target.id)) prior.set(`header:${target.id}`, registry.headers.get(target.id))
      if (registry.sessionPaths?.has(target.id)) prior.set(`path:${target.id}`, registry.sessionPaths.get(target.id))
      if (registry.invalidSessionPaths?.has(target.id)) prior.set(`invalid:${target.id}`, registry.invalidSessionPaths.get(target.id))
    }
    for (const workspace of registry.list()) {
      let snapshot
      for (const target of resolved) {
        if (!workspace.sessionIds.includes(target.id)) continue
        snapshot ??= [...workspace.sessionIds]
        await workspace.detachSession(target.id)
      }
      if (snapshot) detached.set(workspace, snapshot)
    }
    const removed = new Set(resolved.map(target => target.id))
    for (const target of resolved) {
      registry.headers?.delete(target.id)
      registry.sessionPaths?.delete(target.id)
      registry.invalidSessionPaths?.delete(target.id)
    }
    const state = registry.requireState()
    await registry.setState({ ...state, pinnedSessionIds: state.pinnedSessionIds.filter(value => !removed.has(value)), archivedSessionIds: state.archivedSessionIds.filter(value => !removed.has(value)) })
  } catch (error) {
    // Failed metadata cleanup must not silently destroy the only remaining log.
    if (moved.length) {
      try {
        for (const { target, isolated } of moved) await rename(isolated, target.location.path)
        for (const [key, value] of prior) {
          const [kind, sessionId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
          if (kind === 'header') registry.headers?.set(sessionId, value)
          if (kind === 'path') registry.sessionPaths?.set(sessionId, value)
          if (kind === 'invalid') registry.invalidSessionPaths?.set(sessionId, value)
        }
        for (const [workspace, ids] of detached) await workspace.mutate(record => ({ ...record, sessionIds: ids }))
      } catch { throw fail(t('delete-incomplete'), 500) }
    }
    throw error
  } finally { for (const lease of leases) await lease.release() }
  // Metadata is committed (a failure above threw before reaching here). Announce the
  // removal now so no client keeps a stale sidebar row, then drop the quarantine copy.
  announceRemoved(ctx, resolved.map(target => target.id))
  // No computed user path reaches rm: every isolated entry is a fresh UUID under our quarantine.
  const warnings = []
  for (const { target, isolated } of moved) {
    try { await rm(isolated, { recursive: true, force: false }) }
    catch { warnings.push(t('quarantine-failed', { id: target.id })) }
  }
  return { removed: resolved.length, ghosts: resolved.filter(target => !target.location).length, warnings }
}

/**
 * Permanent deletion of one archived session, optionally together with the hidden subagent
 * sessions below it.
 */
export async function deleteArchived(ctx, id, options = {}) {
  const budget = options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS
  return ctx.workspaceRegistry.enqueueOperation(() => withDeadline(deleteArchivedLocked(ctx, id, options), budget))
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
  return ctx.workspaceRegistry.enqueueOperation(() => withDeadline(deleteOrphansLocked(ctx, ids, options), budget))
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
        deleteOne: (id, options) => deleteArchived(ctx, id, options),
      })
      if (!dryRun) {
        try { await saveLastRun(report, file) } catch (error) { ctx.logger?.warn('archived-sessions: cleanup status write failed: %s', error?.message ?? String(error)) }
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
      if (body?.action === 'deleteOrphans') {
        const ids = body?.sessionIds
        if (!Array.isArray(ids) || ids.length > 500) throw fail(t('ids-invalid'), 400)
        for (const value of ids) if (invalidSessionId(value)) throw fail(t('id-invalid'), 400)
        const reserved = new Set()
        for (const value of ids) { if (locks.has(value)) throw fail(t('busy')); locks.add(value); reserved.add(value) }
        try { json(res, 200, { ok: true, ...await deleteOrphans(ctx, ids, { fence: next => { for (const value of next) { locks.add(value); reserved.add(value) } } }) }) }
        finally { for (const value of reserved) locks.delete(value) }
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
      const id = body?.sessionId
      // SessionId is an opaque host identity, not a filename (IM ids contain ':' and '@').
      // Deletion resolves it through the backend and independently validates the real directory.
      if (invalidSessionId(id)) throw fail(t('id-invalid'), 400)
      if (!['restore', 'delete'].includes(body.action)) throw fail(t('action-invalid'), 400)
      if (locks.has(id)) throw fail(t('busy'))
      const reserved = new Set([id])
      locks.add(id)
      try {
        if (body.action === 'restore') {
          await ctx.workspaceRegistry.unarchiveSession(id)
          json(res, 200, { ok: true, restored: true })
          return
        }
        const result = await deleteArchived(ctx, id, { cascade: body.cascade === true, expect: Array.isArray(body.children) ? body.children : undefined, fence: ids => { for (const value of ids) { locks.add(value); reserved.add(value) } } })
        json(res, 200, { ok: true, ...result })
      } finally { for (const value of reserved) locks.delete(value) }
    } catch (error) { ctx.logger.warn('archived-sessions: %s', error.message); json(res, error.status ?? 500, { ok: false, error: error.status ? error.message : t('internal') }) }
  } }), 'archived-sessions management endpoint')
}
