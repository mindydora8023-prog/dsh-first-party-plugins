/**
 * Automatic cleanup for the archived-sessions plugin.
 *
 * WHY. Archived sessions accumulate forever: nothing in the host removes them,
 * and the only manual path is the Settings list. This module deletes archived
 * sessions whose LAST ACTIVITY is older than a configurable number of days
 * (default 5) in a bounded background sweep.
 *
 * AGE SOURCE. The workspace registry stores archived ids with no timestamp, so
 * "archived at" is not knowable. Instead the age is the last activity of the
 * session, taken as the LATER of:
 *   - the session log file's mtime (the last append), and
 *   - the immutable header `createdAt`.
 * A session that is old but was used recently is therefore kept. A metadata-only
 * record with no log falls back to `createdAt` (from the registry header index);
 * when no timestamp is available at all the session is skipped, never guessed.
 *
 * SAFETY. A sweep never invents a deletion path: it reuses the exact same
 * `deleteArchived` transaction as the manual UI (lease, quarantine, metadata
 * rollback) and skips anything live, recently active, or refused by the cascade
 * rules. One failing session never aborts the sweep.
 *
 * ASCII only: user-visible text is rendered by the client locale dictionary.
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { statePath } from './state-dir.js'

/** Defaults; a config file (or UI change) overrides them. */
export const DEFAULT_CLEANUP = Object.freeze({ enabled: true, days: 5 })

/** A day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000

/** How many log stats a sweep may have in flight. One stat per archived id, sequentially, made a large archive wait on the disk one file at a time. */
export const STAT_CONCURRENCY = 8

/**
 * Run `worker` over `items` with at most `limit` calls in flight.
 * Results keep the input order. A worker's rejection fails the whole call.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimited(items, limit, worker) {
  const out = new Array(items.length)
  if (items.length === 0) return out
  const lanes = Math.min(Math.max(1, limit), items.length)
  let cursor = 0
  const lane = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => lane()))
  return out
}

/**
 * Resolve the cleanup state file. Tests and alternate volumes can override it.
 * Default lives under the per-user plugin state directory, never the source tree.
 * @returns {string}
 */
export function cleanupFile() {
  const override = process.env['ARCHIVED_SESSIONS_CLEANUP_FILE']
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return statePath('archived-sessions', 'cleanup.json')
}

/**
 * Merge an arbitrary stored value over the defaults and clamp it.
 * @param {unknown} value
 * @returns {{ enabled: boolean, days: number }}
 */
export function normalizeCleanup(value) {
  const source = value && typeof value === 'object' ? value : {}
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CLEANUP.enabled
  const raw = Number(source.days)
  let days = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_CLEANUP.days
  if (days < 1) days = 1
  if (days > 3650) days = 3650
  return { enabled, days }
}

/**
 * Read the persisted cleanup state.
 * @param {string} [file]
 * @returns {Promise<{ config: { enabled: boolean, days: number }, lastRun: object|null }>}
 */
export async function loadCleanup(file = cleanupFile()) {
  let raw
  try {
    const text = await readFile(file, 'utf8')
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('cleanup state too large')
    raw = JSON.parse(text)
  } catch {
    raw = {}
  }
  const config = normalizeCleanup(raw && typeof raw === 'object' ? raw.config : undefined)
  const lastRun = raw && typeof raw === 'object' && raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : null
  return { config, lastRun }
}

/**
 * Per-file promise chain that serialises read-modify-write sequences.
 *
 * saveCleanupConfig and saveLastRun both do load -> merge -> write. A background
 * sweep (saveLastRun) and a settings change (saveCleanupConfig) can run at the
 * same time, so without a lock the second write can overwrite the first's field:
 * a user's just-saved config, or the latest sweep summary, silently disappears.
 */
const WRITE_CHAINS = new Map()
function withFileLock(file, fn) {
  const tail = WRITE_CHAINS.get(file) ?? Promise.resolve()
  const next = tail.then(() => fn())
  // Store a settled-safe tail so one rejection never poisons the next waiter.
  WRITE_CHAINS.set(file, next.catch(() => {}))
  return next
}

