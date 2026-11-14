/**
 * Host half of dsh-plugin-session-meter.
 *
 * The client cannot hold a live price catalog (models.dev is ~6 MB) and must not
 * depend on the page reaching the internet, so this half owns the fetch:
 *
 *   - once per `SESSION_METER_REFRESH_HOURS` (default 24), and on first use, it
 *     downloads models.dev plus a USD->CNY rate and converts every entry to CNY
 *     per million tokens (see lib/prices.js);
 *   - the result is cached in the temp directory, so a restart reuses it and an
 *     offline start still answers from the last snapshot;
 *   - `GET /session-meter/prices?m=<model,model,...>` returns only the models the
 *     calling session actually used, which keeps the response small.
 *
 * Nothing here is required for the pill to work: without the route the client
 * falls back to its built-in DeepSeek table.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCatalog, classifyNames, selectModels, usdToCnyOf } from './prices.js';
import { statePath, stateProvenance } from './state-dir.js';

/**
 * Where this plugin's diagnostic status file goes.
 *
 * WHY NOT NEXT TO THE PLUGIN. Until 2026-10-27 the default was
 * `<pluginDir>/session-meter-status.json`, i.e. inside the source tree. Three
 * consequences, all of them observed rather than theoretical:
 *
 *   1. The source tree is mirrored to a git repository, so the sync tool had to
 *      carry a `*-status.json` filter to keep runtime noise out of the mirror.
 *   2. The directory may be read-only or on a network share, and a `link:` plugin
 *      does not own it.
 *   3. Worse, the 2026-10-26 migration COPIED that file to the per-user state
 *      directory without re-pointing this code, which left two files: the live one
 *      in the source tree and a stale decoy elsewhere. Anyone reading the decoy got
 *      data frozen at the moment of the copy.
 *
 * `SESSION_METER_STATUS_FILE` stays supported: it is the documented escape hatch for
 * putting diagnostics on another volume, and it must keep working verbatim.
 *
 * @returns {string} absolute path of the status file.
 */
export function statusFilePath() {
  const override = process.env.SESSION_METER_STATUS_FILE;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return statePath('session-meter', 'session-meter-status.json');
}


/** Bumped when the cached payload shape changes. */
const CACHE_VERSION = 2;
/** Route the browser half reads. */
const ROUTE = '/session-meter/prices';
/** Used when the exchange-rate endpoint is unreachable. */
const FALLBACK_USD_TO_CNY = 7.1;
/** Upper bound on the models requested by one call. */
const MAX_NAMES = 64;

const DEFAULT_MODELS_URL = 'https://models.dev/api.json';
const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cacheFile() {
  // Overridable so a test (or a second profile) cannot read the machine's cache
  // and silently price from it instead of the upstream it was pointed at.
  const override = process.env.SESSION_METER_CACHE_FILE;
  if (typeof override === 'string' && override.length > 0) return override;
  return join(tmpdir(), 'dsh-session-meter-prices.json');
}

