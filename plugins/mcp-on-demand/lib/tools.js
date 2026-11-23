/**
 * Tool definitions for mcp-on-demand.
 *
 * Six tools, all thin wrappers over the host's MCP manager:
 *   mcpod_list     what is configured, what is mounted right now
 *   mcpod_find     search the remembered tool catalog (no process)
 *   mcpod_probe    connect, record tool names, disconnect
 *   mcpod_enable   mount one server -- its tools appear for the next model step
 *   mcpod_disable  dispose the mount -- its tools are withdrawn again
 *   mcpod_health   preflight config, mount status, catalog freshness, optional probe
 *
 * CONTRACT NOTE (measured 2026-11-17): `output.render` must return CONTENT PARTS,
 * i.e. [{ type: 'text', text }], not a bare string. A string survives the tool
 * pipeline but dsh-spill-policy's `tools/post-execute` hook calls
 * `content.some(...)` on it and the whole call fails with
 * "content.some is not a function".
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { searchCatalog, summaryOf } from './catalog.js'
import { createLifecycle, READY_WAIT_MS, targetOf } from './lifecycle.js'

export { READY_WAIT_MS, targetOf }

const text = (value) => [{ type: 'text', text: value }]

/**
 * @param {object} ctx cordis context
 * @param {{ servers: Record<string, {entry: object, ttlMs: number, description?: string, keywords?: string[]}>, defaultTtlMs: number, catalogFile?: string | false, maxConcurrent?: number }} config
 * @param {object} state live map, catalog, limiter, lock, and the host manager
 * @returns {object[]} tool definitions in the host's authoring form
 */