/** Atomic write: tmp then rename, so a crash never leaves a half file. */
async function writeState(file, value) {
  await mkdir(dirname(file), { recursive: true })
  // The tmp name carries a random suffix so two concurrent writers (different
  // pids, or the same pid before serialisation kicks in) never collide on it.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * Persist a partial config change, preserving any recorded lastRun.
 * @param {object} patch
 * @param {string} [file]
 * @returns {Promise<{ enabled: boolean, days: number }>} the saved, normalized config.
 */
export async function saveCleanupConfig(patch, file = cleanupFile()) {
  return withFileLock(file, async () => {
    const state = await loadCleanup(file)
    const config = normalizeCleanup({ ...state.config, ...(patch && typeof patch === 'object' ? patch : {}) })
    await writeState(file, { version: 1, config, lastRun: state.lastRun })
    return config
  })
}

/**
 * Persist the outcome of one sweep, preserving the config.
 * @param {object} lastRun
 * @param {string} [file]
 */
export async function saveLastRun(lastRun, file = cleanupFile()) {
  return withFileLock(file, async () => {
    const state = await loadCleanup(file)
    await writeState(file, { version: 1, config: state.config, lastRun })
  })
}

/** The activity time to compare against the cutoff, or undefined when unknown. */
function lastActivityOf(createdAt, mtimeMs) {
  const values = [createdAt, mtimeMs].filter(value => typeof value === 'number' && Number.isFinite(value))
  if (!values.length) return undefined
  return Math.max(...values)
}

/**
 * Collect every archived session with its last-activity timestamp.
 *
 * Header and log path come from one `sessionPersistence.list()` call (each
 * snapshot carries `header` and `location.path`); live sessions and the registry
 * header index fill the gaps for ghosts. Pure read: nothing is mutated.
 *
 * @param {object} ctx host context.
 * @param {number} now reference time (ms).
 * @param {number} days age threshold in days.
 * @returns {Promise<{ rows: Array<object> }>}
 */
export async function scanArchived(ctx, now, days) {
  const registry = ctx.workspaceRegistry
  const archived = Array.isArray(registry?.archivedSessionIds) ? [...registry.archivedSessionIds] : []
  const cutoff = now - days * DAY_MS

  const headers = new Map()
  const paths = new Map()
  if (typeof ctx.sessionPersistence?.list === 'function') {
    try {
      for (const item of await ctx.sessionPersistence.list()) {
        const header = item?.header ?? item
        if (typeof header?.id !== 'string') continue
        if (!headers.has(header.id)) headers.set(header.id, header)
        const path = item?.location?.path
        if (typeof path === 'string' && !paths.has(header.id)) paths.set(header.id, path)
      }
    } catch {
      /* listing failure leaves timestamps unknown; those sessions are skipped */
    }
  }
  for (const item of (typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : [])) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !headers.has(header.id)) headers.set(header.id, header)
  }
  const registryHeaders = registry?.headers

  const rows = await mapLimited(archived, STAT_CONCURRENCY, async (id) => {
    const live = Boolean(ctx.sessions?.get?.(id) ?? ctx.get?.('agents')?.get?.(id))
    if (live) return { id, state: 'live' }

    const header = headers.get(id) ?? (registryHeaders && typeof registryHeaders.get === 'function' ? registryHeaders.get(id) : undefined)
    const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : undefined

    let mtimeMs
    const path = paths.get(id)
    if (typeof path === 'string') {
      try { mtimeMs = (await stat(path)).mtimeMs } catch { mtimeMs = undefined }
    }

    const lastActivity = lastActivityOf(createdAt, mtimeMs)
    if (lastActivity === undefined) return { id, state: 'unknown-age' }
    if (lastActivity >= cutoff) return { id, state: 'recent', lastActivity }
    return { id, state: 'eligible', lastActivity }
  })
  return { rows }
}

/** Empty result counters shared by every sweep return value. */
function emptyReport(reason, dryRun) {
  return {
    at: Date.now(), reason, dryRun,
    scanned: 0, live: 0, recent: 0, unknownAge: 0,
    eligible: 0, deleted: 0, removed: 0, children: 0, ghosts: 0,
    blocked: 0, errors: 0, deletedIds: [], failures: [],
  }
}

/**
 * Run one cleanup pass.
 *
 * @param {object} ctx host context.
 * @param {object} options
 * @param {number} [options.now] reference time.
 * @param {number} [options.days] age threshold.
 * @param {boolean} [options.dryRun] report only, delete nothing.
 * @param {(id: string, opts: object) => Promise<object>} options.deleteOne
 *        the shared removal transaction (index.js passes `deleteArchived`).
 * @returns {Promise<object>} a bounded report.
 */
export async function runAutoCleanup(ctx, options) {
  const now = typeof options?.now === 'number' ? options.now : Date.now()
  const days = typeof options?.days === 'number' ? options.days : DEFAULT_CLEANUP.days
  const dryRun = options?.dryRun === true
  const deleteOne = options?.deleteOne
  const report = emptyReport(options?.reason ?? 'manual', dryRun)

  const { rows } = await scanArchived(ctx, now, days)
  report.scanned = rows.length
  const eligible = []
  for (const row of rows) {
    if (row.state === 'live') report.live += 1
    else if (row.state === 'recent') report.recent += 1
    else if (row.state === 'unknown-age') report.unknownAge += 1
    else if (row.state === 'eligible') eligible.push(row)
  }
  report.eligible = eligible.length
  if (dryRun || typeof deleteOne !== 'function') { report.deletedIds = eligible.map(row => row.id); return report }

  for (const row of eligible) {
    try {
      const result = await deleteOne(row.id, { cascade: true })
      report.deleted += 1
      report.removed += Number(result?.removed) || 0
      report.children += Number(result?.children) || 0
      report.ghosts += Number(result?.ghosts) || 0
      report.deletedIds.push(row.id)
    } catch (error) {
      const status = error && typeof error.status === 'number' ? error.status : undefined
      if (status === 409) report.blocked += 1
      else report.errors += 1
      report.failures.push({ id: row.id, status: status ?? null, message: String(error?.message ?? error) })
    }
  }
  return report
}
