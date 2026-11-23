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
 * ASCII only: user-facing text is rendered by the client locale dictionary.
 */

import { stat } from 'node:fs/promises'

import { statePath } from './state-dir.js'
import {
  DEFAULT_MAX_JSON_BYTES,
  enqueueFileWrite,
  readJsonFileBoundedSync,
  writeJsonAtomicSync,
} from './json-store.js'

/** Defaults; a config file (or UI change) overrides them. */
export const DEFAULT_CLEANUP = Object.freeze({ enabled: true, days: 5 })

/** Maximum number of deleted ids or failures persisted into cleanup.json. */
export const MAX_PERSISTED_ITEMS = 200

/** Maximum failure message length persisted into cleanup.json. */
const MAX_FAILURE_MESSAGE_CHARS = 500

/** A day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000

/** How many log stats a sweep may have in flight. */
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

function clampDays(value, fallback = DEFAULT_CLEANUP.days) {
  const raw = Number(value)
  let days = Number.isFinite(raw) ? Math.floor(raw) : fallback
  if (days < 1) days = 1
  if (days > 3650) days = 3650
  return days
}

/**
 * Merge an arbitrary stored value over defaults and clamp it.
 * @param {unknown} value
 * @param {{ enabled?: boolean, days?: number }} [defaults]
 * @returns {{ enabled: boolean, days: number }}
 */
export function normalizeCleanup(value, defaults = DEFAULT_CLEANUP) {
  const source = value && typeof value === 'object' ? value : {}
  const baseEnabled = typeof defaults?.enabled === 'boolean' ? defaults.enabled : DEFAULT_CLEANUP.enabled
  const baseDays = defaults && defaults !== DEFAULT_CLEANUP && defaults.days !== undefined
    ? clampDays(defaults.days, DEFAULT_CLEANUP.days)
    : DEFAULT_CLEANUP.days
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : baseEnabled
  const days = source.days !== undefined ? clampDays(source.days, baseDays) : baseDays
  return { enabled, days }
}

function readRawCleanup(file) {
  const parsed = readJsonFileBoundedSync(file, { maxBytes: DEFAULT_MAX_JSON_BYTES, fallback: {} })
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/**
 * Cap variable-length arrays in lastRun so cleanup.json stays tiny and can
 * never exceed the bounded read ceiling and lose the user's saved config.
 */
export function boundLastRun(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return null
  const out = { ...lastRun }
  if (Array.isArray(lastRun.deletedIds)) {
    out.deletedIdsTotal = lastRun.deletedIds.length
    out.deletedIds = lastRun.deletedIds
      .slice(0, MAX_PERSISTED_ITEMS)
      .map((id) => String(id))
  }
  if (Array.isArray(lastRun.failures)) {
    out.failuresTotal = lastRun.failures.length
    out.failures = lastRun.failures
      .slice(0, MAX_PERSISTED_ITEMS)
      .map((entry) => ({
        id: String(entry?.id ?? ''),
        status: typeof entry?.status === 'number' ? entry.status : null,
        message: String(entry?.message ?? '').slice(0, MAX_FAILURE_MESSAGE_CHARS),
      }))
  }
  return out
}

/**
 * Read the persisted cleanup state.
 * @param {string} [file]
 * @param {{ enabled?: boolean, days?: number }} [defaults]
 * @returns {Promise<{ config: { enabled: boolean, days: number }, lastRun: object|null }>}
 */
export async function loadCleanup(file = cleanupFile(), defaults = DEFAULT_CLEANUP) {
  const raw = readRawCleanup(file)
  const storedConfig = raw.config && typeof raw.config === 'object' ? raw.config : undefined
  const config = normalizeCleanup(storedConfig, defaults)
  const lastRun = raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : null
  return { config, lastRun }
}

/**
 * Persist a partial config change, preserving any recorded lastRun.
 * @param {object} patch
 * @param {string} [file]
 * @param {{ enabled?: boolean, days?: number }} [defaults]
 * @returns {Promise<{ enabled: boolean, days: number }>} the saved, normalized config.
 */
export async function saveCleanupConfig(patch, file = cleanupFile(), defaults = DEFAULT_CLEANUP) {
  return enqueueFileWrite(file, async () => {
    const raw = readRawCleanup(file)
    const current = normalizeCleanup(raw.config, defaults)
    const config = normalizeCleanup({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) }, defaults)
    const lastRun = raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : null
    writeJsonAtomicSync(file, { version: 1, config, lastRun })
    return config
  })
}

/**
 * Persist the outcome of one sweep, preserving any explicit user config without
 * synthesizing default config fields over baseConfig precedence.
 * @param {object} lastRun
 * @param {string} [file]
 */
export async function saveLastRun(lastRun, file = cleanupFile()) {
  return enqueueFileWrite(file, async () => {
    const raw = readRawCleanup(file)
    const payload = { version: 1, lastRun: boundLastRun(lastRun) }
    if (raw.config && typeof raw.config === 'object') {
      payload.config = raw.config
    }
    writeJsonAtomicSync(file, payload)
  })
}

/** The activity time to compare against the cutoff, or undefined when unknown. */
function lastActivityOf(createdAt, mtimeMs) {
  const values = [createdAt, mtimeMs].filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!values.length) return undefined
  return Math.max(...values)
}

