/**
 * Price-catalog helpers for dsh-plugin-session-meter (Host half).
 *
 * Converts models.dev USD-per-million quotes into CNY per million, indexes
 * provider-qualified + bare + canonical keys, and attaches a pre-computed
 * `Map<normalizedKey, string[]>` so `verifiedFallback()` resolves in O(1)
 * instead of scanning ~11,000 keys per candidate.
 *
 * Pure functions only - no I/O - so they can be unit-tested directly.
 */
import {
  RELEASE_SUFFIX,
  nameCandidates,
  normalizeModelKey,
} from './model-names.js';

export { nameCandidates, normalizeModelKey };

/** Marks a model id that the built-in peak/off-peak table owns. */
const DEEPSEEK_MARKER = 'deepseek';

/**
 * Trailing segments that carry model identity (tier / capability / modality),
 * never distribution noise.
 */
const MEANINGFUL_TAIL = new Set([
  'flash', 'pro', 'mini', 'nano', 'micro', 'turbo', 'max', 'ultra', 'plus',
  'lite', 'air', 'code', 'coder', 'vision', 'image', 'audio', 'video',
  'instruct', 'chat', 'base', 'small', 'medium', 'large', 'reasoning',
  'thinking', 'open', 'fast', 'spark', 'preview', 'beta', 'alpha',
]);

/**
 * Pre-indexed `Map<normalizedKey, string[]>` attached weakly to each catalog
 * object so `verifiedFallback()` runs in O(1) instead of O(|models|).
 */
const NORMALIZED_INDEXES = new WeakMap();

function indexKey(index, key) {
  const normalized = normalizeModelKey(key);
  let bucket = index.get(normalized);
  if (bucket === undefined) {
    bucket = [key];
    index.set(normalized, bucket);
  } else {
    bucket.push(key);
  }
}

/** Build or retrieve the O(1) normalized-key index for a catalog object. */
export function getNormalizedIndex(models) {
  let index = NORMALIZED_INDEXES.get(models);
  if (index !== undefined) return index;
  index = new Map();
  for (const key of Object.keys(models)) {
    indexKey(index, key);
  }
  NORMALIZED_INDEXES.set(models, index);
  return index;
}

/** Round to 6 decimals so a converted price stays readable in JSON. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Rescale an already-converted catalog when only the exchange rate moved.
 */
export function scaleRates(models, factor) {
  if (!models || typeof models !== 'object') return Object.create(null);
  if (!Number.isFinite(factor) || factor <= 0) return models;
  if (factor === 1) return models;
  const out = Object.create(null);
  const index = new Map();
  for (const [key, rate] of Object.entries(models)) {
    if (!rate || typeof rate !== 'object') continue;
    const scale = (value) => (typeof value === 'number' && Number.isFinite(value) ? round6(value * factor) : value);
    out[key] = {
      input: scale(rate.input),
      output: scale(rate.output),
      cacheRead: scale(rate.cacheRead),
      cacheWrite: scale(rate.cacheWrite),
    };
    indexKey(index, key);
  }
  NORMALIZED_INDEXES.set(out, index);
  return out;
}

/** One catalog cost entry -> CNY per million tokens. */
export function cnyEntry(cost, usdToCny) {
  if (!cost || typeof cost !== 'object') return undefined;
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return undefined;
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) return undefined;
  if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return undefined;
  const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read) ? cost.cache_read : cost.input;
  const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write) ? cost.cache_write : cost.input;
  const convert = (usd) => round6(usd * usdToCny);
  return {
    input: convert(cost.input),
    output: convert(cost.output),
    cacheRead: convert(cacheRead),
    cacheWrite: convert(cacheWrite),
  };
}

/**
 * models.dev payload -> `{ "<provider>/<model>": rate, "<model>": rate }`,
 * pre-indexing every key into `NORMALIZED_INDEXES` during construction.
 */
