/**
 * dsh-plugin-gmail - host side
 *
 * Turns Gmail into native DSH tools, instead of making the model hand-write
 * IMAP scripts every time:
 *
 *   gmail_status   connection self-check and folder counts
 *   gmail_search   find mail with Gmail search syntax (returns uid / thread / metadata)
 *   gmail_read     read the full message by uid (optionally saving attachments)
 *   gmail_thread   read a whole conversation by thread id
 *   gmail_send     send mail (attachments and HTML body supported)
 *   gmail_mark     read / unread / star
 *   gmail_label    add / remove labels
 *   gmail_archive  archive (move out of the inbox)
 *   gmail_new      incremental "what is new" cursor
 *
 * Design constraints (deliberate):
 *   1. Apart from `defineTool` from `@deepseek-ai/dsh-tools`, no third-party
 *      package -- IMAP/SMTP go through Node's built-in tls, so the profile's
 *      pnpm install will not fail for lack of a compiler toolchain.
 *   2. Credentials are re-read from disk on every call: rotating the app
 *      password takes effect immediately, without restarting the host.
 *   3. Reads always use BODY.PEEK, so a glance never turns unread into read.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'gmail'

/** Depends only on the tool registry and the system prompt; if either is missing, fail the load rather than silently ship no tools. */
export const inject = ['tools', 'systemPrompt']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve `defineTool`.
 *
 * The bundled copy in `lib/define.js` (identical to the one in filekit, github and
 * ops-lite -- see workspace `shared/define.js`) is used directly. What used to
 * happen here was a search for the host's implementation through five candidates,
 * every one of which was measured to fail on 2026-10-26: the bare specifier throws
 * ERR_MODULE_NOT_FOUND, because a `link:` plugin resolves from its real path
 * outside the profile, and `@deepseek-ai/dsh-tools` ships packed inside app.asar,
 * so the four absolute paths do not exist either. The search therefore cost an
 * `existsSync` per candidate and a swallowed import on every load, and always
 * ended at the bundled copy.
 *
 * The probe survives behind `DSH_PROBE_HOST_TOOLS=1`: if a future host layout does
 * ship an importable copy, that is now something to check deliberately rather than
 * a branch nobody can observe.
 */
async function loadTools() {
  if (process.env['DSH_PROBE_HOST_TOOLS'] === '1') {
    const candidates = [null]
    const home = process.env['DSH_HOME']
    if (typeof home === 'string' && home.trim() !== '') {
      candidates.push(join(resolve(home), 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    }
    const profileDir = process.env['DSH_PROFILE_DIR']
    if (typeof profileDir === 'string' && profileDir.trim() !== '') {
      candidates.push(join(resolve(profileDir), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    }
    candidates.push(
      join(pluginDir, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      join(pluginDir, '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    )
    const appData = process.env['APPDATA']
    if (typeof appData === 'string' && appData.trim() !== '') {
      candidates.push(
        join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
      )
    }

    for (const candidate of candidates) {
      if (candidate !== null && !existsSync(candidate)) continue
      try {
        const specifier = candidate === null ? '@deepseek-ai/dsh-tools' : pathToFileURL(candidate).href
        const module = await import(specifier)
        if (typeof module.defineTool === 'function') {
          return { defineTool: module.defineTool, source: candidate ?? 'bare' }
        }
      } catch {
        /* try the next candidate; fall back to the bundled implementation at the end */
      }
    }
  }
  const local = await import('./define.js')
  return { defineTool: local.defineTool, source: 'bundled' }
}

export function apply(ctx, config) {
  const dirs = {
    pluginDir,
    profileDir: process.env['DSH_PROFILE_DIR'] ?? '',
    home: process.env['DSH_HOME'] ?? '',
  }
  ctx.inject(['tools', 'systemPrompt'], (runtimeCtx) => {
    const ready = register(runtimeCtx, config, dirs)
    // Attach the observer right away: if a rejection happens between creating
    // the promise and the effect actually running, it becomes an unhandled
    // rejection (a wall of red text in the Electron host).
    ready.catch((error) => {
      runtimeCtx.logger.warn('gmail: registration failed: %s', error?.message ?? String(error))
    })
  })
}

async function register(ctx, config, dirs) {
  const { defineTool, source } = await loadTools()
  if (typeof defineTool !== 'function') throw new Error('gmail: defineTool is unavailable')

  const { readConfig } = await import('./config.js')
  const resolved = readConfig(config, dirs)
  const { buildTools } = await import('./tools.js')
  const built = buildTools(resolved, ctx.logger)

  const disposers = []
  for (const definition of built.tools) {
    disposers.push(ctx.tools.register(defineTool(definition)))
  }

  const names = built.tools.map((tool) => tool.name)
  const sectionDisposer = ctx.systemPrompt.section({
    name: 'gmail',
    order: 940,
    text: ({ scope }) => {
      const visible = names.filter((toolName) => ctx.tools.get(toolName, scope) !== undefined)
      if (visible.length === 0) return ''
      return (
        `Gmail is connected through ${visible.join(', ')}: a real Gmail mailbox over IMAP/SMTP (app password). ` +
        'Start with gmail_search (it accepts full Gmail search syntax and returns uids plus thread ids), ' +
        'then gmail_read for one message or gmail_thread for a whole conversation. ' +
        'Reading never marks mail as read; gmail_mark changes read/star state, gmail_label and gmail_archive are writes. ' +
        'gmail_send sends real mail, so confirm recipients, subject and body with the user first unless they already stated them. ' +
        'Never print or echo the app password.'
      )
    },
  })

  ctx.effect(() => () => {
    if (typeof sectionDisposer === 'function') {
      try {
        sectionDisposer()
      } catch (error) {
        ctx.logger.warn('gmail: system prompt dispose failed: %s', error?.message ?? String(error))
      }
    }
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn('gmail: tool dispose failed: %s', error?.message ?? String(error))
      }
    }
  }, 'gmail tool registrations')

  let account = '(credentials not configured)'
  try {
    const { loadCredentials } = await import('./config.js')
    account = loadCredentials(resolved).address
  } catch {
    /* missing credentials is a normal state; loading must not fail because of it */
  }

  // Load self-report: write a status file containing the pid.
  //
  // Why it is needed: whether the plugin was really loaded by the host cannot
  // be seen in the logs (DSH does not persist host logs). With this file, the
  // process name behind the pid distinguishes "the host loaded it" from "a
  // self-check script loaded it", so plugin activation can be judged with
  // certainty before and after a restart.
  if (resolved.statusFile !== false) {
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname: dirnameOf } = await import('node:path')
      let version = 'unknown'
      try {
        version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version ?? version
      } catch {
        /* failing to read the version does not affect loading */
      }
      mkdirSync(dirnameOf(resolved.statusFile), { recursive: true })
      writeFileSync(
        resolved.statusFile,
        JSON.stringify(
          {
            loaded_at: new Date().toISOString(),
            pid: process.pid,
            process_title: process.title,
            exec_path: process.execPath,
            plugin_version: version,
            tools: names,
            define_tool_source: source,
            account,
            allow_write: resolved.allowWrite,
            allow_send: resolved.allowSend,
            profile_dir: resolved.dirs.profileDir,
            plugin_dir: resolved.dirs.pluginDir,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (error) {
      ctx.logger.warn('gmail: failed to write status file: %s', error?.message ?? String(error))
    }
  }

  ctx.logger.info(
    'gmail: registered %d tools (account %s, write=%s, send=%s)',
    built.tools.length,
    account,
    String(resolved.allowWrite),
    String(resolved.allowSend),
  )
  return built
}