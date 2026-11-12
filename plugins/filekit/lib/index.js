/**
 * dsh-plugin-filekit host side.
 *
 * Adds four bounded, read-only DOCUMENT tools to DSH:
 *   filekit_read_table  CSV/TSV rows
 *   filekit_read_docx   DOCX main body
 *   filekit_read_xlsx   XLSX worksheet rows
 *   filekit_read_pdf    PDF page text
 *
 * Plain-text multi-file reading is deliberately NOT here: that is ops-lite's
 * `ops_read_files`, removed from this plugin on 2026-10-26 because two tools
 * meaning "read several files" only made the model guess. filekit keeps the
 * format parsers, which ops-lite explicitly does not implement.
 *
 * Design notes (deliberate, learned from the dsh-ops review):
 *   - No progressive disclosure / discovery layer. Registering four tools once is
 *     cheap and constant; a per-agent reconcile that reassembles the system prompt
 *     is the O(N) regression that made dsh-ops 0.4.x stall new sessions, so it is
 *     avoided entirely.
 *   - No PTC projection, no shell, no official-tool replacement. This plugin only
 *     ADDS tools; it never shadows `read`/`grep`/`glob`.
 *   - Reads go through `ctx.fs` so the host sandbox and the read-before-edit table
 *     both apply, and it behaves identically in every sandbox mode.
 *
 * A `link:` plugin lives outside the profile, so `@deepseek-ai/dsh-tools` cannot
 * resolve from its real path; `defineTool` is loaded by probing absolute paths
 * (same approach the sibling gmail plugin uses). `ctx.fs` is provided by the host.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'filekit'

// `fs` is REQUIRED, not optional: cordis throws "cannot get property \"fs\"
// without inject" for any service a plugin reads without declaring it, so
// listing it here is what makes `ctx.fs` reachable at all. It matches the host's
// own dsh-tool-fs, which declares ['tools','fs','systemPrompt'].
export const inject = ['tools', 'systemPrompt', 'fs']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve a `defineTool` implementation.
 *
 * The bundled copy in `lib/define.js` is used directly. It is a faithful port of
 * the host's implementation and is what every load has actually used: probing for
 * a host copy was measured on 2026-10-26 and EVERY candidate failed (the bare
 * specifier throws ERR_MODULE_NOT_FOUND because this `link:` plugin resolves from
 * outside the profile, and the four absolute paths do not exist), so all four
 * plugins reported `define_tool_source: "bundled"` at every startup while paying
 * for `existsSync` calls and a swallowed import on each one.
 *
 * The probe is kept behind `DSH_PROBE_HOST_TOOLS=1` for the case where a future
 * host layout does ship an importable copy: then it is opt-in and diagnosable
 * instead of always-on and invisible.
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
        if (typeof module.defineTool === 'function') return { defineTool: module.defineTool, source: candidate ?? 'bare' }
      } catch {
        /* try the next candidate; the bundled implementation is the fallback */
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
  // The nested inject must repeat every service register() touches, `fs`
  // included: cordis gates each fiber on its own inject list, so an inner
  // ['tools','systemPrompt'] context would throw on `ctx.fs` even though the
  // outer plugin declared it.
  ctx.inject(['tools', 'systemPrompt', 'fs'], (runtimeCtx) => {
    const ready = register(runtimeCtx, config, dirs)
    ready.catch((error) => {
      runtimeCtx.logger.warn('filekit: registration failed: %s', error?.message ?? String(error))
    })
  })
}

async function register(ctx, config, dirs) {
  if (ctx.fs === undefined) {
    throw new Error('filekit: the host filesystem service (ctx.fs) is not mounted; filekit needs it for reads')
  }
  const { defineTool, source } = await loadTools()
  const { readConfig } = await import('./config.js')
  const { buildTools } = await import('./tools.js')
  const resolved = readConfig(config, dirs)
  const definitions = buildTools(resolved, ctx)

  const disposers = []
  for (const definition of definitions) {
    disposers.push(ctx.tools.register(defineTool(definition)))
  }

  const names = definitions.map((tool) => tool.name)
  const sectionDisposer = ctx.systemPrompt.section({
    name: 'filekit',
    order: 985,
    text: ({ scope }) => {
      const visible = names.filter((toolName) => ctx.tools.get(toolName, scope) !== undefined)
      if (visible.length === 0) return ''
      const lines = [
        'filekit is connected through bounded read-only document tools:',
        '- filekit_read_table: paged CSV/TSV rows (auto delimiter and BOM-aware encoding).',
        '- filekit_read_docx: .docx main body as paragraphs and tables.',
        '- filekit_read_xlsx: one worksheet of an .xlsx workbook as a paged table (dates rendered as ISO).',
        '- filekit_read_pdf: PDF page text. Not OCR; scanned pages return no text.',
        'All of them are bounded and pageable: when a result says "Use offset=N to continue", call again with that offset.',
        'For plain text files use ops_read_files (ops-lite) instead: it reads several files in one call with per-file',
        'windows and reports structured per-file completeness. filekit no longer duplicates that tool.',
      ]
      return `Available: ${visible.join(', ')}.\n${lines.slice(1).join('\n')}`
    },
  })

  ctx.effect(() => () => {
    if (typeof sectionDisposer === 'function') {
      try { sectionDisposer() } catch (error) {
        ctx.logger.warn('filekit: system prompt disposal failed: %s', error?.message ?? String(error))
      }
    }
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) {
        ctx.logger.warn('filekit: tool disposal failed: %s', error?.message ?? String(error))
      }
    }
  }, 'filekit tool registrations')

  if (resolved.statusFile !== false) {
    try {
      let version = 'unknown'
      try {
        version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version ?? version
      } catch {
        /* a missing version is not a load failure */
      }
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(dirname(resolved.statusFile), { recursive: true })
      writeFileSync(
        resolved.statusFile,
        JSON.stringify(
          {
            loaded_at: new Date().toISOString(),
            pid: process.pid,
            plugin_version: version,
            tools: names,
            has_fs_service: true,
            define_tool_source: source,
            profile_dir: resolved.dirs.profileDir,
            plugin_dir: resolved.dirs.pluginDir,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (error) {
      ctx.logger.warn('filekit: cannot write the status file: %s', error?.message ?? String(error))
    }
  }

  ctx.logger.info('filekit: registered %d tool(s): %s', definitions.length, names.join(', '))
  return definitions
}
