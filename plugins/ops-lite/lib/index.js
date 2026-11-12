/**
 * ops-lite host side.
 *
 * One tool: `ops_read_files`. It exists to prove four behaviours that dsh-ops
 * established and that the rest of this workspace should inherit:
 *
 *   1. structured failures -- a call returns {status, error.code, effectState,
 *      retry, nextAction} instead of throwing a bare Error;
 *   2. a two-level output budget -- per line, per file and per call, all
 *      measured in ESCAPED bytes, with a concrete resume instruction;
 *   3. a compact multi-file receipt -- one shared Base, one revision per file;
 *   4. two independent completeness levels -- batch pending vs per-file complete.
 *
 * Deliberately NOT here (see README for why): progressive disclosure,
 * discovery/PTC projections, a bundled shell, or replacing official tools.
 * Those are the parts of dsh-ops that its own issue tracker documents as the
 * source of O(N) prompt reassembly. This plugin registers a constant set of
 * tools once and never reassembles anything.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * The bundled copy in `lib/define.js` is used directly. Probing for a host copy
 * was measured on 2026-10-26 and EVERY candidate failed -- the bare specifier
 * throws ERR_MODULE_NOT_FOUND (this `link:` plugin resolves from outside the
 * profile) and the absolute paths do not exist -- so this returned `bundled` on
 * every load while paying for `existsSync` calls and a swallowed import each time.
 *
 * The probe survives behind `DSH_PROBE_HOST_TOOLS=1` so a future host layout that
 * does ship an importable copy can be diagnosed instead of guessed at.
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
  const local = await import('./define.js')
  return { defineTool: local.defineTool, source: 'bundled' }
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
 * Register the tool and its prompt guidance, and announce what loaded.
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
  const { buildReadFilesTool } = await import('./tools.js')

  const resolved = readConfig(config)
  const definition = buildReadFilesTool(ctx, resolved)

  const dispose = ctx.tools.register(defineTool(definition))

  // Guidance is scoped: it disappears from the prompt when the tool does.
  const sectionDisposer = resolved.promptGuidance
    ? ctx.systemPrompt.section({
      name: 'ops-lite:read',
      // 986 keeps this guidance adjacent to filekit's (985) without tying with
      // it: equal orders would fall back to registration order, which is not a
      // contract worth relying on across two separate plugins.
      order: 986,
      text: ({ scope }) => {
        if (ctx.tools.get('ops_read_files', scope) === undefined) return ''
        return [
          'ops_read_files is the way to read plain text files: several in one bounded call, each with its own offset/limit.',
          'Use it instead of a burst of single-file reads. CSV/TSV/DOCX/XLSX/PDF are NOT read here -- use the filekit document readers.',
          'Every file reports complete/nextOffset and the call reports pending, so a partial read is visible as partial:',
          '- when pending > 0, resend the remaining entries from that index;',
          '- when a file says more lines, continue at its nextOffset;',
          '- when a line says it was clipped, that line is incomplete and the next offset will not recover its suffix.',
          'A failure carries effectState and retry; `retry: never` means call again only after inspecting state.',
        ].join('\n')
      },
    })
    : undefined

  ctx.effect(() => () => {
    if (typeof sectionDisposer === 'function') {
      try { sectionDisposer() } catch (error) {
        ctx.logger.warn('ops-lite: prompt section disposal failed: %s', error?.message ?? String(error))
      }
    }
    try { dispose() } catch (error) {
      ctx.logger.warn('ops-lite: tool disposal failed: %s', error?.message ?? String(error))
    }
  }, 'ops-lite registrations')

  // A small on-disk receipt: which code actually loaded, and with what. This is
  // the cheapest way to answer "is the running host using the new build?".
  //
  // `resolved.statusFile` is `false` when the caller disabled it (tests do), and
  // otherwise points at the per-user state directory -- NOT this plugin's source
  // tree. That matters: the source directory is mirrored to git, and before
  // 2026-10-26 this block ignored the setting and always wrote here, so a test
  // run silently overwrote the file the live host had written.
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
        tools: [definition.name],
        define_tool_source: source,
        state_root: stateProvenance(),
        config: resolved,
        dirs,
      }, null, 2), 'utf8')
    } catch (error) {
      ctx.logger.warn('ops-lite: cannot write the status file: %s', error?.message ?? String(error))
    }
  }

  ctx.logger.info('ops-lite: registered %s', definition.name)
  return [definition]
}
