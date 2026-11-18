/**
 * Tool definitions for mcp-on-demand.
 *
 * Three tools, all thin wrappers over the host's MCP manager:
 *   mcpod_list     what is configured, what is mounted right now
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
 * @param {{ servers: Record<string, {entry: object, ttlMs: number}>, defaultTtlMs: number }} config
 * @param {{ live: Map<string, {dispose: Function, timer: any, since: number, expiresAt?: number}>, manager: () => any }} state
 * @returns {object[]} tool definitions in the host's authoring form
 */
export function buildTools(ctx, config, state) {
  /** Read the manager's live view, if it offers one. */
  function managerStatus(name) {
    try {
      const manager = state.manager()
      const list = typeof manager.list === 'function' ? manager.list() : []
      const found = Array.isArray(list) ? list.find((item) => item && item.name === name) : undefined
      if (found === undefined) return 'unknown'
      const status = found.status
      if (typeof status === 'string') return status
      if (status && typeof status.state === 'string') return status.state
      return found.configured === true ? 'configured' : 'unknown'
    } catch (error) {
      return `unreadable (${error?.message ?? String(error)})`
    }
  }

  /** The tool names a mounted server exposes, as far as the host will say. */
  function toolNamesOf(name) {
    const prefix = `mcp__${name}__`
    try {
      const listed = typeof ctx.tools.list === 'function' ? ctx.tools.list({}) : []
      const rows = Array.isArray(listed) ? listed : []
      return rows
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .filter((toolName) => typeof toolName === 'string' && toolName.startsWith(prefix))
    } catch {
      return []
    }
  }

  const text = (value) => [{ type: 'text', text: value }]

  /**
   * (Re)schedule the automatic release of a mounted server.
   *
   * Called on mount and again whenever the model re-enables an already mounted
   * server, which is how it extends a long analysis without remounting (and
   * therefore without paying the Ghidra startup again).
   *
   * @param {string} name
   * @param {number} ttlMs 0 disables the automatic release
   */
  function scheduleRelease(name, ttlMs) {
    const entry = state.live.get(name)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0
    if (ttlMs <= 0) return
    const timer = setTimeout(() => {
      const live = state.live.get(name)
      if (live === undefined) return
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

  /** The TTL an enable call asks for, falling back to the server's own. */
  function requestedTtlFor(args, definition) {
    return Number.isFinite(args.ttl_seconds) && args.ttl_seconds >= 0
      ? args.ttl_seconds * 1000
      : definition.ttlMs
  }

  const mcpList = {
    name: 'mcpod_list',
    description:
      'List the MCP servers this plugin can mount on demand: each name, whether it is mounted now, its idle '
      + 'time-to-live and what the host reports about it. Nothing is mounted until mcpod_enable is called, so this '
      + 'is the cheap way to see what is available.',
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
                tools: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'running', 'status'],
            },
          },
          hint: { type: 'string' },
        },
        required: ['servers', 'hint'],
      },
      render: (_args, value) => {
        const lines = value.servers.map((server) => {
          const tools = server.tools && server.tools.length > 0 ? ` tools=${server.tools.length}` : ''
          return `- ${server.name}: ${server.running ? 'RUNNING' : 'off'} status=${server.status} ttl=${server.ttl_seconds}s${tools}`
        })
        return text([`${value.servers.length} MCP server(s) available`, ...lines, value.hint].join('\n'))
      },
    },
    async execute() {
      const servers = Object.entries(config.servers).map(([name, definition]) => {
        const live = state.live.get(name)
        const running = live !== undefined
        // Idle rows report the configured default. A mounted row reports the
        // real remainder, or `off` when this mount will not release itself.
        let release = 'default'
        let ttlSeconds = Math.round(definition.ttlMs / 1000)
        if (running) {
          if (typeof live.expiresAt === 'number' && live.expiresAt > 0) {
            release = 'remaining'
            ttlSeconds = Math.max(0, Math.round((live.expiresAt - Date.now()) / 1000))
          } else {
            release = 'off'
            ttlSeconds = 0
          }
        }
        return {
          name,
          running,
          ttl_seconds: ttlSeconds,
          release,
          status: running ? managerStatus(name) : 'not mounted',
          transport: definition.entry.transport,
          target: targetOf(definition.entry),
          tools: running ? toolNamesOf(name) : [],
        }
      })
      return {
        servers,
        hint: servers.some((server) => server.running)
          ? 'Call mcpod_disable when the task no longer needs that server: its tools leave the next request.'
          : 'Call mcpod_enable with a name before using its tools.',
      }
    },
  }

  const mcpEnable = {
    name: 'mcpod_enable',
    description:
      'Mount one MCP server from mcpod_list, so its tools become callable as mcp__<server>__<tool>. Use it only when '
      + 'the task actually needs that server: a mounted server costs prompt tokens on every following request until '
      + 'it is released. Calling it for a server that is already mounted is harmless.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name as mcpod_list reports it.' },
      ttl_seconds: {
        type: 'integer',
        description: 'Auto-release after this many seconds. Defaults to the configured time-to-live; 0 disables it.',
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
      },
      render: (_args, value) => {
        const tools = value.tools.length > 0 ? value.tools.join(', ') : `mcp__${value.name}__*`
        return text([
          `${value.name}: ${value.running ? 'RUNNING' : 'FAILED'} (${value.status})`,
          `tools: ${tools}`,
          value.note,
        ].join('\n'))
      },
    },
    async execute(args) {
      const name = args.name
      const definition = config.servers[name]
      if (definition === undefined) {
        return {
          name,
          running: false,
          status: 'unknown server',
          tools: [],
          note: `No server called ${name} is configured. Call mcpod_list for the available names.`,
        }
      }
      if (state.live.has(name)) {
        const ttlMs = requestedTtlFor(args, definition)
        scheduleRelease(name, ttlMs)
        return {
          name,
          running: true,
          status: managerStatus(name),
          tools: toolNamesOf(name),
          note: ttlMs > 0
            ? `Already mounted; its release was pushed back to ${Math.round(ttlMs / 1000)}s from now.`
            : 'Already mounted; automatic release is now off, so call mcpod_disable when done.',
        }
      }

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
      state.live.set(name, { dispose, timer: undefined, since: Date.now() })
      scheduleRelease(name, requestedTtl)

      // Let the client connect so the reported status means something.
      await new Promise((resolve) => setTimeout(resolve, 400))

      return {
        name,
        running: true,
        status: managerStatus(name),
        tools: toolNamesOf(name),
        note: requestedTtl > 0
          ? `Mounted. It releases itself in ${Math.round(requestedTtl / 1000)}s, or call mcpod_disable when done.`
          : 'Mounted with no time-to-live; call mcpod_disable when done.',
      }
    },
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
        note: 'Released: its tools leave the tool list from the next request on.',
      }
    },
  }

  return [mcpList, mcpEnable, mcpDisable]
}
