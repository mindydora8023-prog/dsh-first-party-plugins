/**
 * Transactional deletion, inspection, and inventory for archived sessions.
 *
 * All destructive filesystem/registry mutations run inside the host's
 * `workspaceRegistry.enqueueOperation` queue under a finite deadline (`withDeadline`),
 * with quarantine isolation, lease holding, writer fencing, and full rollback.
 *
 * ASCII only: user-facing refusal strings live in lib/reasons.js.
 */

import { dirname, relative, resolve, join, basename } from 'node:path'
import { lstat, realpath, rename, rm, mkdir, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { reason as t } from './reasons.js'
import { mapLimited, STAT_CONCURRENCY } from './cleanup.js'
import {
  fail,
  isLive,
  snapshotHeaders,
  rules,
  planDeletion,
  planOrphans,
  refusalMessage,
  referenceMessage,
  orphanRefusalMessage,
} from './planner.js'

/** Default budget for one delete transaction. Overridable per call. */
export const DEFAULT_DELETE_TIMEOUT_MS = 30000

export const recycleDirOf = (root) => join(dirname(root), `${basename(root)}-recycle`)
export const quarantineDirOf = (root) => join(dirname(root), `${basename(root)}-deleted`)
export const quarantineId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

/** A stable-enough identity for a workspace record (used by recycle restore). */
export function workspaceKeyOf(workspace, index) {
  if (workspace && typeof workspace === 'object') {
    for (const field of ['path', 'id', 'title']) {
      const value = workspace[field]
      if (typeof value === 'string' && value !== '') return `${field}:${value}`
    }
  }
  return `index:${index}`
}

export async function statIfPresent(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

export async function ownedDirectory(dirPath) {
  const info = await statIfPresent(dirPath)
  if (!info) return false
  if (!info.isDirectory() || relative(dirPath, await realpath(dirPath)) !== '') {
    throw fail(t('storage-invalid'))
  }
  return true
}

export async function createOwnedDirectory(dirPath) {
  if (await ownedDirectory(dirPath)) return false
  await mkdir(dirPath)
  return true
}

/**
 * Run a delete transaction under a deadline.
 *
 * The failure is reported as a TIMEOUT with status 504 and carries
 * `effectState: 'unknown'` and `retry: 'never'`, telling callers to
 * refresh and re-inspect rather than blindly retrying.
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
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

export function enqueueMutation(ctx, operation, budget = DEFAULT_DELETE_TIMEOUT_MS) {
  let expired = false
  const queued = ctx.workspaceRegistry.enqueueOperation(() => {
    // A request that expired while waiting must not start later. A running
    // transaction retains the host queue and its writer fence until it settles.
    if (!expired) return operation()
  })
  return withDeadline(queued, budget).catch((error) => {
    expired = error?.status === 504
    throw error
  })
}

/** Resolve one stored session's directory without trusting the id: the backend decides the path. */
export async function locate(backend, id) {
  const selected = await backend.findLog(id)
  if (!selected) return undefined
  const raw = dirname(selected.currentPath)
  return { raw, path: await realpath(raw) }
}

export async function validateLocation(root, location) {
  const rel = relative(root, location.path)
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== location.path || rel.split(/[\\/]/).length !== 2) {
    throw fail(t('storage-invalid'))
  }
  if ((await lstat(location.raw)).isSymbolicLink()) {
    throw fail(t('storage-invalid'))
  }
}

export async function assertParentIdle(ctx, id) {
  if (isLive(ctx, id)) throw fail(t('session-live'))
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, async () => [])
  if (activity.length) throw fail(t('session-activity'))
}

/**
 * Tell connected clients that these stored sessions no longer exist so the
 * sidebar and archived list stay consistent after background or manual deletes.
 */
function announceRemoved(ctx, ids) {
  if (typeof ctx.emit !== 'function') return
  for (const id of ids) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      ctx.logger?.warn('archived-sessions: removal notification failed for %s: %s', id, error?.message ?? String(error))
    }
  }
}

const registryFields = {
  header: 'headers',
  sessionPath: 'sessionPaths',
  invalidSessionPath: 'invalidSessionPaths',
}

export function snapshotEntries(registry, id) {
  return Object.entries(registryFields).flatMap(([field, key]) => {
    const map = registry[key]
    return map ? [{ field, map, present: map.has(id), value: map.get(id) }] : []
  })
}

export function restoreEntries(id, entries) {
  for (const { map, present, value } of entries) {
    if (present) map.set(id, value)
    else map.delete(id)
  }
}

