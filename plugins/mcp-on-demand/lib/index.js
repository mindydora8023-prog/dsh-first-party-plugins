/**
 * mcp-on-demand host side.
 *
 * Registers three tools that let the MODEL decide when an MCP server exists:
 * mcpod_list / mcpod_enable / mcpod_disable. See lib/tools.js for behaviour and
 * lib/config.js for the definition format.
 *
 * Why a plugin and not a config toggle: `ctx.mcpManager.register()` returns a
 * disposer, so a tool call can mount a server mid-session and another can take
 * it away again, with no host restart and no operator switching anything by
 * hand.
 *
 * NOTE on services: only `tools` is injected. Declaring `mcpManager` in the
 * inject list moved the registered tools into a scope whose results the host
 * expects as content parts, which failed with "content.some is not a function".
 * The manager is therefore resolved lazily through `ctx.get()` at call time.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { defineTool } from './define.js'
import { readConfig } from './config.js'
import { buildTools } from './tools.js'
import { handleServersRequest, SERVERS_PATH } from './routes.js'

export const name = 'mcp-on-demand'

export const inject = ['tools']

export function apply(ctx, rawConfig) {
  ctx.inject(['tools'], (inner) => {
    const config = readConfig(rawConfig)
    /** @type {Map<string, {dispose: Function, timer: any, since: number}>} */
    const live = new Map()

    /** Resolve the manager lazily: it may mount after this plugin does. */
    const manager = () => {
      const service = typeof inner.get === 'function' ? inner.get('mcpManager') : undefined
      if (service === undefined) throw new Error('the MCP manager service is not mounted')
      return service
    }

    const authored = buildTools(inner, config, { live, manager })
    const byName = Object.fromEntries(authored.map((definition) => [definition.name, definition]))
    const definitions = authored.map((definition) => defineTool(definition))
    const disposers = definitions.map((definition) => inner.tools.register(definition))

    // The settings panel reads this route. A missing connection leaves the
    // tools working; only the page cannot load.
    inner.inject(['connection'], (scoped) => {
      const connection = typeof scoped.get === 'function' ? scoped.get('connection') : scoped.connection
      if (!connection?.fetch || typeof connection.fetch.register !== 'function') return
      scoped.effect(() => {
        const fetch = async (request) => {
          const url = new URL(request.url)
          let bodyText = ''
          if (request.method === 'POST' && request.body) bodyText = await request.text()
          const result = await handleServersRequest({
            method: request.method,
            path: url.pathname,
            bodyText,
            tools: byName,
          })
          const payload = request.method === 'HEAD' ? null : JSON.stringify(result.value)
          return new Response(payload, {
            status: result.status,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          })
        }
        let dispose
        try {
          inner.logger.info('mcp-on-demand: panel route %s', SERVERS_PATH)
          dispose = connection.fetch.register({
            path: SERVERS_PATH,
            methods: ['GET', 'HEAD', 'POST'],
            requestBody: 'buffered',
            fetch,
          })
        } catch (error) {
          inner.logger.warn('mcp-on-demand: panel route was not registered: %s', error?.message ?? String(error))
          return () => {}
        }
        return async () => {
          try {
            await dispose()
          } catch (error) {
            inner.logger.warn('mcp-on-demand: panel route disposal failed: %s', error?.message ?? String(error))
          }
        }
      }, 'mcp-on-demand panel route')
    })

    inner.effect(() => () => {
      for (const [serverName, entry] of live) {
        live.delete(serverName)
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        try {
          entry.dispose()
        } catch (error) {
          inner.logger.warn('mcp-on-demand: releasing %s on unload failed: %s', serverName, error?.message ?? String(error))
        }
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          inner.logger.warn('mcp-on-demand: tool disposal failed: %s', error?.message ?? String(error))
        }
      }
    }, 'mcp-on-demand registrations')

    inner.logger.info(
      'mcp-on-demand: %d tool(s) registered; %d server definition(s) available on demand',
      definitions.length,
      Object.keys(config.servers).length,
    )
  })
}
