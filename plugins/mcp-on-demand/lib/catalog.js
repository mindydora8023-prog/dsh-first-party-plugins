/**
 * On-disk catalog of MCP tool names.
 *
 * The model should learn what a server offers without leaving that server
 * mounted. Names (and a short description, when the host already has one)
 * are remembered here. Schemas are not: those are the bytes this plugin
 * exists to keep out of the prompt.
 *
 * Entries older than CATALOG_MAX_AGE_MS are stale. A stale name is worse
 * than no name, because the model will call a tool the server no longer has.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { readJsonFileBoundedSync, writeJsonAtomicSync } from './json-store.js'

/** How many tools one server keeps. The rest are counted, not stored. */
export const CATALOG_TOOL_CAP = 80

/** Descriptions are untrusted server text. Keep one short line. */
export const CATALOG_DESC_CAP = 160

/** A week. After that, mcpod_find ignores the entry until a new probe. */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Bounded ceiling for reading the catalog JSON file (1 MiB). */
const CATALOG_MAX_BYTES = 1024 * 1024

/** @returns {{ servers: Record<string, object> }} */
export function emptyCatalog() {
  return { servers: {} }
}

/**
 * @param {string | false | undefined} file
 * @returns {{ servers: Record<string, object> }}
 */
export function readCatalog(file) {
  if (typeof file !== 'string' || file === '') return emptyCatalog()
  const parsed = readJsonFileBoundedSync(file, { maxBytes: CATALOG_MAX_BYTES, fallback: null })
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyCatalog()
  if (!parsed.servers || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) return emptyCatalog()
  return { servers: parsed.servers }
}

/**
 * Atomic replace via unique temp file and Windows-safe swap fallback.
 *
 * @param {string | false | undefined} file
 * @param {{ servers: Record<string, object> }} catalog
 */
export function writeCatalog(file, catalog) {
  if (typeof file !== 'string' || file === '') return
  writeJsonAtomicSync(file, catalog, { spaces: 0 })
}

/** Collapse whitespace so a tool description cannot break the prompt layout. */
export function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Tool name as the server knows it, without the host's mcp__ prefix.
 *
 * @param {string} server
 * @param {string} toolName
 */
export function localName(server, toolName) {
  const prefix = `mcp__${server}__`
  return typeof toolName === 'string' && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName
}

/**
 * @param {unknown} tools
 * @returns {{ name: string, description: string }[]}
 */
