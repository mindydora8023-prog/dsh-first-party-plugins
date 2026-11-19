/**
 * mcp-on-demand host side.
 *
 * Registers five tools that let the MODEL decide when an MCP server exists:
 * mcpod_list / mcpod_find / mcpod_probe / mcpod_enable / mcpod_disable.
 * See lib/tools.js for behaviour and lib/config.js for the definition format.
 *
 * Why a plugin and not a config toggle: `ctx.mcpManager.register()` returns a
 * disposer, so a tool call can mount a server mid-session and another can take
 * it away again, with no host restart and no operator switching anything by
 * hand.
 *
 * NOTE on services: `tools` is the required inject. `systemPrompt` is taken
 * with a separate `ctx.inject`, so a profile without it still gets the tools.
 * Declaring `mcpManager` in the inject list
 * moved the registered tools into a scope whose results the host expects as
 * content parts, which failed with "content.some is not a function". The
 * manager is therefore resolved lazily through `ctx.get()` at call time.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { readCatalog, writeCatalog } from './catalog.js'
import { defineTool } from './define.js'
import { readConfig } from './config.js'
import { createLimiter, createNameLock } from './limit.js'
import { buildTools } from './tools.js'
import { handleServersRequest, SERVERS_PATH } from './routes.js'

export const name = 'mcp-on-demand'

export const inject = ['tools']

export function apply(ctx, rawConfig) {
  // Filled once the tools are built. A profile without the prompt service
  // simply never subscribes; the tools still register.
  let prompt = () => ''
  ctx.inject(['systemPrompt'], (scoped) => {
    const promptService = typeof scoped.get === 'function' ? scoped.get('systemPrompt') : scoped.systemPrompt
    if (!promptService || typeof promptService.section !== 'function') return
    const off = promptService.section({
      name: 'mcp-on-demand',
      order: 640,
      text: () => {
        try {
          return prompt()
        } catch (error) {
          scoped.logger.warn('mcp-on-demand: catalog prompt failed: %s', error?.message ?? String(error))
          return ''
        }
      },
    })
    scoped.effect(() => () => {
      try {
        off()
      } catch (error) {
        scoped.logger.warn('mcp-on-demand: prompt disposal failed: %s', error?.message ?? String(error))
      }
    }, 'mcp-on-demand prompt')
  })

  ctx.inject(['tools'], (inner) => {
    const config = readConfig(rawConfig)
    /** @type {Map<string, {dispose: Function, timer: any, since: number, ttlMs: number, busy: number}>} */
    const live = new Map()
    const catalog = readCatalog(config.catalogFile)

    /** Resolve the manager lazily: it may mount after this plugin does. */
    const manager = () => {
      const service = typeof inner.get === 'function' ? inner.get('mcpManager') : undefined
      if (service === undefined) throw new Error('the MCP manager service is not mounted')
      return service
    }

    const authored = buildTools(inner, config, {
      live,
      manager,
      catalog,
      limit: createLimiter(config.maxConcurrent),
      lock: createNameLock(),
      saveCatalog: () => {
        try {
          writeCatalog(config.catalogFile, catalog)
        } catch (error) {
          inner.logger.warn('mcp-on-demand: catalog was not saved: %s', error?.message ?? String(error))
        }
      },
    })
    const byName = Object.fromEntries(authored.map((definition) => [definition.name, definition]))
    const definitions = authored.map((definition) => defineTool(definition))

    // A mounted server's tools cost prompt tokens on every later request.
    // Restart its release from the last real mcp__<server>__* call, so an
    // analysis that is still running is not torn down mid-way, and one that
    // stopped does not sit until the original deadline.
    const offActivity = typeof inner.on === 'function'
      ? inner.on('tools/pre-execute', (exec, next) => {
        let release
        try {
          authored.noteActivity(exec?.name)
          release = authored.hold(exec?.name)
        } catch (error) {
          inner.logger.warn('mcp-on-demand: activity note failed: %s', error?.message ?? String(error))
        }
        const finish = () => {
          if (typeof release === 'function') release()
        }
        if (typeof next !== 'function') {
          finish()
          return undefined
        }
        try {
          const result = next()
          if (result && typeof result.finally === 'function') return result.finally(finish)
          finish()
          return result
        } catch (error) {
          finish()
          throw error
        }
      })
      : undefined
    prompt = () => authored.prompt()
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
      prompt = () => ''
      if (typeof offActivity === 'function') {
        try {
          offActivity()
        } catch (error) {
          inner.logger.warn('mcp-on-demand: activity listener disposal failed: %s', error?.message ?? String(error))
        }
      }
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
