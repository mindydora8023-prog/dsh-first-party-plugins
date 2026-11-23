/**
 * HTTP route dispatcher, writer fence, and background auto-cleanup scheduler
 * for the archived-sessions Cordis plugin.
 *
 * ASCII only: user-facing refusal strings live in lib/reasons.js.
 */

import { reason as t } from './reasons.js'
import { isLoopbackAddress, readBoundedJson, sendJson } from './http-utils.js'
import { fail, invalidSessionId } from './planner.js'
import { cleanupFile, loadCleanup, saveCleanupConfig, saveLastRun, runAutoCleanup } from './cleanup.js'
import {
  deleteArchived,
  deleteOrphans,
  inspectArchived,
  inspectOrphans,
  listArchivedInventory,
} from './transaction.js'
import { listRecycle, restoreRecycle, purgeExpiredRecycle } from './recycle.js'

const ENDPOINT = '/archived-sessions/manage'
const MAX_BODY_BYTES = 64 * 1024
const BODY_TIMEOUT_MS = 10000

/** One hour in ms; fixed because a day threshold is the only thing users tune. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** Delay before the first pass so host startup is never blocked by cleanup I/O. */
const STARTUP_DELAY_MS = 90 * 1000

function sameOrigin(req) {
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  if (origin === undefined) return isLoopbackAddress(req.socket?.remoteAddress)
  try {
    return new URL(origin).origin === `${req.socket?.encrypted ? 'https' : 'http'}://${host}`
  } catch {
    return false
  }
}

async function readRequestBody(req, signal) {
  try {
    return await readBoundedJson(req, { maxBytes: MAX_BODY_BYTES, timeoutMs: BODY_TIMEOUT_MS, signal })
  } catch (error) {
    if (error?.status === 413) throw fail(t('body-too-large'), 413)
    if (error?.status === 400) throw fail(t('body-malformed'), 400)
    throw error
  }
}

function defaultRecycleDaysOf(baseConfig) {
  const raw = baseConfig?.recycleDays
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 7
}

