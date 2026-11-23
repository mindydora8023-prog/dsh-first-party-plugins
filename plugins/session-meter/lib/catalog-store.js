/**
 * Price catalog persistence, background refresh, and diagnostic status file
 * for dsh-plugin-session-meter (Host half).
 *
 * Uses shared atomic JSON persistence from `./json-store.js` and keeps
 * offline mode (`SESSION_METER_OFFLINE=1`) able to load and serve any disk
 * snapshot without ever touching the network.
 *
 * Pure ASCII only (workspace convention).
 */
import { existsSync, readFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { enqueueFileWrite, writeJsonAtomicSync } from './json-store.js';
import { buildCatalog, getNormalizedIndex, scaleRates, usdToCnyOf } from './prices.js';
import { statePath, stateProvenance } from './state-dir.js';

export const CACHE_VERSION = 3;
export const CACHE_VERSION_MIN = 2;
export const FALLBACK_USD_TO_CNY = 7.1;
export const DEFAULT_MODELS_URL = 'https://models.dev/api.json';
export const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';

/** Where this plugin's diagnostic status file goes. */
export function statusFilePath() {
  const override = process.env.SESSION_METER_STATUS_FILE;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return statePath('session-meter', 'session-meter-status.json');
}

export function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function cacheFile() {
  const override = process.env.SESSION_METER_CACHE_FILE;
  if (typeof override === 'string' && override.length > 0) return override;
  return join(tmpdir(), 'dsh-session-meter-prices.json');
}

/** Download and decode one JSON document, respecting HTTP 304 ETag validation. */
export async function fetchJson(url, timeoutMs, etag) {
  const headers = {};
  if (typeof etag === 'string' && etag.length > 0) headers['if-none-match'] = etag;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers });
  const nextEtag = response.headers.get('etag');
  const validator = typeof nextEtag === 'string' && nextEtag.length > 0 ? nextEtag : etag;
  if (response.status === 304) return { notModified: true, etag: validator, body: undefined };
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return {
    notModified: false,
    etag: typeof nextEtag === 'string' && nextEtag.length > 0 ? nextEtag : undefined,
    body: await response.json(),
  };
}

/**
 * Create the catalog store, status reporter, and network refresher for one
 * plugin lifecycle.
 */