export function normalizeTools(server, tools) {
  const rows = Array.isArray(tools) ? tools : []
  /** @type {Map<string, { name: string, description: string }>} */
  const byName = new Map()
  for (const row of rows) {
    const raw = typeof row === 'string' ? row : row?.name
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const name = oneLine(localName(server, raw), 80)
    if (name === '') continue
    const description = oneLine(typeof row === 'object' && row ? row.description : '', CATALOG_DESC_CAP)
    const prior = byName.get(name)
    if (prior === undefined || (prior.description === '' && description !== '')) {
      byName.set(name, { name, description })
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * @param {{ servers: Record<string, object> }} catalog
 * @param {string} server
 * @param {{ ok: boolean, tools?: unknown, toolCount?: number, truncated?: boolean, error?: string }} probe
 */
export function remember(catalog, server, probe) {
  const tools = normalizeTools(server, probe.tools).slice(0, CATALOG_TOOL_CAP)
  const toolCount = Number.isFinite(probe.toolCount) && probe.toolCount >= tools.length
    ? Math.round(probe.toolCount)
    : tools.length
  /** @type {Record<string, unknown>} */
  const record = {
    at: Date.now(),
    ok: probe.ok === true,
    toolCount,
    truncated: probe.truncated === true || toolCount > tools.length,
    tools,
  }
  if (probe.ok !== true) record.error = oneLine(probe.error, 200)
  catalog.servers[server] = record
  return record
}

/**
 * Record a failed probe. If an existing `ok: true` entry with tools is already
 * cached, preserve those known tools and record `lastError` instead of wiping
 * a valid catalog.
 *
 * @param {{ servers: Record<string, object> }} catalog
 * @param {string} server
 * @param {string} error
 * @param {number} [now]
 */
export function rememberFailure(catalog, server, error, now = Date.now()) {
  const message = oneLine(error, 200)
  const existing = catalog?.servers?.[server]
  if (existing && typeof existing === 'object' && existing.ok === true && Array.isArray(existing.tools) && existing.tools.length > 0) {
    const updated = {
      ...existing,
      lastError: message,
      lastErrorAt: now,
    }
    catalog.servers[server] = updated
    return updated
  }
  return remember(catalog, server, { ok: false, error: message, tools: [], toolCount: 0 })
}

/**
 * @param {object | undefined} record
 * @param {number} [now]
 */
export function summaryOf(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return undefined
  const at = typeof record.at === 'number' ? record.at : 0
  const tools = Array.isArray(record.tools) ? record.tools : []
  const error = typeof record.error === 'string' && record.error !== ''
    ? record.error
    : (typeof record.lastError === 'string' ? record.lastError : '')
  return {
    at,
    stale: !(at > 0 && now - at < CATALOG_MAX_AGE_MS),
    ok: record.ok === true,
    toolCount: Number.isFinite(record.toolCount) ? record.toolCount : tools.length,
    truncated: record.truncated === true,
    tools,
    error,
    lastError: typeof record.lastError === 'string' ? record.lastError : '',
  }
}

function tokenizeQuery(query) {
  const raw = String(query ?? '').trim().toLowerCase()
  if (raw === '') return []
  // Split on whitespace and ASCII punctuation so CJK / non-ASCII queries and
  // 1-character queries remain intact instead of collapsing into [].
  return raw.split(/[\s,.;:!?/\\|()[\]{}<>"'`~@#$%^&*+=]+/).filter((term) => term.length > 0)
}

function isServerAllowed(server, allowed) {
  if (allowed === undefined || allowed === null) return true
  if (allowed instanceof Set) return allowed.has(server)
  if (Array.isArray(allowed)) return allowed.includes(server)
  if (typeof allowed === 'object') return Object.prototype.hasOwnProperty.call(allowed, server)
  return true
}

/**
 * @param {{ servers: Record<string, object> }} catalog
 * @param {string} query
 * @param {{ limit?: number, now?: number, allowedServers?: Set<string> | string[] | Record<string, unknown>, aboutOf?: Function, keywordsOf?: Function }} [options]
 */
export function searchCatalog(catalog, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 20) : 12
  const now = options.now ?? Date.now()
  const terms = tokenizeQuery(query)
  if (terms.length === 0) return []
  /** @type {{ server: string, tool: string, call: string, description: string }[]} */
  const hits = []
  const servers = catalog && catalog.servers && typeof catalog.servers === 'object' ? catalog.servers : {}
  for (const [server, record] of Object.entries(servers)) {
    if (!isServerAllowed(server, options.allowedServers)) continue
    const summary = summaryOf(record, now)
    if (!summary || summary.stale || !summary.ok) continue
    const keywords = Array.isArray(options.keywordsOf?.(server)) ? options.keywordsOf(server).join(' ') : ''
    const about = typeof options.aboutOf?.(server) === 'string' ? options.aboutOf(server) : ''
    const serverHay = `${server} ${about} ${keywords}`.toLowerCase()
    if (terms.every((term) => serverHay.includes(term)) && summary.tools.length === 0) {
      hits.push({ server, tool: '', call: '', description: about })
      if (hits.length >= limit) return hits
      continue
    }
    for (const tool of summary.tools) {
      if (!tool || typeof tool.name !== 'string') continue
      const hay = `${serverHay} ${tool.name} ${tool.description || ''}`.toLowerCase()
      if (!terms.every((term) => hay.includes(term))) continue
      hits.push({
        server,
        tool: tool.name,
        call: `mcp__${server}__${tool.name}`,
        description: typeof tool.description === 'string' ? tool.description : '',
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/**
 * Short prompt text. Names only: descriptions are untrusted and stay in
 * mcpod_find, which the model asks for.
 *
 * @param {Record<string, unknown>} servers configured server map
 * @param {{ servers: Record<string, object> }} catalog
 * @param {number} [now]
 */
export function catalogPrompt(servers, catalog, now = Date.now()) {
  const names = Object.keys(servers || {})
  if (names.length === 0) return ''
  const lines = [
    'MCP servers configured here are not connected. Their tools are absent until mcpod_enable mounts one.',
    'Use mcpod_find to search the catalog, or mcpod_probe to record names without leaving the server mounted.',
  ]
  const shown = names.slice(0, 12)
  for (const name of shown) {
    const summary = summaryOf(catalog?.servers?.[name], now)
    const defined = servers[name]
    const blurb = defined && typeof defined.description === 'string' && defined.description !== ''
      ? `${defined.description}. `
      : ''
    if (!summary || summary.stale || !summary.ok) {
      const why = summary && !summary.ok && summary.error ? ` Last probe failed: ${summary.error}` : ''
      lines.push(`- ${name}: ${blurb}no current catalog.${why}`)
      continue
    }
    const sample = summary.tools.slice(0, 6).map((tool) => tool.name).filter(Boolean).join(', ')
    const held = summary.truncated ? `${summary.tools.length} of ${summary.toolCount}` : String(summary.toolCount)
    lines.push(`- ${name}: ${blurb}${held} tools cached (${sample}). Mount before calling mcp__${name}__*.`)
  }
  if (names.length > shown.length) lines.push(`- ${names.length - shown.length} more server(s): call mcpod_list.`)
  return lines.join('\n')
}