export function apply(ctx, config) {
  const locks = new Set()
  const fence = (ids) => {
    if (ids.some((id) => locks.has(id))) throw fail(t('busy'))
    for (const id of ids) locks.add(id)
    return () => {
      for (const id of ids) locks.delete(id)
    }
  }
  const baseConfig = config && typeof config === 'object' ? config : {}
  const lifecycle = new AbortController()
  let sweeping = false

  ctx.effect(() => () => {
    lifecycle.abort()
  }, 'archived-sessions lifecycle')

  /** Read-only preview never locks or collides with an in-flight destructive sweep. */
  const previewSweep = async () => {
    const file = cleanupFile()
    const state = await loadCleanup(file, baseConfig)
    return runAutoCleanup(ctx, {
      now: Date.now(),
      days: state.config.days,
      dryRun: true,
      reason: 'manual',
      signal: lifecycle.signal,
    })
  }

  /**
   * Run one destructive cleanup pass against the live context. Config is re-read
   * from disk on every pass so an enabled/days change in Settings applies without
   * a restart. Manual runs ignore the enabled switch (the user clicked the button).
   */
  const sweep = async (reason) => {
    if (lifecycle.signal.aborted) return { aborted: true }
    if (sweeping) return { busy: true }
    sweeping = true
    try {
      const file = cleanupFile()
      const state = await loadCleanup(file, baseConfig)
      if (reason !== 'manual' && !state.config.enabled) return { disabled: true }
      const report = await runAutoCleanup(ctx, {
        now: Date.now(),
        days: state.config.days,
        dryRun: false,
        reason,
        signal: lifecycle.signal,
        deleteOne: (id, options) => deleteArchived(ctx, id, { ...options, fence }),
      })
      if (!lifecycle.signal.aborted) {
        try {
          await saveLastRun(report, file)
        } catch (error) {
          ctx.logger?.warn('archived-sessions: cleanup status write failed: %s', error?.message ?? String(error))
        }
        try {
          await purgeExpiredRecycle(ctx, defaultRecycleDaysOf(baseConfig))
        } catch (error) {
          ctx.logger?.warn('archived-sessions: recycle purge failed: %s', error?.message ?? String(error))
        }
      }
      return report
    } finally {
      sweeping = false
    }
  }

  // Background sweep: one deferred startup pass, then hourly. Timers are unref'd
  // so they never keep the process alive, and `ctx.effect` disposes them on unload.
  ctx.effect(() => {
    const guard = (error) => ctx.logger?.warn('archived-sessions: cleanup failed: %s', error?.message ?? String(error))
    const initial = setTimeout(() => { sweep('startup').catch(guard) }, STARTUP_DELAY_MS)
    const timer = setInterval(() => { sweep('scheduled').catch(guard) }, SWEEP_INTERVAL_MS)
    if (typeof initial.unref === 'function') initial.unref()
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, 'archived-sessions auto cleanup')

  // Fence new writers while the asynchronous delete transaction owns an id.
  ctx.effect(() => {
    const backend = ctx.sessionPersistence
    const original = backend.open
    if (typeof original !== 'function') return () => {}
    const guarded = function (id, ...args) {
      if (locks.has(id)) return Promise.reject(fail(t('delete-in-progress')))
      return original.call(this, id, ...args)
    }
    backend.open = guarded
    return () => {
      if (backend.open === guarded) backend.open = original
    }
  }, 'archived-sessions writer fence')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ENDPOINT,
    handler: async (req, res) => {
      try {
        if (ctx.connection.requestRejection(req) !== undefined || !sameOrigin(req)) {
          throw fail(t('untrusted-origin'), 403)
        }
        if (
          req.method !== 'POST'
          || req.headers?.['x-archived-sessions-action'] !== 'manage'
          || !/^application\/json(?:;.*)?$/i.test(req.headers?.['content-type'] ?? '')
        ) {
          throw fail(t('unsupported-request'), 400)
        }

        const body = await readRequestBody(req, lifecycle.signal)
        const reply = (payload) => sendJson(res, 200, payload, { method: req.method })

        if (body?.action === 'inspect') {
          const ids = body?.sessionIds
          if (!Array.isArray(ids) || ids.length > 500) throw fail(t('ids-invalid'), 400)
          for (const value of ids) if (invalidSessionId(value)) throw fail(t('id-invalid'), 400)
          reply({ ok: true, items: await inspectArchived(ctx, ids) })
          return
        }
        if (body?.action === 'orphans') {
          reply({ ok: true, ...await inspectOrphans(ctx) })
          return
        }
        if (body?.action === 'export') {
          reply({ ok: true, ...await listArchivedInventory(ctx) })
          return
        }
        if (body?.action === 'recycleList') {
          reply({ ok: true, items: await listRecycle(ctx) })
          return
        }
        if (body?.action === 'recycleRestore') {
          const sid = body?.sessionId
          if (invalidSessionId(sid)) throw fail(t('id-invalid'), 400)
          reply({ ok: true, ...await restoreRecycle(ctx, sid, { fence }) })
          return
        }
        if (body?.action === 'recyclePurge') {
          let days
          if (body?.days === undefined) {
            days = defaultRecycleDaysOf(baseConfig)
          } else if (Number.isInteger(body.days) && body.days >= 0 && body.days <= 3650) {
            days = body.days
          } else {
            throw fail(t('cleanup-config-invalid'), 400)
          }
          reply({ ok: true, ...await purgeExpiredRecycle(ctx, days) })
          return
        }
        if (body?.action === 'deleteOrphans') {
          const ids = body?.sessionIds
          if (!Array.isArray(ids) || ids.length > 500) throw fail(t('ids-invalid'), 400)
          for (const value of ids) if (invalidSessionId(value)) throw fail(t('id-invalid'), 400)
          reply({ ok: true, ...await deleteOrphans(ctx, ids, { fence }) })
          return
        }
        if (body?.action === 'cleanupStatus') {
          const state = await loadCleanup(cleanupFile(), baseConfig)
          reply({ ok: true, cleanup: { enabled: state.config.enabled, days: state.config.days, lastRun: state.lastRun } })
          return
        }
        if (body?.action === 'setCleanup') {
          const enabled = body?.enabled
          const days = body?.days
          if (typeof enabled !== 'boolean' || !Number.isInteger(days) || days < 1 || days > 3650) {
            throw fail(t('cleanup-config-invalid'), 400)
          }
          const saved = await saveCleanupConfig({ enabled, days }, cleanupFile(), baseConfig)
          reply({ ok: true, cleanup: { enabled: saved.enabled, days: saved.days } })
          return
        }
        if (body?.action === 'runCleanup') {
          const report = await sweep('manual')
          if (report?.busy) throw fail(t('busy'), 409)
          reply({ ok: true, report })
          return
        }
        if (body?.action === 'previewCleanup') {
          const report = await previewSweep()
          const ids = Array.isArray(report.deletedIds) ? report.deletedIds.slice(0, 500) : []
          reply({
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
        if (!['restore', 'delete'].includes(body?.action)) throw fail(t('action-invalid'), 400)
        if (body.action === 'restore') {
          await ctx.workspaceRegistry.unarchiveSession(id) // The host method holds the same registry queue.
          reply({ ok: true, restored: true })
          return
        }
        const result = await deleteArchived(ctx, id, {
          cascade: body.cascade === true,
          recycle: body.recycle === true || baseConfig.recycle === true,
          expect: Array.isArray(body.children) ? body.children : undefined,
          fence,
        })
        reply({ ok: true, ...result })
      } catch (error) {
        const message = error?.message ?? String(error)
        ctx.logger?.warn('archived-sessions: %s', message)
        const status = typeof error?.status === 'number' ? error.status : 500
        const payload = { ok: false, error: error?.status ? message : t('internal') }
        if (typeof error?.effectState === 'string') payload.effectState = error.effectState
        if (typeof error?.retry === 'string') payload.retry = error.retry
        sendJson(res, status, payload, { method: req.method })
      }
    },
  }), 'archived-sessions management endpoint')
}
