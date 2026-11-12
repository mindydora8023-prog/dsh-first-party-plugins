/**
 * Price-catalog helpers for dsh-plugin-session-meter (Host half).
 *
 * The online catalog (models.dev) quotes USD per million tokens; this module
 * converts it to the CNY numbers the pill shows and indexes it by the names a
 * route actually reports (`provider/model` plus bare model id), so a relay name
 * such as `codex/gpt-6.1-sol` can be looked up without the client shipping the
 * whole catalog.
 *
 * DeepSeek entries are deliberately dropped: the plugin owns the official
 * peak/off-peak DeepSeek table (checked against the pricing page) and must not
 * let a catalog snapshot with a single base price override it.
 *
 * Pure functions only - no I/O - so they can be unit-tested directly.
 */

/** Marks a model id that the built-in peak/off-peak table owns. */
const DEEPSEEK_MARKER = 'deepseek';

/** Trailing release-suffix noise that relays append to an official model id. */
const RELEASE_SUFFIX = /-(preview|latest|free|beta|alpha|experimental)$/;

/** Round to 6 decimals so a converted price stays readable in JSON. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * One catalog cost entry -> CNY per million tokens.
 *
 * models.dev reports `input` / `output` and optionally `cache_read` /
 * `cache_write`. A missing cache price means the provider bills cached prompt
 * tokens at the normal input rate, which is how the client's cost function
 * already treats `cacheWrite`.
 *
 * @param {{input?: number, output?: number, cache_read?: number, cache_write?: number}|undefined} cost
 * @param {number} usdToCny - USD -> CNY rate.
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined}
 */
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
 * models.dev payload -> `{ "<provider>/<model>": rate, "<model>": rate }`.
 *
 * The bare-id key keeps the FIRST provider that prices a model, which makes the
 * lookup stable when several providers list the same id.
 *
 * DEEPSEEK IDS ARE EXCLUDED ON PURPOSE. Their official rates live in the client's
 * built-in table (`PRICING` in lib/client.js), which is the authority for peak /
 * off-peak pricing and is exact. Letting the catalog also carry them would create
 * two sources for the same model and let a stale catalog quote override the correct
 * built-in rate.
 *
 * The consequence is that a catalog miss for a DeepSeek model is NORMAL, not a
 * fault. Measured 2026-10-26: asking for `workbuddy/deepseek-v4.1-flash` returned
 * `last_request_hits: []` out of a 10,995-model catalog, which reads like "pricing
 * is broken" but only means "this id is priced by the built-in table". The status
 * file now reports the two cases separately -- see `classifyNames()`.
 *
 * @param {Record<string, unknown>} modelsDev - decoded models.dev/api.json.
 * @param {number} usdToCny - USD -> CNY rate.
 * @returns {Record<string, object>}
 */
export function buildCatalog(modelsDev, usdToCny) {
  const models = Object.create(null);
  if (!modelsDev || typeof modelsDev !== 'object') return models;
  for (const [providerId, provider] of Object.entries(modelsDev)) {
    const table = provider && typeof provider === 'object' ? provider.models : undefined;
    if (!table || typeof table !== 'object') continue;
    const providerKey = String(providerId).toLowerCase();
    for (const [modelId, entry] of Object.entries(table)) {
      const id = String(modelId).toLowerCase();
      if (id.length === 0 || id.includes(DEEPSEEK_MARKER)) continue;
      const rate = cnyEntry(entry && typeof entry === 'object' ? entry.cost : undefined, usdToCny);
      if (rate === undefined) continue;
      models[providerKey + '/' + id] = rate;
      if (models[id] === undefined) models[id] = rate;
    }
  }
  return models;
}

/**
 * Every spelling of a routed model id worth trying against the catalog.
 *
 * Relays rename freely (`gpt-6.1-sol` behind `codex/`), so besides the exact id
 * this tries the bare tail, a minor-version collapse (`6.1` -> `6`), and a
 * stripped release suffix. Lookup stays deterministic: the caller tries these in
 * order and takes the first hit.
 *
 * @param {string|undefined} model - routed model id, `provider/model` or bare.
 * @returns {string[]} distinct lowercase candidates, most specific first.
 */
export function nameCandidates(model) {
  if (typeof model !== 'string' || model.length === 0) return [];
  const lower = model.toLowerCase();
  const slash = lower.lastIndexOf('/');
  const tail = slash >= 0 ? lower.slice(slash + 1) : lower;
  const collapseMinor = (value) => value.replace(/\.(\d+)(?=[-/])/g, '');
  const stripSuffix = (value) => value.replace(RELEASE_SUFFIX, '');
  const out = [];
  const push = (value) => {
    if (value.length > 0 && !out.includes(value)) out.push(value);
  };
  push(lower);
  push(tail);
  for (const value of [tail, collapseMinor(tail)]) {
    push(stripSuffix(value));
    push(collapseMinor(stripSuffix(value)));
    push(stripSuffix(collapseMinor(value)));
  }
  return out;
}

/**
 * Pick the requested models out of the catalog.
 *
 * @param {Record<string, object>} models - result of {@link buildCatalog}.
 * @param {string[]} names - routed model ids asked for by the client.
 * @returns {Record<string, object>} `{ "<asked name>": rate }` for the hits.
 */
export function selectModels(models, names) {
  const hits = Object.create(null);
  if (!models || !Array.isArray(names)) return hits;
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue;
    for (const candidate of nameCandidates(name)) {
      const rate = models[candidate];
      if (rate !== undefined) {
        hits[name] = rate;
        break;
      }
    }
  }
  return hits;
}

/**
 * Split the requested names into "priced by the built-in table" and "genuinely
 * unpriced by this catalog".
 *
 * WHY. `last_request_hits: []` cannot be interpreted on its own. It reads like
 * "the price list knows none of these models", but for a DeepSeek id that empty
 * array is the DESIGNED outcome, because {@link buildCatalog} leaves DeepSeek to
 * the client's built-in table. Diagnosing that cost a detour on 2026-10-26, so the
 * status file now says which case applied instead of leaving a bare empty list.
 *
 * The marker test mirrors {@link buildCatalog} exactly: one place decides what the
 * catalog carries, and this function reports on that same rule.
 *
 * @param {string[]} names - routed model ids the client asked about.
 * @param {Record<string, object>} hits - result of {@link selectModels}.
 * @returns {{catalog: string[], builtin: string[], unpriced: string[]}}
 *   `catalog` = found in the online catalog; `builtin` = excluded from the catalog
 *   because the built-in table owns it; `unpriced` = absent from both, i.e. the
 *   only group that actually signals a missing price.
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
      // Left out of the catalog on purpose, priced by the built-in table.
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
