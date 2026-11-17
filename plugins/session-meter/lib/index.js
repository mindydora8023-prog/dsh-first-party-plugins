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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCatalog, classifyNames, scaleRates, selectModels, usdToCnyOf } from './prices.js';
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


/**
 * Bumped when the cached payload shape changes.
 * Version 2 (rates only) still loads; the next save adds `catalogEtag`.
 */
const CACHE_VERSION = 3;
/** Older snapshot this loader can still price from. */
const CACHE_VERSION_MIN = 2;
/** Route the browser half reads. */
const ROUTE = '/session-meter/prices';
/** Used when the exchange-rate endpoint is unreachable. */
const FALLBACK_USD_TO_CNY = 7.1;
/**
 * Upper bound on the models answered by one call.
 *
 * The client asks every spelling of a routed id, so one model is several
 * names. 64 names is a handful of models; past that the rest were silently
 * dropped and stayed unpriced. The response is still one small JSON object.
 */
const MAX_NAMES = 256;

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

/**
 * Download and decode one JSON document.
 *
 * A stored `etag` is sent as If-None-Match. 304 means the body is unchanged,
 * so the caller keeps what it already parsed instead of downloading it again.
 * `response.ok` is false for 304, which is why that status is handled first.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {string|undefined} etag - validator from the previous response.
 * @returns {Promise<{notModified: boolean, etag: string|undefined, body: unknown}>}
 */
async function fetchJson(url, timeoutMs, etag) {
  const headers = {};
  if (typeof etag === 'string' && etag.length > 0) headers['if-none-match'] = etag;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers });
  const nextEtag = response.headers.get('etag');
  const validator = typeof nextEtag === 'string' && nextEtag.length > 0 ? nextEtag : etag;
  if (response.status === 304) return { notModified: true, etag: validator, body: undefined };
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return { notModified: false, etag: typeof nextEtag === 'string' && nextEtag.length > 0 ? nextEtag : undefined, body: await response.json() };
}