export function createCatalogStore(ctx, options = {}) {
  const offline = options.offline === true;
  const modelsUrl = options.modelsUrl ?? process.env.SESSION_METER_PRICES_URL ?? DEFAULT_MODELS_URL;
  const fxUrl = options.fxUrl ?? process.env.SESSION_METER_FX_URL ?? DEFAULT_FX_URL;
  const refreshMs = options.refreshMs ?? numberFromEnv('SESSION_METER_REFRESH_HOURS', 24) * 3600 * 1000;
  const timeoutMs = options.timeoutMs ?? numberFromEnv('SESSION_METER_TIMEOUT_MS', 20000);
  const cachePath = options.cachePath ?? cacheFile();
  const statusFile = options.statusFile ?? statusFilePath();

  const state = {
    models: Object.create(null),
    fetchedAt: 0,
    refreshedAt: 0,
    usdToCny: FALLBACK_USD_TO_CNY,
    catalogEtag: undefined,
    error: undefined,
  };
  let inflight;
  let pricedCount = 0;
  let catalogWanted = false;

  const status = {
    loaded_at: new Date().toISOString(),
    state_root: stateProvenance(),
    status_file: statusFile,
    offline,
    web_server: false,
    route_registered: false,
    cache_fetched_at: null,
    last_refresh_at: null,
    usd_to_cny: null,
    priced_models: 0,
    last_error: null,
    last_refresh_not_modified: null,
    requests: 0,
    last_request_at: null,
    last_request_names: [],
    last_request_hits: [],
    last_request_priced: { catalog: [], builtin: [], unpriced: [] },
    last_request_answered: undefined,
  };

  const writeStatus = () => {
    try {
      writeJsonAtomicSync(statusFile, status, { spaces: 2 });
    } catch {
      // Diagnostics must never break pricing.
    }
  };

  let lastStatusWrite = 0;
  const writeStatusThrottled = () => {
    const nowMs = Date.now();
    if (nowMs - lastStatusWrite < 1000) return;
    lastStatusWrite = nowMs;
    writeStatus();
  };

  const applySnapshot = (parsed) => {
    if (parsed === null || typeof parsed !== 'object') return false;
    if (parsed.version !== CACHE_VERSION && parsed.version !== CACHE_VERSION_MIN) return false;
    if (!parsed.models || typeof parsed.models !== 'object') return false;
    state.models = parsed.models;
    state.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    state.refreshedAt = state.fetchedAt;
    state.usdToCny = typeof parsed.usdToCny === 'number' ? parsed.usdToCny : FALLBACK_USD_TO_CNY;
    state.catalogEtag = typeof parsed.catalogEtag === 'string' && parsed.catalogEtag.length > 0
      ? parsed.catalogEtag
      : undefined;
    // Pre-warm the O(1) normalized index on load.
    getNormalizedIndex(state.models);
    return true;
  };

  const parseSnapshot = (file) => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return undefined;
      if (parsed.version !== CACHE_VERSION && parsed.version !== CACHE_VERSION_MIN) return undefined;
      if (!parsed.models || typeof parsed.models !== 'object') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  };

  const promote = (from) => {
    void enqueueFileWrite(cachePath, async () => {
      try {
        if (!existsSync(cachePath)) {
          await rename(from, cachePath);
          return;
        }
        const backup = `${cachePath}.bak`;
        if (from === backup) return;
        await rm(backup, { force: true });
        await rename(cachePath, backup);
        await rename(from, cachePath);
        await rm(backup, { force: true });
      } catch {
        // Best-effort promotion; never reject queued chain.
      }
    });
  };

  const loadCache = () => {
    const files = [cachePath, `${cachePath}.tmp`, `${cachePath}.bak`];
    let best;
    let bestAt = -1;
    let bestPath;
    for (const file of files) {
      const parsed = parseSnapshot(file);
      if (!parsed) continue;
      const at = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
      if (!best || at > bestAt) {
        best = parsed;
        bestAt = at;
        bestPath = file;
      }
    }
    if (!best || !applySnapshot(best)) return false;
    if (bestPath !== cachePath) promote(bestPath);
    return true;
  };

  const saveCache = () => {
    const snapshot = {
      version: CACHE_VERSION,
      fetchedAt: state.fetchedAt,
      usdToCny: state.usdToCny,
      catalogEtag: state.catalogEtag,
      models: state.models,
    };
    void enqueueFileWrite(cachePath, async () => {
      try {
        writeJsonAtomicSync(cachePath, snapshot, { spaces: 0 });
      } catch {
        // A read-only or removed temp directory only costs a refetch on next start.
      }
    });
  };

  const refresh = () => {
    if (offline) return Promise.resolve();
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const previousRate = state.usdToCny;
        const previousEtag = pricedCount > 0 ? state.catalogEtag : undefined;
        const [catalogResult, fxResult] = await Promise.all([
          fetchJson(modelsUrl, timeoutMs, previousEtag),
          fetchJson(fxUrl, timeoutMs).catch(() => undefined),
        ]);
        const freshRate = fxResult && fxResult.notModified !== true ? usdToCnyOf(fxResult.body) : undefined;
        const usdToCny = freshRate ?? previousRate ?? FALLBACK_USD_TO_CNY;
        let models;
        let notModified = false;
        if (catalogResult.notModified === true) {
          const factor = previousRate > 0 ? usdToCny / previousRate : 1;
          models = scaleRates(state.models, factor);
          notModified = factor === 1;
        } else {
          models = buildCatalog(catalogResult.body, usdToCny);
        }
        const keys = Object.keys(models);
        if (keys.length === 0) throw new Error('price catalog carried no priced models');
        state.models = models;
        state.catalogEtag = catalogResult.etag;
        state.usdToCny = usdToCny;
        state.refreshedAt = Date.now();
        if (!notModified) state.fetchedAt = state.refreshedAt;
        state.error = undefined;
        if (!notModified) saveCache();
        status.last_refresh_at = new Date(state.refreshedAt).toISOString();
        status.cache_fetched_at = state.fetchedAt > 0 ? new Date(state.fetchedAt).toISOString() : null;
        status.usd_to_cny = usdToCny;
        status.last_refresh_not_modified = catalogResult.notModified === true;
        pricedCount = keys.length;
        status.priced_models = pricedCount;
        status.last_error = null;
        writeStatus();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        status.last_error = state.error;
        writeStatus();
        if (typeof ctx?.logger?.warn === 'function') {
          ctx.logger.warn(`session-meter: price refresh failed: ${state.error}`);
        }
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const stale = () => !offline && (state.refreshedAt === 0 || Date.now() - state.refreshedAt > refreshMs);

  loadCache();
  pricedCount = Object.keys(state.models).length;
  status.cache_fetched_at = state.fetchedAt === 0 ? null : new Date(state.fetchedAt).toISOString();
  status.usd_to_cny = state.usdToCny;
  status.priced_models = pricedCount;
  writeStatus();

  return {
    state,
    status,
    offline,
    getPricedCount: () => pricedCount,
    markCatalogWanted: () => { catalogWanted = true; },
    isCatalogWanted: () => catalogWanted,
    stale,
    refresh,
    writeStatus,
    writeStatusThrottled,
  };
}