function isCancelled(options) {
  return Boolean(options?.signal?.aborted || options?.isDisposed?.())
}

/**
 * Collect every archived session with its last-activity timestamp.
 *
 * Paths come from `findLog` on the archived ids only. Listing every session in
 * the store is the fallback for a host that has no `findLog`, because a sweep
 * runs hourly and the archive is a small slice of the store. Live sessions and
 * the registry header index fill the gaps for ghosts. Pure read: nothing is mutated.
 *
 * @param {object} ctx host context.
 * @param {number} now reference time (ms).
 * @param {number} days age threshold in days.
 * @param {{ signal?: AbortSignal, isDisposed?: () => boolean }} [options]
 * @returns {Promise<{ rows: Array<object> }>}
 */
export async function scanArchived(ctx, now, days, options = {}) {
  const registry = ctx.workspaceRegistry
  const archived = Array.isArray(registry?.archivedSessionIds) ? [...registry.archivedSessionIds] : []
  const cutoff = now - days * DAY_MS

  if (isCancelled(options)) return { rows: [] }

  const headers = new Map()
  const paths = new Map()
  const backend = ctx.sessionPersistence
  // One lookup per archived id. `list()` walks the whole session store, which is
  // the wrong cost for an hourly sweep that only needs this id set.
  if (typeof backend?.findLog === 'function') {
    await mapLimited(archived, STAT_CONCURRENCY, async (id) => {
      if (isCancelled(options)) return
      try {
        const selected = await backend.findLog(id)
        const file = typeof selected?.currentPath === 'string' && selected.currentPath !== ''
          ? selected.currentPath
          : selected?.location?.path
        if (typeof file === 'string' && file !== '') paths.set(id, file)
        const header = selected?.header
        if (typeof header?.id === 'string' && !headers.has(header.id)) headers.set(header.id, header)
      } catch {
        /* a missing log is a ghost; the registry header decides its age */
      }
    })
  } else if (typeof backend?.list === 'function') {
    try {
      for (const item of await backend.list()) {
        const header = item?.header ?? item
        if (typeof header?.id !== 'string') continue
        if (!headers.has(header.id)) headers.set(header.id, header)
        const filePath = item?.location?.path
        if (typeof filePath === 'string' && !paths.has(header.id)) paths.set(header.id, filePath)
      }
    } catch {
      /* listing failure leaves timestamps unknown; those sessions are skipped */
    }
  }
  if (isCancelled(options)) return { rows: [] }

  for (const item of (typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : [])) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !headers.has(header.id)) headers.set(header.id, header)
  }
  const registryHeaders = registry?.headers

  const rows = await mapLimited(archived, STAT_CONCURRENCY, async (id) => {
    if (isCancelled(options)) return { id, state: 'aborted' }
    const live = Boolean(ctx.sessions?.get?.(id) ?? ctx.get?.('agents')?.get?.(id))
    if (live) return { id, state: 'live' }

    const header = headers.get(id) ?? (registryHeaders && typeof registryHeaders.get === 'function' ? registryHeaders.get(id) : undefined)
    const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : undefined

    let mtimeMs
    const filePath = paths.get(id)
    if (typeof filePath === 'string') {
      try { mtimeMs = (await stat(filePath)).mtimeMs } catch { mtimeMs = undefined }
    }

    const lastActivity = lastActivityOf(createdAt, mtimeMs)
    if (lastActivity === undefined) return { id, state: 'unknown-age' }
    if (lastActivity >= cutoff) return { id, state: 'recent', lastActivity }
    return { id, state: 'eligible', lastActivity }
  })
  return { rows: rows.filter((row) => row && row.state !== 'aborted') }
}

/** Empty result counters shared by every sweep return value. */
function emptyReport(reason, dryRun) {
  return {
    at: Date.now(),
    reason,
    dryRun,
    scanned: 0,
    live: 0,
    recent: 0,
    unknownAge: 0,
    eligible: 0,
    deleted: 0,
    removed: 0,
    children: 0,
    ghosts: 0,
    blocked: 0,
    errors: 0,
    deletedIds: [],
    failures: [],
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
 * @param {AbortSignal} [options.signal] abort signal cancelling in-flight sweeps.
 * @param {() => boolean} [options.isDisposed] disposal predicate cancelling in-flight sweeps.
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
  // Callers (the settings preview) need the threshold that produced `eligible`.
  report.days = days

  if (isCancelled(options)) {
    report.aborted = true
    return report
  }

  const { rows } = await scanArchived(ctx, now, days, options)
  if (isCancelled(options)) {
    report.aborted = true
    return report
  }

  report.scanned = rows.length
  const eligible = []
  for (const row of rows) {
    if (row.state === 'live') report.live += 1
    else if (row.state === 'recent') report.recent += 1
    else if (row.state === 'unknown-age') report.unknownAge += 1
    else if (row.state === 'eligible') eligible.push(row)
  }
  report.eligible = eligible.length
  if (dryRun || typeof deleteOne !== 'function') {
    report.deletedIds = eligible.map((row) => row.id)
    return report
  }

  for (const row of eligible) {
    if (isCancelled(options)) {
      report.aborted = true
      break
    }
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