export function apply(ctx) {
  if (process.env.SESSION_METER_OFFLINE === '1') return;

  const modelsUrl = process.env.SESSION_METER_PRICES_URL ?? DEFAULT_MODELS_URL;
  const fxUrl = process.env.SESSION_METER_FX_URL ?? DEFAULT_FX_URL;
  const refreshMs = numberFromEnv('SESSION_METER_REFRESH_HOURS', 24) * 3600 * 1000;
  const timeoutMs = numberFromEnv('SESSION_METER_TIMEOUT_MS', 20000);
  // Captured once. `cacheFile()` reads the env on every call, and a later test
  // (or a second apply) that changes SESSION_METER_CACHE_FILE would otherwise
  // make this instance write its snapshot into the other instance's file.
  const cachePath = cacheFile();

  /** models, when fetched, the conversion rate, and the last failure. */
  const state = {
    models: Object.create(null),
    fetchedAt: 0,
    /** When the last check finished. Distinct from fetchedAt, which is the catalog. */
    refreshedAt: 0,
    usdToCny: FALLBACK_USD_TO_CNY,
    catalogEtag: undefined,
    error: undefined,
  };
  let inflight;
  /** Cached catalog size so a request never Object.keys() ~11k models. */
  let pricedCount = 0;

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
    return true;
  };

  const parseSnapshot = (path) => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return undefined;
      if (parsed.version !== CACHE_VERSION && parsed.version !== CACHE_VERSION_MIN) return undefined;
      if (!parsed.models || typeof parsed.models !== 'object') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  };

  // Declared before loadCache: restoring a backup is the first queued write,
  // and a refresh must not rename files ahead of it.
  let saveQueue = Promise.resolve();

  const promote = (from) => {
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        if (!existsSync(cachePath)) {
          await rename(from, cachePath);
          return;
        }
        // Do not rewrite `from` in place. It is the only complete copy of the
        // newer snapshot; saveCache writes through the same temp path and a
        // crash there would truncate it. Move the old main aside, then move
        // the newer file onto it.
        const backup = `${cachePath}.bak`;
        if (from === backup) return;
        await rm(backup, { force: true });
        await rename(cachePath, backup);
        await rename(from, cachePath);
        await rm(backup, { force: true });
      })
      .catch(() => {});
  };

  const loadCache = () => {
    // The main file, the temp file and the backup can all be present after a
    // crash. The temp is written first, so while the old main file is still
    // there it is the newer catalog. Picking main whenever it parses kept
    // yesterday's prices.
    const files = [cachePath, `${cachePath}.tmp`, `${cachePath}.bak`];
    let best;
    let bestAt = -1;
    let bestPath;
    for (const path of files) {
      const parsed = parseSnapshot(path);
      if (!parsed) continue;
      const at = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
      if (!best || at > bestAt) {
        best = parsed;
        bestAt = at;
        bestPath = path;
      }
    }
    if (!best || !applySnapshot(best)) return false;
    // The served copy has to become the main file. Leaving a newer temp beside
    // an older main meant the next start that lost the temp went back to the
    // old prices. saveCache is queued, so a refresh cannot pass it.
    if (bestPath !== cachePath) promote(bestPath);
    return true;
  };

  // Writes are chained so an older snapshot cannot land after a newer one.
  // Stringify and the disk wait both run off the refresh turn: the catalog is
  // about a megabyte. The bytes land in a temporary file and are renamed over
  // the snapshot, so a crash mid-write leaves the previous snapshot readable.
  const saveCache = () => {
    const snapshot = {
      version: CACHE_VERSION,
      fetchedAt: state.fetchedAt,
      usdToCny: state.usdToCny,
      catalogEtag: state.catalogEtag,
      models: state.models,
    };
    const target = cachePath;
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        const payload = JSON.stringify(snapshot);
        const temporary = `${target}.tmp`;
        const backup = `${target}.bak`;
        try {
          await writeFile(temporary, payload);
          try {
            await rename(temporary, target);
          } catch (error) {
            // Windows refuses to rename onto a file that already exists.
            // Move the old snapshot aside first, so the gap has a backup
            // instead of no file at all.
            const code = error && error.code;
            if (code !== 'EPERM' && code !== 'EEXIST') throw error;
            await rm(backup, { force: true });
            await rename(target, backup);
            await rename(temporary, target);
            await rm(backup, { force: true });
          }
        } catch (error) {
          // Keep the temp file. It may be the only complete copy of the new
          // catalog: the old main file can already have been moved aside, and
          // deleting the temp then would drop the new snapshot. A half-written
          // temp does not parse, so the next start ignores it.
          throw error;
        }
      })
      .catch(() => {
        // A read-only temp directory only costs a refetch on the next start.
      });
  };

  const refresh = () => {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const previousRate = state.usdToCny;
        // No validator until a snapshot exists. A 304 against an empty table
        // would throw "no priced models" and wipe a usable fallback rate.
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
          // Same USD quotes. Re-scale only when the exchange rate actually moved;
          // a factor of 1 returns the existing object and skips the rewrite.
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
        // fetchedAt is the catalog's identity, and the page drops remembered
        // prices when it changes. A 304 with the same exchange rate is not a
        // new catalog; bumping it made every open session ask again.
        if (!notModified) state.fetchedAt = state.refreshedAt;
        state.error = undefined;
        // An unchanged catalog is not written back: the previous snapshot is
        // already that catalog, and rewriting ~1 MB on every check is the cost
        // this path exists to avoid. refreshedAt still resets the window.
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
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`session-meter: price refresh failed: ${state.error}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const stale = () => state.refreshedAt === 0 || Date.now() - state.refreshedAt > refreshMs;

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
    last_refresh_not_modified: null,
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

  // Identical polls from every open session used to rebuild the JSON body
  // each time. A handful of recent queries are enough; a new catalog drops them.
  let responseCacheAt = -1;
  const responseCache = new Map();
  const RESPONSE_CACHE_MAX = 8;

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
    if (responseCacheAt !== state.fetchedAt) {
      responseCache.clear();
      responseCacheAt = state.fetchedAt;
    }
    const cacheKey = names.join('\n');
    let entry = responseCache.get(cacheKey);
    const cacheHit = entry !== undefined;
    // A hit moves to the newest slot. Insertion order alone evicted the query
    // every open session repeats, as soon as eight other names had been asked.
    if (cacheHit) {
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, entry);
    } else {
      const models = selectModels(state.models, names);
      entry = {
        // An empty hits list only means "not in the online catalog". For a
        // DeepSeek id that is by design (the built-in table prices it).
        hits: Object.keys(models),
        priced: classifyNames(names, models),
        body: JSON.stringify({
          ok: state.fetchedAt > 0,
          fetchedAt: state.fetchedAt,
          currency: 'CNY',
          usdToCny: state.usdToCny,
          error: state.error,
          models,
        }),
      };
      responseCache.set(cacheKey, entry);
      while (responseCache.size > RESPONSE_CACHE_MAX) {
        const oldest = responseCache.keys().next().value;
        responseCache.delete(oldest);
      }
    }
    const body = entry.body;
    status.last_request_hits = entry.hits;
    status.last_request_priced = entry.priced;
    status.requests += 1;
    status.last_request_at = new Date().toISOString();
    status.last_request_names = names;
    status.last_request_answered = state.fetchedAt > 0;
    status.priced_models = pricedCount;
    writeStatusThrottled();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'x-session-meter-cache': cacheHit ? 'hit' : 'miss',
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
