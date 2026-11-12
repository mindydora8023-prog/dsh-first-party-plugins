/**
 * dsh-plugin-github - host side.
 *
 * Turns GitHub into native DSH tools instead of making the model hand-write
 * REST calls or shell out to curl:
 *
 *   github_status         credential source, account, scopes, remaining quota
 *   github_search_repos   repository search
 *   github_search_code    code search
 *   github_search_issues  issue / pull request search
 *   github_get_repo       one repository's metadata
 *   github_list_files     a directory, or a whole tree at a ref
 *   github_read_file      one file's decoded text
 *   github_commits        recent commits, optionally by path/branch/author
 *   github_branches       branch list with head shas
 *   github_issues         issue list
 *   github_issue          one issue or pull request with comments
 *   github_pulls          pull request list
 *   github_pull_files     a pull request's changed files and patches
 *   github_actions        CI workflow runs
 *   github_create_issue   (write) open an issue
 *   github_comment        (write) comment on an issue or pull request
 *
 * Design constraints:
 *   1. No third-party dependency: fetch is built in, and a `link:` plugin lives
 *      outside the profile, so anything else could fail to resolve.
 *   2. Credentials are resolved per call, so a rotated token or a fresh browser
 *      login takes effect without restarting the host.
 *   3. Nothing echoes the token: errors are scrubbed before they reach a tool
 *      result.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'github'

/** The plugin is useless without the tool registry, and it advertises itself through the system prompt. */
export const inject = ['tools', 'systemPrompt']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve `defineTool`.
 *
 * The bundled copy in `lib/define.js` is used directly. Probing for a host copy
 * was measured on 2026-10-26 and EVERY candidate failed -- the bare specifier
 * throws ERR_MODULE_NOT_FOUND and the absolute paths do not exist -- so this
 * always returned `bundled` while paying for `existsSync` calls and a swallowed
 * import on every startup.
 *
 * The probe survives behind `DSH_PROBE_HOST_TOOLS=1` for diagnosing a future host
 * layout instead of guessing at it.
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
    // Attach the observer right away: a rejection between creating the promise
    // and the effect running would otherwise surface as an unhandled rejection.
    ready.catch((error) => {
      runtimeCtx.logger.warn('github: registration failed: %s', error?.message ?? String(error))
    })
  })
}

/**
 * Guarantee the result is lossless JSON.
 *
 * The host validates a tool result strictly and fails the whole call with
 * "value is not lossless JSON" when it contains an `undefined` -- which is easy
 * to produce from optional API fields. A JSON round trip removes undefined
 * object properties and turns undefined array slots into null, so the call
 * always returns the data it actually has instead of an error.
 *
 * @param definition a tool definition in the authoring form
 */
function withLosslessOutput(definition) {
  const run = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      const value = await run(args, exec)
      if (value === undefined) return null
      return JSON.parse(JSON.stringify(value))
    },
  }
}

async function register(ctx, config, dirs) {  const { defineTool, source } = await loadTools()
  if (typeof defineTool !== 'function') throw new Error('github: defineTool is unavailable')

  const { readConfig } = await import('./config.js')
  const resolved = readConfig(config, dirs)
  const { buildTools } = await import('./tools.js')
  const definitions = buildTools(resolved, ctx.logger)

  const disposers = []
  for (const definition of definitions) {
    disposers.push(ctx.tools.register(defineTool(withLosslessOutput(definition))))
  }

  const names = definitions.map((tool) => tool.name)
  const sectionDisposer = ctx.systemPrompt.section({
    name: 'github',
    order: 935,
    text: ({ scope }) => {
      const visible = names.filter((toolName) => ctx.tools.get(toolName, scope) !== undefined)
      if (visible.length === 0) return ''
      return (
        `GitHub is connected through ${visible.join(', ')} (real REST API calls, not a mock). ` +
        'Start with github_get_repo or github_list_files, then github_read_file; use github_commits to see what changed recently ' +
        'and github_issue for one issue or pull request with its comments. ' +
        'Always pass repo as "owner/name" unless the task clearly concerns the configured default repository. ' +
        'github_create_issue and github_comment are real writes under the signed-in account: confirm the exact title or text with the user first ' +
        'and never open issues or comment on your own initiative. Never print or echo the access token.'
      )
    },
  })

  ctx.effect(() => () => {
    if (typeof sectionDisposer === 'function') {
      try {
        sectionDisposer()
      } catch (error) {
        ctx.logger.warn('github: system prompt dispose failed: %s', error?.message ?? String(error))
      }
    }
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn('github: tool dispose failed: %s', error?.message ?? String(error))
      }
    }
  }, 'github tool registrations')

  // Load self-report: a status file makes "did the host really load this
  // plugin?" answerable, because host logs are not persisted.
  if (resolved.statusFile !== false) {
    try {
      let version = 'unknown'
      try {
        version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version ?? version
      } catch {
        /* a missing version does not affect loading */
      }
      let credentialSource = 'none'
      let login = ''
      try {
        const { resolveToken } = await import('./auth.js')
        const token = resolveToken(resolved)
        credentialSource = token.source
        login = token.login
      } catch {
        /* credential probing must never fail the load */
      }
      mkdirSync(dirname(resolved.statusFile), { recursive: true })
      writeFileSync(
        resolved.statusFile,
        JSON.stringify(
          {
            loaded_at: new Date().toISOString(),
            pid: process.pid,
            exec_path: process.execPath,
            plugin_version: version,
            tools: names,
            define_tool_source: source,
            api: resolved.apiBaseUrl,
            credential_source: credentialSource,
            login,
            default_repo: resolved.defaultRepo,
            allow_write: resolved.allowWrite,
            profile_dir: resolved.dirs.profileDir,
            plugin_dir: resolved.dirs.pluginDir,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (error) {
      ctx.logger.warn('github: failed to write the status file: %s', error?.message ?? String(error))
    }
  }

  ctx.logger.info('github: registered %d tools (api %s, write=%s)', names.length, resolved.apiBaseUrl, String(resolved.allowWrite))
  return definitions
}
