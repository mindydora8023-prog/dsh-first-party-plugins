/**
 * ops-lite host side.
 *
 * Registers two tools (`ops_read_files` and `ops_tree`) that carry four
 * behaviours dsh-ops established:
 *
 *   1. structured failures -- calls return {status, error.code, effectState,
 *      retry, nextAction} instead of throwing a bare Error;
 *   2. a two-level output budget -- per line, per file and per call, all
 *      measured in ESCAPED bytes, with a concrete resume instruction;
 *   3. a compact multi-file receipt -- one shared Base, one revision per file;
 *   4. two independent completeness levels -- batch pending vs per-file complete.
 *
 * Deliberately NOT here (see README for why): progressive disclosure,
 * discovery/PTC projections, a bundled shell, or replacing official tools.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineTool as bundledDefineTool } from './define.js'
import { stateProvenance } from './state-dir.js'

export const name = 'ops-lite'

/**
 * `fs` is REQUIRED, not optional: cordis throws for any service a plugin reads
 * without declaring it, so listing it here is what makes `ctx.fs` reachable.
 */
export const inject = ['tools', 'systemPrompt', 'fs']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve a `defineTool` implementation.
 *
 * Uses the bundled copy in `lib/define.js` directly. Set `DSH_PROBE_HOST_TOOLS=1`
 * only when diagnosing whether a future host layout ships an importable copy.
 *
 * @returns {Promise<{defineTool: Function, source: string}>}
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
          return { defineTool: module.defineTool, source: candidate === null ? 'host' : candidate }
        }
      } catch {
        /* try the next candidate; the bundled implementation is the fallback */
      }
    }
  }
  return { defineTool: bundledDefineTool, source: 'bundled' }
}

export function apply(ctx, config) {
  const dirs = { pluginDir, profileDir: process.env['DSH_PROFILE_DIR'] ?? '', home: process.env['DSH_HOME'] ?? '' }
  // The nested inject repeats every service register() touches, `fs` included:
  // cordis gates each fiber on its own inject list.
  ctx.inject(['tools', 'systemPrompt', 'fs'], (runtimeCtx) => {
    const ready = register(runtimeCtx, config, dirs)
    ready.catch((error) => {
      runtimeCtx.logger.warn('ops-lite: registration failed: %s', error?.message ?? String(error))
    })
  })
}

/**
 * Register the tools and prompt guidance, and announce what loaded.
 * @param {object} ctx - the injected runtime context.
 * @param {object|undefined} config - the raw plugin config.
 * @param {object} dirs - resolved plugin/profile/home directories.
 * @returns {Promise<object[]>} the registered tool definitions.
 */
async function register(ctx, config, dirs) {
  if (ctx.fs === undefined) {
    throw new Error('ops-lite: the host filesystem service (ctx.fs) is not mounted; ops-lite needs it for reads')
  }
  const { defineTool, source } = await loadTools()
  const { readConfig } = await import('./config.js')
  const { buildReadFilesTool, buildTreeTool } = await import('./tools.js')

  const resolved = readConfig(config)
  const definitions = [buildReadFilesTool(ctx, resolved), buildTreeTool(ctx, resolved)]

  const disposers = definitions.map((definition) => ctx.tools.register(defineTool(definition)))

  // Guidance is scoped: it disappears from the prompt when both tools do.
  const sectionDisposer = resolved.promptGuidance
    ? ctx.systemPrompt.section({
      name: 'ops-lite:read',
      // 986 keeps this guidance adjacent to filekit's (985) without tying with it.
      order: 986,
      text: ({ scope }) => {
        const hasRead = ctx.tools.get('ops_read_files', scope) !== undefined
        const hasTree = ctx.tools.get('ops_tree', scope) !== undefined
        if (!hasRead && !hasTree) return ''
        const lines = []
        if (hasRead) {
          lines.push(
            'ops_read_files reads several plain-text files in one call. A path may be a file, a directory, or a glob (* ? **).',
          )
        }
        if (hasTree) {
          lines.push(
            'ops_tree lists a directory as an indented tree in one call (names only; vendor/VCS folders and credentials are skipped).',
          )
        }
        if (hasRead) {
          lines.push(
            'literal opens that file on the first exact match; around is lines of context before the hit (default 20).',
            'CSV/TSV/DOCX/XLSX/PDF go to the filekit readers, not here.',
            'pending > 0 means resend the files not yet returned; a file with more lines continues at its nextOffset.',
            'A clipped line is incomplete, and retry: never means inspect the reported state before calling again.',
          )
        }
        return lines.join('\n')
      },
    })
    : undefined

  ctx.effect(() => () => {
    if (typeof sectionDisposer === 'function') {
      try { sectionDisposer() } catch (error) {
        ctx.logger.warn('ops-lite: prompt section disposal failed: %s', error?.message ?? String(error))
      }
    }
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) {
        ctx.logger.warn('ops-lite: tool disposal failed: %s', error?.message ?? String(error))
      }
    }
  }, 'ops-lite registrations')

  if (resolved.statusFile !== false) {
    try {
      let version = 'unknown'
      try {
        version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version ?? version
      } catch {
        /* a missing version is not a load failure */
      }
      const statusFile = resolved.statusFile
      mkdirSync(dirname(statusFile), { recursive: true })
      writeFileSync(statusFile, JSON.stringify({
        loaded_at: new Date().toISOString(),
        pid: process.pid,
        plugin_version: version,
        tools: definitions.map((definition) => definition.name),
        define_tool_source: source,
        state_root: stateProvenance(),
        config: resolved,
        dirs,
      }, null, 2), 'utf8')
    } catch (error) {
      ctx.logger.warn('ops-lite: cannot write the status file: %s', error?.message ?? String(error))
    }
  }

  const toolNames = definitions.map((definition) => definition.name)
  ctx.logger.info('ops-lite: registered %d tool(s): %s', toolNames.length, toolNames.join(', '))
  return definitions
}
