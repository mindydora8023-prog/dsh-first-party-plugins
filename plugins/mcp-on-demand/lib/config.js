/**
 * mcp-on-demand: let the MODEL decide when an MCP server is loaded.
 *
 * The problem it solves. DSH's own @deepseek-ai/dsh-mcp-manager mounts every
 * entry in its `servers` map at host start and keeps it running. A 170-tool
 * server such as REA then sits in every request's tool list all day, which is
 * paid for in prompt tokens whether or not the task touches reverse
 * engineering. The old workaround (magpie's library + `agents: []`) required a
 * human to flip a switch before and after each use.
 *
 * What this plugin does. It keeps the server DEFINITIONS in its own config and
 * registers one only when the model calls `mcp_enable`. `ctx.mcpManager.register()`
 * returns a disposer, so `mcp_disable` unregisters the server and withdraws its
 * tools again. Tools therefore appear and disappear mid-session with no host
 * restart and no human in the loop.
 *
 * Two safety nets:
 *   - `ttlMs` per server (or `defaultTtlMs`): an enabled server disposes itself
 *     after that long, so a model that forgets `mcp_disable` cannot leak a
 *     Ghidra-backed child process for the rest of the day.
 *   - unload: every live registration is disposed when the plugin unmounts.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { statePath } from './state-dir.js'

/** MCP server names the manager accepts. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const DEFAULT_TTL_MS = 15 * 60 * 1000

/** How many servers may be connecting at once. Two Ghidra processes is already a lot. */
const DEFAULT_MAX_CONCURRENT = 2

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one server definition. Anything the manager would reject is
 * rejected here, at load time, with the server named in the message.
 *
 * @param {string} name
 * @param {unknown} raw
 * @returns {{ entry: object, ttlMs: number }}
 */
function normalizeServer(name, raw) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`mcp-on-demand: server name ${JSON.stringify(name)} must match ${NAME_PATTERN}`)
  }
  if (!isRecord(raw)) throw new Error(`mcp-on-demand: server ${name} must be an object`)

  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error(`mcp-on-demand: server ${name} needs transport "stdio" or "streamable-http"`)
  }

  /** @type {Record<string, unknown>} */
  const entry = { transport }

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      throw new Error(`mcp-on-demand: stdio server ${name} needs a command`)
    }
    entry.command = raw.command
    if (Array.isArray(raw.args)) entry.args = raw.args.map(String)
    if (isRecord(raw.env)) entry.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
    if (typeof raw.cwd === 'string' && raw.cwd !== '') entry.cwd = raw.cwd
  } else {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') {
      throw new Error(`mcp-on-demand: streamable-http server ${name} needs a url`)
    }
    entry.url = raw.url
    if (isRecord(raw.headers)) entry.headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]))
  }

  if (Number.isFinite(raw.startupTimeoutMs) && raw.startupTimeoutMs > 0) entry.startupTimeoutMs = raw.startupTimeoutMs
  if (Number.isFinite(raw.toolCallTimeoutMs) && raw.toolCallTimeoutMs > 0) entry.toolCallTimeoutMs = raw.toolCallTimeoutMs

  const ttlMs = Number.isFinite(raw.ttlMs) && raw.ttlMs >= 0 ? raw.ttlMs : undefined
  const description = typeof raw.description === 'string' ? clampText(raw.description, 240) : ''
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item) => typeof item === 'string').map((item) => clampText(item, 40)).filter(Boolean).slice(0, 12)
    : []
  return { entry, ttlMs, description, keywords }
}

/** One line, capped. Config text is shown to the model, so it stays short. */
function clampText(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string | false}
 */
function catalogFileOf(config) {
  if (config.catalogFile === false) return false
  if (typeof config.catalogFile === 'string' && config.catalogFile.trim() !== '') return config.catalogFile.trim()
  return statePath('mcp-on-demand', 'catalog.json')
}

/**
 * @param {Record<string, unknown>} config
 * @returns {number}
 */
function maxConcurrentOf(config) {
  const value = config.maxConcurrent
  if (Number.isInteger(value) && value >= 1 && value <= 4) return value
  return DEFAULT_MAX_CONCURRENT
}

/**
 * Read and validate this plugin's config.
 *
 * @param {unknown} raw
 * @returns {{ servers: Record<string, { entry: object, ttlMs: number, description: string, keywords: string[] }>, defaultTtlMs: number, catalogFile: string | false, maxConcurrent: number }}
 */
export function readConfig(raw) {
  const config = isRecord(raw) ? raw : {}
  const source = isRecord(config.servers) ? config.servers : {}
  const defaultTtlMs = Number.isFinite(config.defaultTtlMs) && config.defaultTtlMs >= 0 ? config.defaultTtlMs : DEFAULT_TTL_MS
  /** @type {Record<string, { entry: object, ttlMs: number, description: string, keywords: string[] }>} */
  const servers = {}
  for (const [name, value] of Object.entries(source)) {
    const normalized = normalizeServer(name, value)
    servers[name] = {
      entry: normalized.entry,
      ttlMs: normalized.ttlMs ?? defaultTtlMs,
      description: normalized.description,
      keywords: normalized.keywords,
    }
  }
  return {
    servers,
    defaultTtlMs,
    catalogFile: catalogFileOf(config),
    maxConcurrent: maxConcurrentOf(config),
  }
}