export function buildCatalog(modelsDev, usdToCny) {
  const models = Object.create(null);
  const index = new Map();
  const put = (key, rate, overwrite) => {
    const existed = models[key] !== undefined;
    if (!overwrite && existed) return;
    models[key] = rate;
    if (!existed) indexKey(index, key);
  };
  if (!modelsDev || typeof modelsDev !== 'object') {
    NORMALIZED_INDEXES.set(models, index);
    return models;
  }
  for (const [providerId, provider] of Object.entries(modelsDev)) {
    const table = provider && typeof provider === 'object' ? provider.models : undefined;
    if (!table || typeof table !== 'object') continue;
    const providerKey = String(providerId).toLowerCase();
    for (const [modelId, entry] of Object.entries(table)) {
      const id = String(modelId).toLowerCase();
      if (id.length === 0 || id.includes(DEEPSEEK_MARKER)) continue;
      const rate = cnyEntry(entry && typeof entry === 'object' ? entry.cost : undefined, usdToCny);
      if (rate === undefined) continue;
      put(providerKey + '/' + id, rate, true);
      put(id, rate, false);
      const canonical = entry && typeof entry === 'object' && typeof entry.canonical_model_id === 'string'
        ? entry.canonical_model_id.toLowerCase()
        : '';
      if (canonical.length > 0 && !canonical.includes(DEEPSEEK_MARKER)) {
        put(canonical, rate, false);
        const slash = canonical.lastIndexOf('/');
        const tail = slash >= 0 ? canonical.slice(slash + 1) : canonical;
        if (tail.length > 0) put(tail, rate, false);
      }
    }
  }
  NORMALIZED_INDEXES.set(models, index);
  return models;
}

/**
 * O(1) last-resort lookup for a routed id the deterministic candidates missed.
 */
function verifiedFallback(models, name, index) {
  const candidates = nameCandidates(name);
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeModelKey(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const parts = normalized.split('-');
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1];
    if (MEANINGFUL_TAIL.has(last)) continue;
    const stripForms = new Set();
    const noise = normalized.replace(RELEASE_SUFFIX, '');
    if (noise !== normalized) stripForms.add(noise);
    stripForms.add(parts.slice(0, -1).join('-'));
    const matched = [];
    for (const form of stripForms) {
      if (form.split('-')[0] !== parts[0]) continue;
      const keys = index.get(form);
      if (keys === undefined) continue;
      for (const key of keys) {
        matched.push(key);
        if (matched.length > 1) return undefined;
      }
    }
    if (matched.length === 1) return models[matched[0]];
  }
  return undefined;
}

/**
 * Pick the requested models out of the catalog.
 */
export function selectModels(models, names) {
  const hits = Object.create(null);
  if (!models || !Array.isArray(names)) return hits;
  let index;
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue;
    for (const candidate of nameCandidates(name)) {
      const rate = models[candidate];
      if (rate !== undefined) {
        hits[name] = rate;
        break;
      }
    }
    if (hits[name] === undefined) {
      if (index === undefined) index = getNormalizedIndex(models);
      const fallback = verifiedFallback(models, name, index);
      if (fallback !== undefined) hits[name] = fallback;
    }
  }
  return hits;
}

/**
 * Split requested names into `catalog`, `builtin` (DeepSeek), and `unpriced`.
 */
export function classifyNames(names, hits) {
  const catalog = [];
  const builtin = [];
  const unpriced = [];
  if (!Array.isArray(names)) return { catalog, builtin, unpriced };
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (hits && hits[name] !== undefined) {
      catalog.push(name);
    } else if (name.toLowerCase().includes(DEEPSEEK_MARKER)) {
      builtin.push(name);
    } else {
      unpriced.push(name);
    }
  }
  return { catalog, builtin, unpriced };
}

/** USD->CNY out of an exchange-rate payload, or undefined. */
export function usdToCnyOf(payload) {
  const rates = payload && typeof payload === 'object' ? payload.rates : undefined;
  const value = rates && typeof rates === 'object' ? rates.CNY : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
