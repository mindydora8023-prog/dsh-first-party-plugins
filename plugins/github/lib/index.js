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
 *   github_commits        recent commits, or one commit with patches
 *   github_branches       branch list with head shas
 *   github_issues         issue list
 *   github_issue          one issue or pull request with comments
 *   github_pulls          pull request list, or one PR with review comments
 *   github_pull_files     a pull request's changed files and patches
 *   github_actions        CI workflow runs and failed job logs
 *   github_create_issue   (write) open an issue
 *   github_comment        (write) comment on an issue or pull request
 *   github_create_pr      (write) open a pull request
 *   github_update_issue   (write) update an issue or pull request
 *   github_merge_pr       (write) merge a pull request
 *   github_submit_review  (write) submit a pull request review
 *
 * Design constraints:
 *   1. No third-party dependency: fetch is built in, and a `link:` plugin lives
 *      outside the profile, so anything else could fail to resolve.
 *   2. Credentials are resolved lazily per call, never blocking host startup
 *      with synchronous subprocesses.
 *   3. Nothing echoes the token: errors are scrubbed before they reach a tool
 *      result.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from './config.js'
import { defineTool } from './define.js'
import { buildTools } from './tools.js'

export const name = 'github'

/** The plugin is useless without the tool registry, and it advertises itself through the system prompt. */
export const inject = ['tools', 'systemPrompt']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function staticCredentialSource(resolved) {
  if (typeof resolved.token === 'string' && resolved.token !== '') return 'config'
  if (
    (process.env['GITHUB_TOKEN'] ?? '').trim() !== '' ||
    (process.env['GH_TOKEN'] ?? '').trim() !== '' ||
    (process.env['GH_ENTERPRISE_TOKEN'] ?? '').trim() !== ''
  ) {
    return 'env'
  }
  return 'lazy'
}

export function apply(ctx, config) {
  const dirs = {
    pluginDir,
    profileDir: process.env['DSH_PROFILE_DIR'] ?? '',
    home: process.env['DSH_HOME'] ?? '',
  }
  ctx.inject(['tools', 'systemPrompt'], (runtimeCtx) => {
    const state = { disposed: false, disposers: [], sectionDisposer: null }
    runtimeCtx.effect(() => () => {
      state.disposed = true
      disposeRegistered(runtimeCtx, state)
    }, 'github tool registrations')

    const ready = register(runtimeCtx, config, dirs, state)
    // Attach the observer right away: a rejection between creating the promise
    // and the effect running would otherwise surface as an unhandled rejection.
    ready.catch((error) => {
      runtimeCtx.logger.warn('github: registration failed: %s', error?.message ?? String(error))
    })
  })
}

function disposeRegistered(ctx, state) {
  if (typeof state.sectionDisposer === 'function') {
    const off = state.sectionDisposer
    state.sectionDisposer = null
    try {
      off()
    } catch (error) {
      ctx.logger.warn('github: system prompt dispose failed: %s', error?.message ?? String(error))
    }
  }
  const disposers = state.disposers.splice(0).reverse()
  for (const dispose of disposers) {
    try {
      dispose()
    } catch (error) {
      ctx.logger.warn('github: tool dispose failed: %s', error?.message ?? String(error))
    }
  }
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

async function register(ctx, config, dirs, state) {
  if (state.disposed) return []
  if (typeof defineTool !== 'function') throw new Error('github: defineTool is unavailable')

  const resolved = readConfig(config, dirs)
  const definitions = buildTools(resolved, ctx.logger)
  if (state.disposed) return []

  for (const definition of definitions) {
    if (state.disposed) {
      disposeRegistered(ctx, state)
      return []
    }
    state.disposers.push(ctx.tools.register(defineTool(withLosslessOutput(definition))))
  }

  const names = definitions.map((tool) => tool.name)
  state.sectionDisposer = ctx.systemPrompt.section({
    name: 'github',
    order: 935,
    text: ({ scope }) => {
      const visible = names.filter((toolName) => ctx.tools.get(toolName, scope) !== undefined)
      if (visible.length === 0) return ''
      return (
        `GitHub is connected through ${visible.join(', ')} (real REST calls). ` +
        'Pass repo as owner/name, or omit it for the configured default. ' +
        'Lists include has_more and next_page: pass page to continue. ' +
        'github_read_file takes offset and limit (lines); a truncated file returns next_offset. ' +
        'github_commits with sha returns that commit and its patches. ' +
        'github_pulls with number returns one pull request and its line comments. ' +
        'github_actions with run_id returns failed jobs, annotations, and a log tail. ' +
        'Write tools (github_create_issue, github_comment, github_create_pr, github_update_issue, github_merge_pr, github_submit_review) ' +
        'act under the signed-in account: confirm the exact content or action with the user first, and never write on your own initiative. ' +
        `Credentials are resolved lazily (file path: ${resolved.credentialsFile}); never print the access token.`
      )
    },
  })

  if (state.disposed) {
    disposeRegistered(ctx, state)
    return []
  }

  // Load self-report: a status file makes "did the host really load this
  // plugin?" answerable, because host logs are not persisted.
  // Never spawn git/gh synchronously during startup; record only the static hint.
  if (resolved.statusFile !== false) {
    try {
      let version = 'unknown'
      try {
        version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version ?? version
      } catch {
        /* a missing version does not affect loading */
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
            define_tool_source: 'bundled',
            api: resolved.apiBaseUrl,
            credential_source: staticCredentialSource(resolved),
            login: '',
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
