/**
 * Keep the DSH model picker aligned with the Magpie gateway listing.
 *
 * The picker reads llm-pi-ai `providers.*.models` from the profile patch.
 * Discovery in the settings UI does not persist. This plugin polls
 * GET {baseURL}/models and, only when the catalog actually differs, asks
 * configEditor to replace those two model lists. An empty or failed listing
 * leaves the patch alone.
 *
 * No Config schema import: a link: plugin cannot resolve host packages.
 * ASCII only: see the workspace encoding rule.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { assignModels, mergeProviders, modelsFromBody } from './plan.js'

/**
 * @returns {string}
 */
function statusFile() {
  const override = process.env.DSH_PLUGIN_STATE_DIR
  const root = typeof override === 'string' && override.trim() !== ''
    ? override.trim()
    : process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'dsh-plugins')
      : join(tmpdir(), 'dsh-plugins')
  return join(root, 'magpie-models', 'status.json')
}

/**
 * @param {object} status
 */
function writeStatus(status) {
  const file = statusFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...status }, null, 2)}\n`)
}

export const name = 'magpie-models'

const DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 300000,
  timeoutMs: 10000,
  baseURL: 'http://127.0.0.1:3425/v1',
  apiKeyEnv: 'MAGPIE_GATEWAY_KEY',
  chatProvider: 'magpie',
  responsesProvider: 'magpie-responses',
  llmEntryId: 'llm-pi-ai',
})

/** Thrown inside configEditor.edit so an unchanged catalog is not rewritten. */
class UnchangedCatalog extends Error {
  constructor() {
    super('catalog unchanged')
    this.name = 'UnchangedCatalog'
  }
}

/**
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function readConfig(raw) {
  const source = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULTS }
  if (source.enabled === false) config.enabled = false
  if (Number.isSafeInteger(source.intervalMs) && source.intervalMs >= 15000) config.intervalMs = source.intervalMs
  if (Number.isSafeInteger(source.timeoutMs) && source.timeoutMs >= 1000) config.timeoutMs = source.timeoutMs
  if (typeof source.baseURL === 'string' && source.baseURL.trim() !== '') config.baseURL = source.baseURL
  if (typeof source.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]*$/.test(source.apiKeyEnv)) config.apiKeyEnv = source.apiKeyEnv
  if (typeof source.chatProvider === 'string' && source.chatProvider.trim() !== '') config.chatProvider = source.chatProvider.trim()
  if (typeof source.responsesProvider === 'string' && source.responsesProvider.trim() !== '') {
    config.responsesProvider = source.responsesProvider.trim()
  }
  if (typeof source.llmEntryId === 'string' && source.llmEntryId.trim() !== '') config.llmEntryId = source.llmEntryId.trim()
  return config
}

/**
 * @param {string} baseURL
 * @returns {string}
 */
function listingUrl(baseURL) {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  return `${trimmed}/models`
}

/**
 * @param {string} url
 * @param {string} apiKeyEnv
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function fetchListing(url, apiKeyEnv, timeoutMs) {
  const headers = { accept: 'application/json' }
  const apiKey = process.env[apiKeyEnv]
  if (typeof apiKey === 'string' && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  if (config.enabled === false) {
    ctx.logger?.info('magpie-models: disabled')
    return
  }
  if (config.chatProvider === config.responsesProvider) {
    ctx.logger?.error('magpie-models: chatProvider and responsesProvider must differ')
    return
  }

  const url = listingUrl(config.baseURL)
  let stopped = false
  let timer
  let running = false

  const schedule = (delay) => {
    if (stopped) return
    timer = setTimeout(() => {
      void run().finally(() => schedule(config.intervalMs))
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const run = async () => {
    if (stopped || running) return
    running = true
    /** @type {object} */
    let status = { phase: 'started', url }
    try {
      const body = await fetchListing(url, config.apiKeyEnv, config.timeoutMs)
      const records = modelsFromBody(body)
      const assigned = assignModels(records, {
        chatProvider: config.chatProvider,
        responsesProvider: config.responsesProvider,
      })
      const editor = ctx.get?.('configEditor')
      if (editor == null || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
        throw new Error('configEditor is not available')
      }
      const entry = editor.entries().find((item) => item?.options?.id === config.llmEntryId)
      if (entry == null) throw new Error(`profile entry "${config.llmEntryId}" is not addressable`)
      const preview = mergeProviders(entry.options?.config?.providers ?? {}, assigned)
      if (!preview.changed) {
        status = { phase: 'unchanged', url, summary: preview.summary }
        ctx.logger?.info('magpie-models: catalog matches %s', url)
        return
      }
      try {
        // providers is a volatile field. Rewriting the whole config object makes
        // the editor compare against a recomposed document that fills schema
        // defaults, and that comparison rejects the write as an overlay. Touch
        // only the routes whose model list actually changed.
        await editor.edit(entry, (current) => {
          const result = mergeProviders(current?.providers ?? {}, assigned)
          if (!result.changed) throw new UnchangedCatalog()
          const providers = { ...current?.providers }
          for (const item of result.summary) {
            if (item.action === 'updated') providers[item.providerId] = result.providers[item.providerId]
          }
          return { ...current, providers }
        })
      } catch (error) {
        if (error instanceof UnchangedCatalog) {
          status = { phase: 'unchanged', url, during: 'edit' }
          ctx.logger?.info('magpie-models: catalog matches %s', url)
          return
        }
        throw error
      }
      status = { phase: 'updated', url, summary: preview.summary }
      const updated = preview.summary.filter((item) => item.action === 'updated')
      ctx.logger?.info(
        'magpie-models: updated %s',
        updated.map((item) => `${item.providerId} (${item.ids.join(', ')})`).join('; '),
      )
    } catch (error) {
      status = { phase: 'failed', url, error: error?.message ?? String(error) }
      ctx.logger?.warn('magpie-models: sync skipped: %s', error?.message ?? String(error))
    } finally {
      running = false
      try {
        writeStatus(status)
      } catch (error) {
        ctx.logger?.warn('magpie-models: status write failed: %s', error?.message ?? String(error))
      }
    }
  }

  // effect() runs its callback now and keeps the returned function as the
  // disposer. Passing the cleanup itself made the first sync look stopped.
  ctx.effect?.(() => () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  })

  void run().finally(() => schedule(config.intervalMs))
}
