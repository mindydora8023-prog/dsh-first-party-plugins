/**
 * Mount/renew/disable/TTL/hold/probe lifecycle for mcp-on-demand.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { catalogPrompt, normalizeTools, remember, rememberFailure, summaryOf } from './catalog.js'

/** How long enable waits for the host to report `connected`. */
export const READY_WAIT_MS = 8000

/** How often that wait polls the manager. */
const READY_POLL_MS = 200

/** Probe budget when the server does not set its own startup timeout. */
const DEFAULT_PROBE_MS = 20000

/**
 * One line the settings panel can show without leaking env or headers.
 *
 * @param {object | undefined} entry
 * @returns {string}
 */
export function targetOf(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (entry.transport === 'streamable-http') return typeof entry.url === 'string' ? entry.url : ''
  const command = typeof entry.command === 'string' ? entry.command : ''
  const args = Array.isArray(entry.args) ? entry.args.filter((item) => typeof item === 'string').join(' ') : ''
  return [command, args].filter(Boolean).join(' ')
}

/**
 * Create lifecycle controllers for configured MCP servers.
 *
 * @param {object} ctx cordis context
 * @param {{ servers: Record<string, {entry: object, ttlMs: number, description?: string, keywords?: string[]}>, defaultTtlMs: number, catalogFile?: string | false, maxConcurrent?: number }} config
 * @param {object} state live map, catalog, limiter, lock, disposal signal, and host manager
 */
