/**
 * Turn a Magpie /v1/models listing into the two llm-pi-ai catalogs DSH
 * actually shows in the picker. Pure: no fetch, no profile writes.
 *
 * DSH replaces a custom route's `models` wholesale and never stores the
 * discovery response, so the picker stays stale unless something writes the
 * patch. This module is that something's decision, kept separate from I/O.
 */

/** pi-ai thinking levels, low to high. `ultra` is not one of them. */
export const THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

const MODALITIES = new Set(['text', 'image'])

const CHAT_ENDPOINT = '/v1/chat/completions'
const RESPONSES_ENDPOINT = '/v1/responses'

/**
 * @param {unknown} body
 * @returns {object[]} gateway model records, in listed order.
 */
export function modelsFromBody(body) {
  if (body == null || typeof body !== 'object') return []
  const data = body.data
  if (Array.isArray(data)) return data.filter((row) => row != null && typeof row === 'object')
  const models = body.models
  if (Array.isArray(models)) return models.filter((row) => row != null && typeof row === 'object')
  return []
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Map one advertised effort onto a picker level and the wire spelling DSH sends.
 * `none` is the off switch written as `off: none` (what the old hand-written
 * catalog used). `off` itself may leave the wire value empty. `ultra` collapses
 * onto `max` because pi-ai has no ultra level; a real `max` keeps the key.
 * @param {string} raw
 * @returns {{ level: string, wire: string|null }|undefined}
 */
function effortOf(raw) {
  if (raw === 'none') return { level: 'off', wire: 'none' }
  if (raw === 'off') return { level: 'off', wire: null }
  if (raw === 'ultra') return { level: 'max', wire: 'ultra' }
  if (THINKING_LEVELS.includes(raw)) return { level: raw, wire: raw }
  return undefined
}

/**
 * @param {object} record
 * @returns {Record<string, string|null>|undefined}
 */
function reasoningEffortsOf(record) {
  /** @type {{ level: string, wire: string|null, exact: boolean }[]} */
  const found = []
  const rich = record.supported_reasoning_levels
  const plain = record.reasoning_levels
  const source = Array.isArray(rich) && rich.length > 0 ? rich : plain
  if (!Array.isArray(source)) return undefined
  for (const item of source) {
    const raw = typeof item === 'string' ? item : item?.effort
    if (typeof raw !== 'string' || raw.length === 0) continue
    const mapped = effortOf(raw)
    if (mapped === undefined) continue
    found.push({ ...mapped, exact: mapped.wire === mapped.level })
  }
  if (found.length === 0) return undefined
  /** @type {Record<string, string|null>} */
  const efforts = {}
  for (const level of THINKING_LEVELS) {
    const hits = found.filter((item) => item.level === level)
    if (hits.length === 0) continue
    const chosen = hits.find((item) => item.exact) ?? hits[0]
    efforts[level] = chosen.wire
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * @param {object} record
 * @returns {string[]|undefined}
 */
function inputOf(record) {
  const listed = record.modalities?.input
  if (!Array.isArray(listed)) return ['text']
  const input = []
  for (const item of listed) {
    if (typeof item === 'string' && MODALITIES.has(item) && !input.includes(item)) input.push(item)
  }
  return input.length > 0 ? input : ['text']
}

/**
 * @param {object} record
 * @returns {'chat'|'responses'|undefined}
 */
function routeOf(record) {
  const endpoints = Array.isArray(record.native_endpoints) ? record.native_endpoints : []
  const has = (needle) => endpoints.some((item) => item === needle)
  if (has(RESPONSES_ENDPOINT)) return 'responses'
  if (has(CHAT_ENDPOINT)) return 'chat'
  return undefined
}

/**
 * @param {object} record
 * @param {'chat'|'responses'} route
 * @returns {object|undefined}
 */
export function modelEntry(record, route) {
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 200) return undefined
  const label = typeof record.magpie_label === 'string' && record.magpie_label.length > 0
    ? record.magpie_label
    : typeof record.display_name === 'string' && record.display_name.length > 0
      ? record.display_name
      : record.id
  /** @type {Record<string, unknown>} */
  const entry = { id: record.id, name: label }
  const contextWindow = positiveInt(record.context_window) ?? positiveInt(record.context_length)
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  const maxTokens = positiveInt(record.max_output_tokens)
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  entry.input = inputOf(record)
  const efforts = reasoningEffortsOf(record)
  if (efforts !== undefined) entry.reasoningEfforts = efforts
  if (route === 'responses') entry.compat = { supportsStrictMode: true }
  return entry
}

/**
 * @param {object[]} records
 * @param {{ chatProvider: string, responsesProvider: string }} targets
 * @returns {Record<string, object[]>}
 */
export function assignModels(records, targets) {
  const chat = []
  const responses = []
  const seen = new Set()
  for (const record of records) {
    const route = routeOf(record)
    if (route === undefined) continue
    const entry = modelEntry(record, route)
    if (entry === undefined || seen.has(entry.id)) continue
    seen.add(entry.id)
    if (route === 'responses') responses.push(entry)
    else chat.push(entry)
  }
  return {
    [targets.chatProvider]: chat,
    [targets.responsesProvider]: responses,
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  if (value != null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Keep a hand-written field the gateway did not repeat (output cap, compat).
 * @param {object|undefined} previous
 * @param {object} discovered
 * @returns {object}
 */
function mergeModel(previous, discovered) {
  /** @type {Record<string, unknown>} */
  const model = {
    id: discovered.id,
    name: discovered.name,
  }
  const contextWindow = discovered.contextWindow ?? previous?.contextWindow
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = discovered.maxTokens ?? previous?.maxTokens
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  model.input = discovered.input
  if (discovered.reasoningEfforts !== undefined) model.reasoningEfforts = discovered.reasoningEfforts
  else if (previous?.reasoningEfforts !== undefined) model.reasoningEfforts = previous.reasoningEfforts
  if (discovered.compat !== undefined) model.compat = discovered.compat
  else if (previous?.compat !== undefined) model.compat = previous.compat
  return model
}

/**
 * @param {Record<string, object>} providers live llm-pi-ai providers dict
 * @param {Record<string, object[]>} assigned
 * @returns {{ providers: Record<string, object>, changed: boolean, summary: object[] }}
 */
export function mergeProviders(providers, assigned) {
  const next = { ...providers }
  /** @type {object[]} */
  const summary = []
  let changed = false
  for (const [providerId, discovered] of Object.entries(assigned)) {
    if (!Array.isArray(discovered) || discovered.length === 0) {
      summary.push({ providerId, action: 'kept', reason: 'empty-listing' })
      continue
    }
    const current = providers?.[providerId]
    if (current == null || typeof current !== 'object' || Array.isArray(current)) {
      summary.push({ providerId, action: 'skipped', reason: 'provider-missing' })
      continue
    }
    const previous = Array.isArray(current.models) ? current.models : []
    const byId = new Map(discovered.map((model) => [model.id, model]))
    const kept = []
    const seen = new Set()
    for (const model of previous) {
      if (typeof model?.id !== 'string' || !byId.has(model.id)) continue
      kept.push(mergeModel(model, byId.get(model.id)))
      seen.add(model.id)
    }
    for (const model of discovered) {
      if (seen.has(model.id)) continue
      kept.push(mergeModel(undefined, model))
    }
    if (stable(kept) === stable(previous)) {
      summary.push({ providerId, action: 'unchanged', count: kept.length })
      continue
    }
    next[providerId] = { ...current, models: kept }
    changed = true
    summary.push({
      providerId,
      action: 'updated',
      count: kept.length,
      ids: kept.map((model) => model.id),
    })
  }
  return { providers: changed ? next : providers, changed, summary }
}