export function buildTools(ctx, config, state) {
  const lifecycle = createLifecycle(ctx, config, state)
  const { catalog, now } = lifecycle

  const mcpList = {
    name: 'mcpod_list',
    description:
      'List the MCP servers this plugin can mount on demand: each name, whether it is mounted now, its idle '
      + 'time-to-live, a one-line purpose, and what the host reports about it. Nothing is mounted until '
      + 'mcpod_enable is called, so this is the cheap way to see what is available.',
    parameters: {},
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
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
                in_flight: { type: 'boolean' },
                ttl_seconds: { type: 'integer' },
                release: { type: 'string', enum: ['remaining', 'default', 'off'] },
                status: { type: 'string' },
                transport: { type: 'string' },
                target: { type: 'string' },
                description: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
                catalog: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
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
          const ttlLabel = server.in_flight === true ? 'in-flight' : `ttl=${server.ttl_seconds}s`
          return `- ${server.name}: ${server.running ? 'RUNNING' : 'off'} status=${server.status} ${ttlLabel}${tools}${cached}`
        })
        return text([`${value.servers.length} MCP server(s) available`, ...lines, value.hint].join('\n'))
      },
    },
    async execute() {
      const servers = Object.entries(config.servers).map(([name, definition]) => lifecycle.rowOf(name, definition))
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
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
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
        allowedServers: config.servers,
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
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
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
        const missing = lifecycle.unknown(name)
        return { name, ok: false, toolCount: 0, tools: [], note: missing.note }
      }
      const outcome = await lifecycle.probeServer(name, definition)
      const toolNames = (outcome.tools || []).map((tool) => (typeof tool === 'string' ? tool : tool.name)).filter(Boolean).slice(0, 80)
      let note
      if (outcome.fromLive && outcome.waitedForLive) {
        note = 'It became mounted while this probe was waiting, so the live list was recorded instead.'
      } else if (outcome.fromLive) {
        note = 'Already mounted, so this read the live tool list and did not open a second connection.'
      } else if (outcome.ok) {
        note = 'Recorded and disconnected. Call mcpod_enable when you are ready to use one of these tools.'
      } else {
        note = `Probe failed: ${outcome.error || 'unknown error'}`
      }
      return {
        name,
        ok: outcome.ok === true,
        toolCount: outcome.toolCount || toolNames.length,
        tools: toolNames,
        note,
      }
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
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
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
      if (definition === undefined) return lifecycle.unknown(name)
      return lifecycle.mountOrRenew(name, definition, args)
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
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
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
      return lifecycle.disableServer(args.name)
    },
  }

  const mcpHealth = {
    name: 'mcpod_health',
    description:
      'Preflight one MCP server WITHOUT mounting it: validate its definition, report whether it is mounted and for '
      + 'how long, and how fresh its cached tool catalog is. Pass probe:true for a bounded live connect that reports '
      + 'reachability and then disconnects. Use it to triage a server before mcpod_enable.',
    parameters: {
      name: { type: 'string', required: true, description: 'Server name as mcpod_list reports it.' },
      probe: { type: 'boolean', description: 'Also connect once (bounded) to confirm reachability. Default false (cheap).' },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ok: { type: 'boolean' },
        },
        required: ['text', 'ok'],
        additionalProperties: false,
      },
      render: (_args, value) => text(typeof value?.text === 'string' ? value.text : ''),
    },
    async execute(args) {
      const name = typeof args?.name === 'string' ? args.name : ''
      const definition = config.servers[name]
      if (definition === undefined) {
        return { ok: false, text: `No server called ${name} is configured. Call mcpod_list for the available names.` }
      }
      const entry = definition.entry || {}
      const issues = []
      if (entry.transport === 'streamable-http') {
        if (typeof entry.url !== 'string' || entry.url === '') issues.push('streamable-http needs a url')
      } else if (typeof entry.command !== 'string' || entry.command === '') {
        issues.push('stdio needs a command')
      }
      const live = state.live.get(name)
      let mounted = 'no'
      if (live !== undefined) {
        const status = lifecycle.managerStatus(name)
        if ((live.busy || 0) > 0 || live.inFlight === true) {
          mounted = `yes, ${status}, active (in-flight)`
        } else {
          const ttlSeconds = live.ttlMs > 0 ? Math.max(0, Math.round((live.expiresAt - now()) / 1000)) : 0
          mounted = `yes, ${status}, ttl=${ttlSeconds}s`
        }
      }
      const rawCached = catalog.servers ? catalog.servers[name] : undefined
      const summary = summaryOf(rawCached, now())
      let catalogLine = 'catalog: none'
      if (summary !== undefined) {
        const hasTimestamp = typeof rawCached?.at === 'number'
        const ageSeconds = hasTimestamp ? Math.max(0, Math.round((now() - rawCached.at) / 1000)) : undefined
        const stale = ageSeconds !== undefined && ageSeconds > 7 * 24 * 3600
        const ageText = ageSeconds !== undefined ? `, age ${ageSeconds}s${stale ? ' (stale)' : ''}` : ''
        const errorText = summary.error ? `, error: ${summary.error}` : ''
        catalogLine = `catalog: ${summary.toolCount} tool(s)${ageText}${errorText}`
      }
      const lines = [
        `Server: ${name}`,
        `configured: ${issues.length === 0 ? 'yes' : 'no (' + issues.join('; ') + ')'}`,
        `mounted: ${mounted}`,
        catalogLine,
      ]
      let probeOk = true
      if (args?.probe === true) {
        let result
        try {
          result = await lifecycle.probeServer(name, definition)
        } catch (error) {
          result = { ok: false, error: error?.message ?? String(error), tools: [] }
        }
        probeOk = result.ok === true
        lines.push(
          `probe: ${probeOk ? 'reachable, ' + (Array.isArray(result.tools) ? result.tools.length : 0) + ' tool(s)' : 'failed: ' + (result.error || 'unknown error')}`,
        )
      }
      return { ok: issues.length === 0 && probeOk, text: lines.join('\n') }
    },
  }

  const tools = [mcpList, mcpFind, mcpProbe, mcpEnable, mcpDisable, mcpHealth]
  return Object.assign(tools, {
    noteActivity: lifecycle.noteActivity,
    hold: lifecycle.hold,
    prompt: lifecycle.prompt,
  })
}