export function snapshotState(registry) {
  const state = registry.requireState()
  return {
    ...state,
    archivedSessionIds: [...state.archivedSessionIds],
    pinnedSessionIds: [...state.pinnedSessionIds],
  }
}

export const sameIds = (left, right) => (
  left.length === right.length && left.every((id, index) => id === right[index])
)

export async function restoreState(registry, before) {
  const current = registry.requireState()
  if (
    !sameIds(current.archivedSessionIds, before.archivedSessionIds)
    || !sameIds(current.pinnedSessionIds, before.pinnedSessionIds)
  ) {
    await registry.setState(before)
  }
}

export async function rollback(ctx, steps) {
  let complete = true
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (error) {
      complete = false
      ctx.logger?.warn('archived-sessions: rollback step failed: %s', error?.message ?? String(error))
    }
  }
  return complete
}

async function writeRecycleSnapshot(filePath, record, onCreate) {
  const file = await open(filePath, 'wx')
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
export async function runRemoval(ctx, targets, options) {
  const registry = ctx.workspaceRegistry
  const backend = ctx.sessionPersistence
  const root = await realpath(backend.root)
  const removed = new Set(targets.map((target) => target.id))
  const releaseFence = options.fence?.([...removed])
  const leases = []
  const undo = []
  const warnings = []
  const files = []
  const quarantine = quarantineDirOf(root)
  const recycleRoot = recycleDirOf(root)
  const recycle = options.recycle === true
  let committed = false
  try {
    for (const id of removed) {
      if (isLive(ctx, id)) throw fail(t('session-live'))
      const location = await locate(backend, id)
      if (!location) continue
      await validateLocation(root, location)
      const key = randomUUID()
      files.push({
        id,
        location,
        isolated: join(quarantine, key),
        sidecar: join(recycleRoot, `${key}.json`),
        moved: false,
      })
    }
    for (const { id, location } of files) {
      leases.push(await backend.acquireLease(id, undefined, location.path))
    }
    const before = snapshotState(registry)
    const prior = new Map([...removed].map((id) => [id, snapshotEntries(registry, id)]))
    const workspaces = [...registry.list()]
      .map((workspace, index) => ({
        workspace,
        key: workspaceKeyOf(workspace, index),
        sessionIds: [...workspace.sessionIds],
      }))
      .filter(({ sessionIds }) => sessionIds.some((id) => removed.has(id)))

    if (files.length) await createOwnedDirectory(quarantine)
    if (recycle && files.length) {
      await createOwnedDirectory(recycleRoot)
      const removedAt = Date.now()
      for (const file of files) {
        const { id, location, isolated, sidecar } = file
        const entries = Object.fromEntries(prior.get(id).map(({ field, value }) => [field, value ?? null]))
        await writeRecycleSnapshot(
          sidecar,
          {
            ...entries,
            version: 2,
            id,
            originalPath: location.path,
            isolatedPath: isolated,
            removedAt,
            archived: before.archivedSessionIds.includes(id),
            pinned: before.pinnedSessionIds.includes(id),
            workspaces: workspaces
              .filter(({ sessionIds }) => sessionIds.includes(id))
              .map(({ key, sessionIds }) => ({ key, sessionIds })),
          },
          () => undo.push(() => {
            // A failed move back still needs the snapshot for recovery.
            if (!file.moved) return rm(sidecar, { force: true })
          }),
        )
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
      undo.push(() => workspace.mutate((record) => (
        sameIds(record.sessionIds, sessionIds) ? record : { ...record, sessionIds }
      )))
      for (const id of sessionIds) {
        if (removed.has(id)) await workspace.detachSession(id)
      }
    }
    for (const [id, entries] of prior) {
      undo.push(() => restoreEntries(id, entries))
      for (const { map } of entries) map.delete(id)
    }
    undo.push(() => restoreState(registry, before))
    await registry.setState({
      ...before,
      pinnedSessionIds: before.pinnedSessionIds.filter((id) => !removed.has(id)),
      archivedSessionIds: before.archivedSessionIds.filter((id) => !removed.has(id)),
    })

    committed = true
  } catch (error) {
    if (!await rollback(ctx, undo)) throw fail(t('delete-incomplete'), 500)
    throw error
  } finally {
    try {
      for (const lease of leases) {
        try {
          await lease.release()
        } catch (error) {
          ctx.logger?.warn('archived-sessions: lease release failed: %s', error?.message ?? String(error))
        }
      }
      if (committed) {
        announceRemoved(ctx, [...removed])
        if (!recycle) {
          for (const { id, isolated } of files) {
            try {
              await rm(isolated, { recursive: true, force: false })
            } catch {
              warnings.push(t('quarantine-failed', { id }))
            }
          }
        }
      }
    } finally {
      releaseFence?.()
    }
  }
  return { removed: removed.size, ghosts: removed.size - files.length, warnings }
}

async function deleteArchivedLocked(ctx, id, options) {
  const registry = ctx.workspaceRegistry
  const backend = ctx.sessionPersistence
  if (!registry.archivedSessionIds.includes(id)) throw fail(t('not-archived'))
  if (typeof backend.findLog !== 'function' || typeof backend.acquireLease !== 'function' || typeof backend.root !== 'string') {
    throw fail(t('backend-unsupported'))
  }
  await assertParentIdle(ctx, id)

  const headers = await snapshotHeaders(ctx)
  const shared = rules(ctx, headers)
  const plan = planDeletion(ctx, id, headers, shared)
  if (plan.refused.length) throw fail(refusalMessage(plan.refused))
  if (plan.order.length && options.cascade !== true) throw fail(referenceMessage(plan.order))
  // The page sends the exact descendant list it showed the user; a session that appeared in
  // between must never be deleted by a confirmation that never listed it.
  if (options.expect !== undefined) {
    const expected = new Set(Array.isArray(options.expect) ? options.expect.filter((value) => typeof value === 'string') : [])
    const planned = new Set(plan.order.map((child) => child.id))
    if (expected.size !== planned.size || [...planned].some((value) => !expected.has(value))) {
      throw fail(t('cascade-mismatch'))
    }
  }

  const result = await runRemoval(ctx, [{ id, depth: 0 }, ...plan.order], options)
  const body = { deleted: true, removed: result.removed, children: plan.order.length, ghosts: result.ghosts }
  if (result.warnings.length) body.warning = result.warnings.join('\n')
  return body
}

/**
 * Permanent deletion of one archived session, optionally together with the hidden subagent
 * sessions below it.
 */
export async function deleteArchived(ctx, id, options = {}) {
  const budget = options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS
  return enqueueMutation(ctx, () => deleteArchivedLocked(ctx, id, options), budget)
}

async function deleteOrphansLocked(ctx, ids, options) {
  const backend = ctx.sessionPersistence
  if (!ids.length) return { deleted: true, removed: 0, ghosts: 0 }
  if (typeof backend.findLog !== 'function' || typeof backend.acquireLease !== 'function' || typeof backend.root !== 'string') {
    throw fail(t('backend-unsupported'))
  }
  const headers = await snapshotHeaders(ctx)
  const plan = planOrphans(ctx, headers)
  const allowed = new Map(plan.orphans.map((item) => [item.id, item]))
  const blocked = plan.blocked.filter((item) => ids.includes(item.id))
  if (blocked.length) throw fail(orphanRefusalMessage(blocked))
  const stale = ids.filter((id) => !allowed.has(id))
  if (stale.length) throw fail(t('orphans-stale', { lines: stale.join('\n') }))
  const targets = ids.map((id) => ({ id, depth: 1 }))
  for (const target of targets) {
    if (isLive(ctx, target.id)) throw fail(t('session-live'))
  }
  const result = await runRemoval(ctx, targets, options)
  const body = { deleted: true, removed: result.removed, children: result.removed, ghosts: result.ghosts }
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

/** Read-only description of what a delete would do, used by the settings page. */
export async function inspectArchived(ctx, ids) {
  const headers = await snapshotHeaders(ctx)
  const shared = rules(ctx, headers)
  const findLog = typeof ctx.sessionPersistence?.findLog === 'function'
    ? (id) => ctx.sessionPersistence.findLog(id)
    : undefined

  return mapLimited(ids, STAT_CONCURRENCY, async (id) => {
    if (!shared.archived.has(id)) return { id, archived: false }
    const plan = planDeletion(ctx, id, headers, shared)
    let location
    if (findLog) {
      try {
        location = await findLog(id)
      } catch {
        location = undefined
      }
    }
    return {
      id,
      archived: true,
      hasLog: location !== undefined,
      children: plan.order.map((child) => child.id),
      blocked: plan.refused,
    }
  })
}

/** Read-only orphan report: hidden subagents whose parent log is gone. */
export async function inspectOrphans(ctx) {
  const headers = await snapshotHeaders(ctx)
  return planOrphans(ctx, headers)
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
