/**
 * Tool definitions for mcp-on-demand.
 *
 * Five tools, all thin wrappers over the host's MCP manager:
 *   mcpod_list     what is configured, what is mounted right now
 *   mcpod_find     search the remembered tool catalog (no process)
 *   mcpod_probe    connect, record tool names, disconnect
 *   mcpod_enable   mount one server -- its tools appear for the next model step
 *   mcpod_disable  dispose the mount -- its tools are withdrawn again
 *
 * CONTRACT NOTE (measured 2026-11-17): `output.render` must return CONTENT PARTS,
 * i.e. [{ type: 'text', text }], not a bare string. A string survives the tool
 * pipeline but dsh-spill-policy's `tools/post-execute` hook calls
 * `content.some(...)` on it and the whole call fails with
 * "content.some is not a function".
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { catalogPrompt, remember, searchCatalog, summaryOf } from './catalog.js'

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
 * @param {object} ctx cordis context
 * @param {{ servers: Record<string, {entry: object, ttlMs: number, description?: string, keywords?: string[]}>, defaultTtlMs: number, catalogFile?: string | false, maxConcurrent?: number }} config
 * @param {object} state live map, catalog, limiter, and the host manager
 * @returns {object[]} tool definitions in the host's authoring form
 */
export function buildTools(ctx, config, state) {
  const catalog = state.catalog || { servers: {} }
  const limit = state.limit || { run: (task) => task() }
  const lock = state.lock || ((_name, task) => task())
  const now = () => (typeof state.now === 'function' ? state.now() : Date.now())

  function persist() {
    if (typeof state.saveCatalog === 'function') state.saveCatalog()
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

  /** The tool names a mounted server exposes, as far as the host will say. */
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

  const text = (value) => [{ type: 'text', text: value }]

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
    entry.expiresAt = ttlMs > 0 ? now() + ttlMs : 0
    if (ttlMs <= 0) return
    const timer = setTimeout(() => {
      const live = state.live.get(name)
      if (live === undefined || live.busy > 0) {
        if (live !== undefined) scheduleRelease(name, live.ttlMs)
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
   * @param {string} toolName
   * @returns {boolean} whether a mounted server was extended
   */
  function noteActivity(toolName) {
    const match = /^mcp__([^_].*?)__/.exec(typeof toolName === 'string' ? toolName : '')
    if (match === null) return false
    const entry = state.live.get(match[1])
    if (entry === undefined || !(entry.ttlMs > 0)) return false
    scheduleRelease(match[1], entry.ttlMs)
    return true
  }

  /**
   * Hold the release while a call is in flight. A slow Ghidra call must not be
   * torn down because the idle timer happened to expire mid-request.
   *
   * @param {string} toolName
   * @returns {(() => void) | undefined}
   */
  function hold(toolName) {
    const match = /^mcp__([^_].*?)__/.exec(typeof toolName === 'string' ? toolName : '')
    if (match === null) return undefined
    const entry = state.live.get(match[1])
    if (entry === undefined) return undefined
    entry.busy = (entry.busy || 0) + 1
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    let released = false
    return () => {
      if (released) return
      released = true
      const live = state.live.get(match[1])
      if (live === undefined) return
      live.busy = Math.max(0, (live.busy || 1) - 1)
      if (live.busy === 0 && live.ttlMs > 0) scheduleRelease(match[1], live.ttlMs)
    }
  }

  function requestedTtlFor(args, definition) {
    return Number.isFinite(args.ttl_seconds) && args.ttl_seconds >= 0
      ? args.ttl_seconds * 1000
      : definition.ttlMs
  }

  function rowOf(name, definition) {
    const live = state.live.get(name)
    const running = live !== undefined
    let release = 'default'
    let ttlSeconds = Math.round(definition.ttlMs / 1000)
    if (running) {
      if (typeof live.expiresAt === 'number' && live.expiresAt > 0) {
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
      const status = statusOf(managerRow(name))
      last = status.lastError ? `${status.state}: ${status.lastError}` : status.state
      if (status.state === 'connected' || status.state === 'failed') return last
      if (now() >= deadline) return last
      const wait = typeof state.sleep === 'function' ? state.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      await wait(Math.min(READY_POLL_MS, Math.max(0, deadline - now())))
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

  async function probeServer(name, definition) {
    const manager = state.manager()
    if (typeof manager.probe !== 'function') {
      return { ok: false, stage: 'unsupported', error: 'this host has no probe', tools: [] }
    }
    const timeoutMs = definition.entry.startupTimeoutMs > 0 ? definition.entry.startupTimeoutMs : DEFAULT_PROBE_MS
    const result = await manager.probe(name, { timeoutMs, maxToolNames: 80, maxPages: 4 })
    const tools = Array.isArray(result?.toolNames) ? result.toolNames.map((toolName) => ({ name: toolName })) : []
    const outcome = {
      ok: result?.ok === true,
      stage: typeof result?.stage === 'string' ? result.stage : '',
      error: result?.ok === true ? '' : (result?.message || result?.cleanupError || 'probe failed'),
      tools,
      toolCount: tools.length,
      truncated: result?.truncated === true,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
    }
    remember(catalog, name, outcome)
    persist()
    return outcome
  }

  const mcpList = {
    name: 'mcpod_list',
    description:
      'List the MCP servers this plugin can mount on demand: each name, whether it is mounted now, its idle '
      + 'time-to-live, a one-line purpose, and what the host reports about it. Nothing is mounted until '
      + 'mcpod_enable is called, so this is the cheap way to see what is available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                running: { type: 'boolean' },
                ttl_seconds: { type: 'integer' },
                release: { type: 'string', enum: ['remaining', 'default', 'off'] },
                status: { type: 'string' },
                transport: { type: 'string' },
                target: { type: 'string' },
                description: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
                catalog: { type: 'object', additionalProperties: true },
              },
              required: ['name', 'running', 'status'],
              additionalProperties: true,
            },
          },
          hint: { type: 'string' },
        },
        required: ['servers', 'hint'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = value.servers.map((server) => {
          const tools = server.tools && server.tools.length > 0 ? ` tools=${server.tools.length}` : ''
          const cached = server.catalog && server.catalog.ok && !server.catalog.stale
            ? ` catalog=${server.catalog.toolCount}`
            : ''
          return `- ${server.name}: ${server.running ? 'RUNNING' : 'off'} status=${server.status} ttl=${server.ttl_seconds}s${tools}${cached}`
        })
        return text([`${value.servers.length} MCP server(s) available`, ...lines, value.hint].join('\n'))
      },
    },
    async execute() {
      const servers = Object.entries(config.servers).map(([name, definition]) => rowOf(name, definition))
      return {
        servers,
        hint: servers.some((server) => server.running)
          ? 'Call mcpod_disable when the task no longer needs that server: its tools leave the next request.'
          : 'Call mcpod_find to pick a tool, then mcpod_enable before using it. mcpod_probe records names without leaving a server mounted.',
      }
    },
  }

  const mcpFind = {
    name: 'mcpod_find',
    description:
      'Search the remembered catalog of MCP tool names. This does not start a server and does not put tool schemas '
      + 'into the prompt. Mount the matching server with mcpod_enable before calling a result. A server with no '
      + 'current catalog needs mcpod_probe first.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Words to match against the server name, its purpose, and remembered tool names.',
      },
      limit: { type: 'integer', description: 'How many hits to return. Default 12, at most 20.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                server: { type: 'string' },
                tool: { type: 'string' },
                call: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['server', 'tool', 'call'],
              additionalProperties: false,
            },
          },
          uncataloged: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['query', 'hits', 'uncataloged', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = value.hits.map((hit) => (hit.call ? `- ${hit.call}` : `- ${hit.server}`))
        const missing = value.uncataloged.length > 0 ? `\nNo catalog yet: ${value.uncataloged.join(', ')}` : ''
        return text([`${value.hits.length} hit(s) for ${JSON.stringify(value.query)}`, ...lines, missing, value.note].filter(Boolean).join('\n'))
      },
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query : ''
      const hits = searchCatalog(catalog, query, {
        limit: args.limit,
        now: now(),
        aboutOf: (name) => config.servers[name]?.description || '',
        keywordsOf: (name) => config.servers[name]?.keywords || [],
      })
      const uncataloged = Object.keys(config.servers).filter((name) => {
        const summary = summaryOf(catalog.servers[name], now())
        return !summary || summary.stale || !summary.ok
      })
      return {
        query,
        hits,
        uncataloged,
        note: hits.length > 0
          ? 'These names are cached. Call mcpod_enable for the server before calling the tool.'
          : 'Nothing matched. Call mcpod_probe for a likely server, then search again.',
      }
    },
  }

  const mcpProbe = {
    name: 'mcpod_probe',
    description:
      'Connect to one configured MCP server, record its tool names, and disconnect. The server is not left mounted '
      + 'and its schemas are not added to the prompt. Use this when mcpod_find has no catalog for that server.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name as mcpod_list reports it.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ok: { type: 'boolean' },
          toolCount: { type: 'integer' },
          tools: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['name', 'ok', 'toolCount', 'tools', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const sample = value.tools.slice(0, 12).join(', ')
        return text([
          `${value.name}: ${value.ok ? 'probed' : 'probe failed'} (${value.toolCount} tools)`,
          sample,
          value.note,
        ].filter(Boolean).join('\n'))
      },
    },
    async execute(args) {
      const name = args.name
      const definition = config.servers[name]
      if (definition === undefined) {
        const missing = unknown(name)
        return { name, ok: false, toolCount: 0, tools: [], note: missing.note }
      }
      if (state.live.has(name)) {
        const learned = learnFromHost(name)
        const tools = (learned?.tools || []).map((tool) => tool.name)
        return {
          name,
          ok: tools.length > 0,
          toolCount: learned?.toolCount || tools.length,
          tools,
          note: 'Already mounted, so this read the live tool list and did not open a second connection.',
        }
      }
      return lock(name, () => limit.run(async () => {
        if (state.live.has(name)) {
          const learned = learnFromHost(name)
          const tools = (learned?.tools || []).map((tool) => tool.name)
          return {
            name,
            ok: tools.length > 0,
            toolCount: learned?.toolCount || tools.length,
            tools,
            note: 'It became mounted while this probe was waiting, so the live list was recorded instead.',
          }
        }
        let outcome
        try {
          outcome = await probeServer(name, definition)
        } catch (error) {
          outcome = { ok: false, error: error?.message ?? String(error), tools: [], toolCount: 0 }
          remember(catalog, name, outcome)
          persist()
        }
        return {
          name,
          ok: outcome.ok === true,
          toolCount: outcome.toolCount || 0,
          tools: (outcome.tools || []).map((tool) => tool.name).slice(0, 80),
          note: outcome.ok
            ? 'Recorded and disconnected. Call mcpod_enable when you are ready to use one of these tools.'
            : `Probe failed: ${outcome.error || 'unknown error'}`,
        }
      }))
    },
  }

  const mcpEnable = {
    name: 'mcpod_enable',
    description:
      'Mount one MCP server from mcpod_list, so its tools become callable as mcp__<server>__<tool>. Use it only when '
      + 'the task actually needs that server: a mounted server costs prompt tokens on every following request until '
      + 'it is released. Calling it for a server that is already mounted renews the release and does not restart it. '
      + 'A second call while the first is still connecting waits for that same connection.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name as mcpod_list reports it.' },
      ttl_seconds: {
        type: 'integer',
        description: 'Auto-release after this many idle seconds. Defaults to the configured time-to-live; 0 disables it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          running: { type: 'boolean' },
          status: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['name', 'running', 'status', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const tools = value.tools.length > 0 ? value.tools.slice(0, 12).join(', ') : `mcp__${value.name}__*`
        const more = value.tools.length > 12 ? ` (+${value.tools.length - 12} more)` : ''
        return text([
          `${value.name}: ${value.running ? 'RUNNING' : 'FAILED'} (${value.status})`,
          `tools: ${tools}${more}`,
          value.note,
        ].join('\n'))
      },
    },
    async execute(args) {
      const name = args.name
      const definition = config.servers[name]
      if (definition === undefined) return unknown(name)
      return lock(name, () => mountOrRenew(name, definition, args))
    },
  }

  async function mountOrRenew(name, definition, args) {
    if (state.live.has(name)) {
      const ttlMs = requestedTtlFor(args, definition)
      const entry = state.live.get(name)
      entry.ttlMs = ttlMs
      scheduleRelease(name, ttlMs)
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
      if (state.live.has(name)) return mountOrRenew(name, definition, args)
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

      const requestedTtl = requestedTtlFor(args, definition)
      state.live.set(name, {
        dispose,
        timer: undefined,
        since: now(),
        ttlMs: requestedTtl,
        busy: 0,
        expiresAt: 0,
      })
      const budget = definition.entry.startupTimeoutMs > 0
        ? Math.min(definition.entry.startupTimeoutMs, READY_WAIT_MS)
        : READY_WAIT_MS
      const status = await waitUntilReady(name, budget)
      const failed = status === 'failed' || status.startsWith('failed:')
      if (failed) {
        const live = state.live.get(name)
        state.live.delete(name)
        try {
          live?.dispose()
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

  const mcpDisable = {
    name: 'mcpod_disable',
    description:
      'Unmount an MCP server this plugin mounted: its tools are withdrawn from the next request and its child '
      + 'process is closed. Call it as soon as the task no longer needs that server.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name as mcpod_list reports it.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          running: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['name', 'running', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => text(`${value.name}: ${value.running ? 'still running' : 'released'}\n${value.note}`),
    },
    async execute(args) {
      const name = args.name
      const entry = state.live.get(name)
      if (entry === undefined) {
        return { name, running: false, note: 'That server was not mounted by this plugin; nothing to release.' }
      }
      state.live.delete(name)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      try {
        entry.dispose()
      } catch (error) {
        return {
          name,
          running: true,
          note: `The host reported a disposal problem: ${error?.message ?? String(error)}`,
        }
      }
      return {
        name,
        running: false,
        note: 'Released: its tools leave the tool list from the next request on. The catalog of names is kept.',
      }
    },
  }

  const tools = [mcpList, mcpFind, mcpProbe, mcpEnable, mcpDisable]
  return Object.assign(tools, { noteActivity, hold, prompt: () => catalogPrompt(config.servers, catalog, now()) })
}