/** Download and decode one JSON document. */
async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export function apply(ctx) {
  if (process.env.SESSION_METER_OFFLINE === '1') return;

  const modelsUrl = process.env.SESSION_METER_PRICES_URL ?? DEFAULT_MODELS_URL;
  const fxUrl = process.env.SESSION_METER_FX_URL ?? DEFAULT_FX_URL;
  const refreshMs = numberFromEnv('SESSION_METER_REFRESH_HOURS', 24) * 3600 * 1000;
  const timeoutMs = numberFromEnv('SESSION_METER_TIMEOUT_MS', 20000);

  /** models, when fetched, the conversion rate, and the last failure. */
  const state = { models: Object.create(null), fetchedAt: 0, usdToCny: FALLBACK_USD_TO_CNY, error: undefined };
  let inflight;
  /** Cached catalog size so a request never Object.keys() ~11k models. */
  let pricedCount = 0;

  const loadCache = () => {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile(), 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return false;
      if (!parsed.models || typeof parsed.models !== 'object') return false;
      state.models = parsed.models;
      state.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
      state.usdToCny = typeof parsed.usdToCny === 'number' ? parsed.usdToCny : FALLBACK_USD_TO_CNY;
      return true;
    } catch {
      return false;
    }
  };

  const saveCache = () => {
    try {
      writeFileSync(cacheFile(), JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: state.fetchedAt,
        usdToCny: state.usdToCny,
        models: state.models,
      }));
    } catch {
      // A read-only temp directory only costs a refetch on the next start.
    }
  };

  const refresh = () => {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const [catalog, fxPayload] = await Promise.all([
          fetchJson(modelsUrl, timeoutMs),
          fetchJson(fxUrl, timeoutMs).catch(() => undefined),
        ]);
        const usdToCny = usdToCnyOf(fxPayload) ?? FALLBACK_USD_TO_CNY;
        const models = buildCatalog(catalog, usdToCny);
        const keys = Object.keys(models);
        if (keys.length === 0) throw new Error('price catalog carried no priced models');
        state.models = models;
        state.usdToCny = usdToCny;
        state.fetchedAt = Date.now();
        state.error = undefined;
        saveCache();
        status.last_refresh_at = new Date(state.fetchedAt).toISOString();
        status.cache_fetched_at = status.last_refresh_at;
        status.usd_to_cny = usdToCny;
        pricedCount = keys.length;
        status.priced_models = pricedCount;
        status.last_error = null;
        writeStatus();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        status.last_error = state.error;
        writeStatus();
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`session-meter: price refresh failed: ${state.error}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const stale = () => state.fetchedAt === 0 || Date.now() - state.fetchedAt > refreshMs;

  /**
   * Diagnostics for "the prices never arrived": was the route registered at all,
   * and did the browser actually ask? Written to the per-user state directory (see
   * `statusFilePath()`), never into the source tree.
   */
  const statusFile = statusFilePath();
  const status = {
    loaded_at: new Date().toISOString(),
    // Recorded here so "why is this file not where I expected?" is answerable from
    // the file itself, instead of requiring the reader to know state-dir's rules.
    state_root: stateProvenance(),
    status_file: statusFile,
    web_server: false,
    route_registered: false,
    cache_fetched_at: null,
    last_refresh_at: null,
    usd_to_cny: null,
    priced_models: 0,
    last_error: null,
    requests: 0,
    last_request_at: null,
    last_request_names: [],
    // Kept for compatibility; interpret it via last_request_priced,
    // because an empty list here is the DESIGNED result for DeepSeek models.
    last_request_hits: [],
    last_request_priced: { catalog: [], builtin: [], unpriced: [] },
    last_request_answered: undefined,
  };
  const writeStatus = () => {
    try {
      // The per-user state directory may not exist on a clean machine; without
      // this, every write throws ENOENT and the diagnostic file is missing from
      // the very place README points a "why unpriced" investigation to.
      mkdirSync(dirname(statusFile), { recursive: true });
      writeFileSync(statusFile, JSON.stringify(status, null, 2));
    } catch {
      // Diagnostics must never break pricing.
    }
  };

  // Every open session pushes a price request every ~30s; a synchronous status
  // write per request is wasted I/O on the host event loop. Throttle to ~1/s.
  let lastStatusWrite = 0;
  const writeStatusThrottled = () => {
    const nowMs = Date.now();
    if (nowMs - lastStatusWrite < 1000) return;
    lastStatusWrite = nowMs;
    writeStatus();
  };

  loadCache();
  pricedCount = Object.keys(state.models).length;
  status.cache_fetched_at = state.fetchedAt === 0 ? null : new Date(state.fetchedAt).toISOString();
  status.usd_to_cny = state.usdToCny;
  status.priced_models = pricedCount;
  writeStatus();

  // Kick the first refresh off the apply path: boot must not wait on the network.
  if (stale()) void refresh();

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (stale()) void refresh();
    }, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, 'session-meter price refresh');

  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://session-meter.invalid');
    // A stale snapshot is still a valid answer. Waiting here used to pin the
    // pill on the full models.dev download whenever the cache was older than
    // the refresh window, including the refresh apply() had already started.
    // Serve the snapshot and let that refresh finish in the background. Only
    // an empty cache (first run, or a cache the loader rejected) has to wait.
    if (stale()) {
      const pending = refresh();
      if (state.fetchedAt === 0) await pending;
    }
    let names = [];
    const raw = url.searchParams.get('m');
    if (typeof raw === 'string' && raw.length > 0) {
      names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0).slice(0, MAX_NAMES);
    }
    const models = selectModels(state.models, names);
    status.requests += 1;
    status.last_request_at = new Date().toISOString();
    status.last_request_names = names;
    status.last_request_hits = Object.keys(models);
    // An empty `last_request_hits` only means "not in the online catalog". For a
    // DeepSeek id that is by design (the built-in table prices it), so record the
    // split rather than leaving a bare empty array to be misread as "unpriced".
    status.last_request_priced = classifyNames(names, models);
    status.last_request_answered = state.fetchedAt > 0;
    status.priced_models = pricedCount;
    writeStatusThrottled();
    const body = JSON.stringify({
      ok: state.fetchedAt > 0,
      fetchedAt: state.fetchedAt,
      currency: 'CNY',
      usdToCny: state.usdToCny,
      error: state.error,
      models,
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const attachRoute = (server) => {
    let registered = false;
    ctx.effect(() => {
      const dispose = server.register({ kind: 'exact', path: ROUTE, handler });
      registered = true;
      status.route_registered = true;
      writeStatus();
      return dispose;
    }, 'session-meter price route');
    return registered;
  };

  // `webServer` may be provided AFTER this plugin activates (a fresh boot has no
  // guaranteed order between the two). Reading it once with `get` and returning
  // when absent left the route permanently unregistered, which surfaced only as
  // "the pill says unpriced" -- so wait for the service instead.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (childCtx) => {
      status.web_server = true;
      const server = typeof childCtx.get === 'function' ? childCtx.get('webServer') : childCtx.webServer;
      if (server !== undefined && server !== null) attachRoute(server);
      writeStatus();
    });
  } else {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    status.web_server = server !== undefined && server !== null;
    if (status.web_server) attachRoute(server);
    writeStatus();
  }
}
