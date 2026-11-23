/**
 * Recycle bin listing, transactional restore, and TTL expiration purge.
 *
 * Recycled sessions are kept in `<sessions>-deleted/<uuid>` with a JSON sidecar
 * in `<sessions>-recycle/<uuid>.json`. Path validation mirrors `validateLocation`
 * so legitimate session or project directory names containing `:`, `@`, spaces,
 * or non-ASCII characters work while traversal and junctions are rejected.
 *
 * ASCII only: user-facing refusal strings live in lib/reasons.js.
 */

import { dirname, relative, resolve, join, basename, sep, isAbsolute } from 'node:path'
import { realpath, rename, rm, rmdir, readdir, readFile } from 'node:fs/promises'

import { reason as t } from './reasons.js'
import { fail } from './planner.js'
import {
  recycleDirOf,
  quarantineDirOf,
  quarantineId,
  workspaceKeyOf,
  statIfPresent,
  ownedDirectory,
  createOwnedDirectory,
  enqueueMutation,
  assertParentIdle,
  snapshotEntries,
  restoreEntries,
  snapshotState,
  restoreState,
  rollback,
} from './transaction.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Validate one path segment inside the sessions root.
 * Matches `validateLocation` safety (no empty, `.`, `..`, separators, or
 * control characters) without rejecting legitimate `:`, `@`, spaces, or UTF-8.
 */
function isValidSegment(segment) {
  return (
    typeof segment === 'string'
    && segment.length > 0
    && segment.length <= 1024
    && segment !== '.'
    && segment !== '..'
    && !/[\u0000-\u001f\u007f\\/]/.test(segment)
  )
}

export async function readRecycleRecords(ctx, { includeMissing = false } = {}) {
  const backend = ctx.sessionPersistence
  if (typeof backend?.root !== 'string') throw fail(t('backend-unsupported'))
  const root = await realpath(backend.root)
  const recycleRoot = recycleDirOf(root)
  const quarantine = quarantineDirOf(root)
  if (!await ownedDirectory(recycleRoot)) return []
  const hasQuarantine = await ownedDirectory(quarantine)
  if (!hasQuarantine && !includeMissing) return []

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

      const rel = relative(root, record.originalPath)
      if (!rel || rel.startsWith('..') || resolve(root, rel) !== record.originalPath) continue
      const segments = rel.split(sep)
      if (segments.length !== 2 || segments.some((segment) => !isValidSegment(segment))) continue
      const original = join(root, ...segments)
      if (record.originalPath !== original) continue

      // When quarantine exists, ownedDirectory(isolated) rejects junctions/symlinks
      // by throwing (caught below) even when includeMissing is true.
      const hasIsolated = hasQuarantine ? await ownedDirectory(isolated) : false
      if (!hasIsolated && !includeMissing) continue
      records.push({ record, sidecar, isolated, original })
    } catch {
      /* Ignore corrupt, symlinked, or inaccessible records. */
    }
  }
  return records.sort((left, right) => right.record.removedAt - left.record.removedAt)
}

/** Read-only list of sessions currently held in the recycle bin. */
export async function listRecycle(ctx) {
  return (await readRecycleRecords(ctx)).map(({ record, sidecar, original }) => ({
    recycleId: basename(sidecar),
    id: record.id,
    removedAt: record.removedAt,
    originalPath: original,
    archived: record.archived === true,
  }))
}

function restoreMember(ids, snapshot, id) {
  if (ids.includes(id)) return ids
  const at = snapshot.indexOf(id)
  const next = snapshot.slice(at + 1).find((value) => ids.includes(value))
  const index = next === undefined ? ids.length : ids.indexOf(next)
  return [...ids.slice(0, index), id, ...ids.slice(index)]
}

async function restoreRecycleLocked(ctx, id, options) {
  const registry = ctx.workspaceRegistry
  const backend = ctx.sessionPersistence
  const chosen = (await readRecycleRecords(ctx)).find((item) => item.record.id === id)
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
    if (!await ownedDirectory(dirname(isolated)) || !await ownedDirectory(isolated)) {
      throw fail(t('storage-invalid'))
    }
    await rename(isolated, original)
    undo.push(() => rename(original, isolated))

    const prior = snapshotEntries(registry, id)
    undo.push(() => restoreEntries(id, prior))
    for (const { map, field } of prior) {
      if (record[field] !== null && record[field] !== undefined) map.set(id, record[field])
    }
    const workspaces = new Map(
      [...registry.list()].map((workspace, index) => [workspaceKeyOf(workspace, index), workspace]),
    )
    for (const snapshot of Array.isArray(record.workspaces) ? record.workspaces : []) {
      const workspace = workspaces.get(snapshot?.key)
      if (!workspace || !Array.isArray(snapshot.sessionIds) || !snapshot.sessionIds.includes(id)) continue
      let previousIds
      undo.push(() => {
        if (previousIds) return workspace.mutate((current) => ({ ...current, sessionIds: previousIds }))
      })
      await workspace.mutate((current) => {
        const ids = restoreMember(current.sessionIds, snapshot.sessionIds, id)
        if (ids === current.sessionIds) return current
        previousIds = [...current.sessionIds]
        return { ...current, sessionIds: ids }
      })
    }
    const archived = new Set(before.archivedSessionIds)
    const pinned = new Set(before.pinnedSessionIds)
    if (record.archived === true) archived.add(id)
    if (record.pinned === true) pinned.add(id)
    undo.push(() => restoreState(registry, before))
    await registry.setState({ ...before, archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] })
    await rm(sidecar)
    return { restored: true, id, archived: record.archived === true }
  } catch (error) {
    if (!await rollback(ctx, undo)) throw fail('recycle restore rollback incomplete', 500)
    throw error
  } finally {
    releaseFence?.()
  }
}

/** Restore a recycled session within the same host queue as delete and purge. */
export async function restoreRecycle(ctx, id, options = {}) {
  return enqueueMutation(ctx, () => restoreRecycleLocked(ctx, id, options), options.timeoutMs)
}

/** Delete recycled sessions older than `days` (0 purges immediately). Returns how many were purged. */
export async function purgeExpiredRecycle(ctx, days = 7, now = Date.now()) {
  return enqueueMutation(ctx, async () => {
    const effectiveDays = Number.isFinite(days) && days >= 0 ? days : 7
    const limit = effectiveDays * DAY_MS
    let purged = 0
    for (const { record, isolated, sidecar } of await readRecycleRecords(ctx, { includeMissing: true })) {
      if (now - record.removedAt < limit) continue
      try {
        if (await ownedDirectory(dirname(isolated)) && await ownedDirectory(isolated)) {
          await rm(isolated, { recursive: true })
        }
        await rm(sidecar)
        purged += 1
      } catch (error) {
        ctx.logger?.warn('archived-sessions: recycle purge failed: %s', error?.message ?? String(error))
      }
    }
    return { purged }
  })
}