export function createLifecycle(ctx, config, state) {
  const catalog = state.catalog || { servers: {} }
  const limit = state.limit || { run: (task) => task() }
  const lock = state.lock || ((_name, task) => task())
  const now = () => (typeof state.now === 'function' ? state.now() : Date.now())
  const isDisposed = () => Boolean((typeof state.isDisposed === 'function' && state.isDisposed()) || state.signal?.aborted)

  // Longest server names first so overlapping prefixes like "foo" and "foo_bar"
  // or names containing underscores match unambiguously.
  const configuredNames = Object.keys(config.servers || {}).sort((a, b) => b.length - a.length)

  function serverNameFromTool(toolName) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null
    for (const serverName of configuredNames) {
      if (toolName.startsWith(`mcp__${serverName}__`)) return serverName
    }
    return null
  }

  function persist() {
    if (typeof state.saveCatalog === 'function') state.saveCatalog()
  }

  function sleep(ms) {
    if (typeof state.sleep === 'function') return state.sleep(ms)
    if (ms <= 0 || isDisposed()) return Promise.resolve()
    return new Promise((resolve) => {
      const signal = state.signal
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** The host reports a status object. Older callers flattened it to a string. */
  function statusOf(found) {
    const status = found?.status
    if (typeof status === 'string') return { state: status }
    if (status && typeof status.state === 'string') return status
    if (found?.configured === true) return { state: 'configured' }
    return { state: 'unknown' }
  }

  function managerRow(name) {
    try {
      const manager = state.manager()
      const list = typeof manager.list === 'function' ? manager.list() : []
      return Array.isArray(list) ? list.find((item) => item && item.name === name) : undefined
    } catch (error) {
      return { status: { state: 'unreadable', lastError: error?.message ?? String(error) } }
    }
  }

  function managerStatus(name) {
    const row = managerRow(name)
    if (row === undefined) return 'unknown'
    const status = statusOf(row)
    return status.lastError ? `${status.state}: ${status.lastError}` : status.state
  }

  /** The tool names (and descriptions when available) a mounted server exposes. */
  function listedTools(name) {
    const prefix = `mcp__${name}__`
    try {
      const listed = typeof ctx.tools.definitions === 'function'
        ? ctx.tools.definitions()
        : typeof ctx.tools.list === 'function'
          ? ctx.tools.list({})
          : []
      const rows = Array.isArray(listed) ? listed : []
      return rows
        .map((item) => (typeof item === 'string' ? { name: item } : item))
        .filter((item) => item && typeof item.name === 'string' && item.name.startsWith(prefix))
    } catch {
      return []
    }
  }

  function toolNamesOf(name) {
    return listedTools(name).map((item) => item.name)
  }

  function unknown(name) {
    return {
      name,
      running: false,
      status: 'unknown server',
      tools: [],
      note: `No server called ${name} is configured. Call mcpod_list for the available names.`,
    }
  }

  /**
   * (Re)schedule the automatic release of a mounted server.
   *
   * @param {string} name
   * @param {number} ttlMs 0 disables the automatic release
   */
  function scheduleRelease(name, ttlMs) {
    const entry = state.live.get(name)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (isDisposed() || ttlMs <= 0) {
      entry.expiresAt = 0
      return
    }
    entry.expiresAt = now() + ttlMs
    const timer = setTimeout(() => {
      if (isDisposed()) return
      const live = state.live.get(name)
      if (live === undefined) return
      if ((live.busy || 0) > 0 || live.inFlight === true) {
        return
      }
      state.live.delete(name)
      try {
        live.dispose()
      } catch {
        /* best effort on the way out */
      }
      ctx.logger.info('mcp-on-demand: %s released after its %ss time-to-live', name, Math.round(ttlMs / 1000))
    }, ttlMs)
    if (typeof timer.unref === 'function') timer.unref()
    entry.timer = timer
  }

  /**
   * Restart the idle release timer for a mounted server.
   *
   * @param {string} toolName
   * @returns {boolean} whether a mounted server was extended
   */
  function noteActivity(toolName) {
    const serverName = serverNameFromTool(toolName)
    if (serverName === null) return false
    const entry = state.live.get(serverName)
    if (entry === undefined || !(entry.ttlMs > 0)) return false
    if ((entry.busy || 0) > 0 || entry.inFlight === true) return true
    scheduleRelease(serverName, entry.ttlMs)
    return true
  }

  /**
   * Hold the release while a call is in flight. Tracks active call count and
   * `inFlight: true` so list/health views never show a stale `ttl=0s`.
   *
   * @param {string} toolName
   * @returns {(() => void) | undefined}
   */
  function hold(toolName) {
    const serverName = serverNameFromTool(toolName)
    if (serverName === null) return undefined
    const entry = state.live.get(serverName)
    if (entry === undefined) return undefined
    entry.busy = (entry.busy || 0) + 1
    entry.inFlight = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    let released = false
    return () => {
      if (released) return
      released = true
      const live = state.live.get(serverName)
      if (live === undefined) return
      live.busy = Math.max(0, (live.busy || 1) - 1)
      live.inFlight = live.busy > 0
      if (!live.inFlight && !isDisposed() && live.ttlMs > 0) {
        scheduleRelease(serverName, live.ttlMs)
      }
    }
  }

  function requestedTtlFor(args, definition) {
    return Number.isFinite(args?.ttl_seconds) && args.ttl_seconds >= 0
      ? args.ttl_seconds * 1000
      : definition.ttlMs
  }

  function rowOf(name, definition) {
    const live = state.live.get(name)
    const running = live !== undefined
    const inFlight = running && ((live.busy || 0) > 0 || live.inFlight === true)
    let release = 'default'
    let ttlSeconds = Math.round(definition.ttlMs / 1000)
    if (running) {
      if (inFlight) {
        if (live.ttlMs > 0) {
          release = 'remaining'
          ttlSeconds = Math.max(1, Math.round(live.ttlMs / 1000))
        } else {
          release = 'off'
          ttlSeconds = 0
        }
      } else if (typeof live.expiresAt === 'number' && live.expiresAt > 0) {
        release = 'remaining'
        ttlSeconds = Math.max(0, Math.round((live.expiresAt - now()) / 1000))
      } else {
        release = 'off'
        ttlSeconds = 0
      }
    }
    const summary = summaryOf(catalog.servers[name], now())
    return {
      name,
      running,
      in_flight: inFlight,
      ttl_seconds: ttlSeconds,
      release,
      status: running ? managerStatus(name) : 'not mounted',
      transport: definition.entry.transport,
      target: targetOf(definition.entry),
      description: definition.description || '',
      tools: running ? toolNamesOf(name) : [],
      catalog: summary
        ? {
          ok: summary.ok,
          stale: summary.stale,
          toolCount: summary.toolCount,
          at: summary.at,
          error: summary.error,
          sample: summary.ok && !summary.stale
            ? summary.tools.slice(0, 6).map((tool) => tool.name).filter(Boolean)
            : [],
        }
        : null,
    }
  }

  async function waitUntilReady(name, budgetMs) {
    const deadline = now() + budgetMs
    let last = 'unknown'
    for (;;) {
      if (isDisposed()) return 'disposed'
      const status = statusOf(managerRow(name))
      last = status.lastError ? `${status.state}: ${status.lastError}` : status.state
      if (status.state === 'connected' || status.state === 'failed') return last
      if (now() >= deadline) return last
      await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - now())))
    }
  }

  function learnFromHost(name) {
    const tools = listedTools(name)
    if (tools.length === 0) return undefined
    const row = managerRow(name)
    const count = row?.status && Number.isFinite(row.status.toolCount) ? row.status.toolCount : tools.length
    remember(catalog, name, { ok: true, tools, toolCount: count, truncated: count > tools.length })
    persist()
    return summaryOf(catalog.servers[name], now())
  }

  function normalizeProbeResult(result) {
    const tools = Array.isArray(result?.toolNames)
      ? result.toolNames.map((toolName) => (typeof toolName === 'string' ? { name: toolName } : toolName))
      : Array.isArray(result?.tools)
        ? result.tools
        : []
    return {
      ok: result?.ok === true,
      stage: typeof result?.stage === 'string' ? result.stage : '',
      error: result?.ok === true ? '' : (result?.message || result?.error || result?.cleanupError || 'probe failed'),
      tools,
      toolCount: Number.isFinite(result?.toolCount) ? result.toolCount : tools.length,
      truncated: result?.truncated === true,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
    }
  }

  function recordProbeOutcome(name, outcome) {
    if (outcome.ok === true) {
      remember(catalog, name, outcome)
    } else {
      rememberFailure(catalog, name, outcome.error || 'probe failed', now())
    }
    persist()
  }

  async function probeLiveServer(name, definition) {
    const learned = learnFromHost(name)
    if (learned && learned.tools.length > 0) {
      return {
        ok: true,
        stage: 'live',
        error: '',
        tools: learned.tools,
        toolCount: learned.toolCount,
        truncated: learned.truncated,
        durationMs: 0,
        fromLive: true,
      }
    }
    const manager = state.manager()
    if (typeof manager.probe === 'function') {
      const timeoutMs = definition.entry.startupTimeoutMs > 0 ? definition.entry.startupTimeoutMs : DEFAULT_PROBE_MS
      const raw = await manager.probe(name, { timeoutMs, maxToolNames: 80, maxPages: 4 })
      const outcome = normalizeProbeResult(raw)
      recordProbeOutcome(name, outcome)
      return { ...outcome, fromLive: true }
    }
    return { ok: false, stage: 'live', error: 'server is mounted but exposes no tools yet', tools: [], toolCount: 0, fromLive: true }
  }

  async function probeServer(name, definition) {
    if (isDisposed()) {
      return { ok: false, stage: 'disposed', error: 'plugin is unloading', tools: [], toolCount: 0 }
    }
    if (state.live.has(name)) {
      return probeLiveServer(name, definition)
    }

    return lock(name, () => limit.run(async () => {
      if (isDisposed()) {
        return { ok: false, stage: 'disposed', error: 'plugin is unloading', tools: [], toolCount: 0 }
      }
      if (state.live.has(name)) {
        return { ...(await probeLiveServer(name, definition)), waitedForLive: true }
      }

      const started = now()
      const manager = state.manager()
      const timeoutMs = definition.entry.startupTimeoutMs > 0
        ? Math.min(definition.entry.startupTimeoutMs, DEFAULT_PROBE_MS)
        : DEFAULT_PROBE_MS

      // Real dsh-mcp-manager only knows servers that are registered with it.
      // Temporarily register, wait until ready, learn names + descriptions from
      // the host (or fall back to manager.probe while registered), and always
      // dispose in finally so the server is never left mounted.
      if (typeof manager.register === 'function') {
        let dispose
        try {
          dispose = manager.register(name, definition.entry)
        } catch (error) {
          const outcome = { ok: false, stage: 'register', error: error?.message ?? String(error), tools: [], toolCount: 0 }
          recordProbeOutcome(name, outcome)
          return outcome
        }

        try {
          if (isDisposed()) {
            return { ok: false, stage: 'disposed', error: 'plugin is unloading', tools: [], toolCount: 0 }
          }
          const budget = definition.entry.startupTimeoutMs > 0
            ? Math.min(definition.entry.startupTimeoutMs, DEFAULT_PROBE_MS)
            : READY_WAIT_MS
          const status = await waitUntilReady(name, budget)
          if (isDisposed()) {
            return { ok: false, stage: 'disposed', error: 'plugin is unloading', tools: [], toolCount: 0 }
          }

          let outcome
          const failed = status === 'failed' || status.startsWith('failed:')
          if (failed) {
            outcome = {
              ok: false,
              stage: 'connect',
              error: status,
              tools: [],
              toolCount: 0,
              truncated: false,
              durationMs: Math.max(0, now() - started),
            }
          } else {
            const hostTools = listedTools(name)
            if (hostTools.length > 0) {
              const normalized = normalizeTools(name, hostTools)
              const row = managerRow(name)
              const count = row?.status && Number.isFinite(row.status.toolCount) ? row.status.toolCount : normalized.length
              outcome = {
                ok: true,
                stage: 'connected',
                error: '',
                tools: normalized,
                toolCount: count,
                truncated: count > normalized.length,
                durationMs: Math.max(0, now() - started),
              }
            } else if (typeof manager.probe === 'function') {
              const raw = await manager.probe(name, { timeoutMs, maxToolNames: 80, maxPages: 4 })
              outcome = normalizeProbeResult(raw)
            } else if (status === 'connected') {
              outcome = {
                ok: true,
                stage: 'connected',
                error: '',
                tools: [],
                toolCount: 0,
                truncated: false,
                durationMs: Math.max(0, now() - started),
              }
            } else {
              outcome = {
                ok: false,
                stage: 'timeout',
                error: `timed out while ${status}`,
                tools: [],
                toolCount: 0,
                truncated: false,
                durationMs: Math.max(0, now() - started),
              }
            }
          }
          recordProbeOutcome(name, outcome)
          return outcome
        } catch (error) {
          const outcome = {
            ok: false,
            stage: 'probe',
            error: error?.message ?? String(error),
            tools: [],
            toolCount: 0,
            durationMs: Math.max(0, now() - started),
          }
          recordProbeOutcome(name, outcome)
          return outcome
        } finally {
          if (typeof dispose === 'function') {
            try {
              await dispose()
            } catch {
              /* best effort cleanup */
            }
          }
        }
      }

      // Compatibility fallback for stubs that provide manager.probe without register.
      if (typeof manager.probe === 'function') {
        try {
          const raw = await manager.probe(name, { timeoutMs, maxToolNames: 80, maxPages: 4 })
          const outcome = normalizeProbeResult(raw)
          recordProbeOutcome(name, outcome)
          return outcome
        } catch (error) {
          const outcome = { ok: false, stage: 'probe', error: error?.message ?? String(error), tools: [], toolCount: 0 }
          recordProbeOutcome(name, outcome)
          return outcome
        }
      }

      return { ok: false, stage: 'unsupported', error: 'this host has no probe', tools: [], toolCount: 0 }
    }))
  }

  async function mountOrRenew(name, definition, args) {
    if (isDisposed()) {
      return {
        name,
        running: false,
        status: 'disposed',
        tools: [],
        note: 'The plugin is unloading, so the server was not mounted.',
      }
    }
    return lock(name, () => mountOrRenewLocked(name, definition, args))
  }

  async function mountOrRenewLocked(name, definition, args) {
    if (isDisposed()) {
      return {
        name,
        running: false,
        status: 'disposed',
        tools: [],
        note: 'The plugin is unloading, so the server was not mounted.',
      }
    }
    if (state.live.has(name)) {
      const ttlMs = requestedTtlFor(args, definition)
      const entry = state.live.get(name)
      entry.ttlMs = ttlMs
      if (!entry.inFlight && (entry.busy || 0) === 0) scheduleRelease(name, ttlMs)
      learnFromHost(name)
      return {
        name,
        running: true,
        status: managerStatus(name),
        tools: toolNamesOf(name),
        note: ttlMs > 0
          ? `Already mounted; its release was pushed back to ${Math.round(ttlMs / 1000)}s of idle time.`
          : 'Already mounted; automatic release is now off, so call mcpod_disable when done.',
      }
    }

    return limit.run(async () => {
      if (isDisposed()) {
        return {
          name,
          running: false,
          status: 'disposed',
          tools: [],
          note: 'The plugin is unloading, so the server was not mounted.',
        }
      }
      if (state.live.has(name)) return mountOrRenewLocked(name, definition, args)
      let dispose
      try {
        dispose = state.manager().register(name, definition.entry)
      } catch (error) {
        return {
          name,
          running: false,
          status: 'register failed',
          tools: [],
          note: `The host refused the registration: ${error?.message ?? String(error)}`,
        }
      }

      if (isDisposed()) {
        try {
          await dispose()
        } catch {
          /* best effort cleanup */
        }
        return {
          name,
          running: false,
          status: 'disposed',
          tools: [],
          note: 'The plugin unloaded during mount, so the server was immediately released.',
        }
      }

      const requestedTtl = requestedTtlFor(args, definition)
      state.live.set(name, {
        dispose,
        timer: undefined,
        since: now(),
        ttlMs: requestedTtl,
        busy: 0,
        inFlight: false,
        expiresAt: 0,
      })
      const budget = definition.entry.startupTimeoutMs > 0
        ? Math.min(definition.entry.startupTimeoutMs, READY_WAIT_MS)
        : READY_WAIT_MS
      const status = await waitUntilReady(name, budget)
      if (isDisposed()) {
        const live = state.live.get(name)
        state.live.delete(name)
        if (live?.timer !== undefined) clearTimeout(live.timer)
        try {
          await (live?.dispose ?? dispose)()
        } catch {
          /* best effort cleanup */
        }
        return {
          name,
          running: false,
          status: 'disposed',
          tools: [],
          note: 'The plugin unloaded while waiting for the server, so it was released.',
        }
      }
      const failed = status === 'failed' || status.startsWith('failed:')
      if (failed) {
        const live = state.live.get(name)
        state.live.delete(name)
        if (live?.timer !== undefined) clearTimeout(live.timer)
        try {
          await live?.dispose()
        } catch {
          /* the host already reported the failure */
        }
        return {
          name,
          running: false,
          status,
          tools: [],
          note: 'The server did not stay connected, so it was released. Fix the command or URL before enabling it again.',
        }
      }
      scheduleRelease(name, requestedTtl)
      learnFromHost(name)
      const ready = status === 'connected'
      return {
        name,
        running: true,
        status,
        tools: toolNamesOf(name),
        note: requestedTtl > 0
          ? `${ready ? 'Mounted' : 'Registered, still ' + status}. It releases after ${Math.round(requestedTtl / 1000)}s of idle time, or call mcpod_disable when done.`
          : `${ready ? 'Mounted' : 'Registered, still ' + status} with no time-to-live; call mcpod_disable when done.`,
      }
    })
  }

  async function disableServer(name) {
    return lock(name, async () => {
      const entry = state.live.get(name)
      if (entry === undefined) {
        return { name, running: false, note: 'That server was not mounted by this plugin; nothing to release.' }
      }
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      try {
        await entry.dispose()
      } catch (error) {
        if (!isDisposed() && entry.ttlMs > 0 && (entry.busy || 0) === 0 && entry.inFlight !== true) {
          scheduleRelease(name, entry.ttlMs)
        }
        return {
          name,
          running: true,
          note: `The host reported a disposal problem: ${error?.message ?? String(error)}`,
        }
      }
      state.live.delete(name)
      return {
        name,
        running: false,
        note: 'Released: its tools leave the tool list from the next request on. The catalog of names is kept.',
      }
    })
  }

  return {
    catalog,
    now,
    unknown,
    managerStatus,
    rowOf,
    noteActivity,
    hold,
    probeServer,
    mountOrRenew,
    disableServer,
    prompt: () => catalogPrompt(config.servers, catalog, now()),
  }
}
