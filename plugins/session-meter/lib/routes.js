/**
 * HTTP routes and balance reader for dsh-plugin-session-meter (Host half).
 *
 * Uses shared `sendJson` and `isLoopbackAddress` from `./http-utils.js` for
 * consistent JSON framing, `HEAD` empty-body responses, and loopback guards.
 *
 * Pure ASCII only (workspace convention).
 */
import { createHash } from 'node:crypto';

import { isLoopbackAddress, readBoundedJson, sendJson } from './http-utils.js';
import { classifyNames, selectModels } from './prices.js';
import { createSpendReport, REPORT_FORMATS, serializeSpendReport, spendReportFilename } from './report.js';

/** Route the browser half reads for live catalog prices. */
export const ROUTE = '/session-meter/prices';
/** Route the browser half reads for the account balance (read-only, key-gated). */
export const BALANCE_PATH = '/session-meter/balance';
export const REPORT_PATH = '/session-meter/report';
const REPORT_BODY_LIMIT = 8 * 1024 * 1024;
/** The only endpoint that may receive the balance credential. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** Short cache so opening the panel repeatedly does not hammer the endpoint. */
const BALANCE_TTL_MS = 60 * 1000;
/** Short negative-cache backoff so repeated upstream failures do not storm. */
const BALANCE_ERROR_BACKOFF_MS = 5 * 1000;
/** Upper bound on the models answered by one call. */
const MAX_NAMES = 256;
/** Recent price query cache capacity. */
const RESPONSE_CACHE_MAX = 8;

/**
 * Build a reader for the DeepSeek account balance with in-flight deduplication
 * and short negative-cache backoff per credential hash.
 *
 * @param {{fetchImpl?:Function, keyProvider?:Function, timeoutMs?:number, now?:Function, errorBackoffMs?:number}} [options]
 * @returns {Function} async () => balance result
 */
export function createBalanceReader(options = {}) {
  const doFetch = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof fetch === 'function' ? fetch : undefined);
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000;
  const errorBackoffMs = Number.isFinite(options.errorBackoffMs) && options.errorBackoffMs >= 0
    ? options.errorBackoffMs
    : BALANCE_ERROR_BACKOFF_MS;
  let cache;

  return async function readBalance() {
    try {
      const key = typeof options.keyProvider === 'function' ? String(options.keyProvider() || '').trim() : '';
      if (key === '') {
        cache = undefined;
        return { ok: false, reason: 'no-key' };
      }
      if (doFetch === undefined) return { ok: false, reason: 'no-fetch' };
      const keyHash = createHash('sha256').update(key).digest('hex');
      if (cache?.keyHash !== keyHash) cache = { keyHash };
      const slot = cache;
      const at = clock();
      if (slot.value !== undefined && at - slot.value.fetchedAt < BALANCE_TTL_MS) return slot.value;
      if (slot.errorValue !== undefined && errorBackoffMs > 0 && at - slot.errorAt < errorBackoffMs) {
        return slot.errorValue;
      }
      if (slot.inflight !== undefined) return await slot.inflight;

      const work = (async () => {
        try {
          const response = await doFetch(BALANCE_URL, {
            headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response === undefined || response === null || response.ok === false) {
            const err = { ok: false, reason: 'http', status: response ? response.status : 0 };
            slot.errorValue = err;
            slot.errorAt = clock();
            return err;
          }
          const body = await response.json();
          const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
          const value = {
            ok: true,
            available: body && body.is_available === true,
            balances: infos.map((item) => ({
              currency: String(item && item.currency != null ? item.currency : ''),
              total: String(item && item.total_balance != null ? item.total_balance : ''),
              granted: String(item && item.granted_balance != null ? item.granted_balance : ''),
              toppedUp: String(item && item.topped_up_balance != null ? item.topped_up_balance : ''),
            })),
            fetchedAt: at,
          };
          slot.value = value;
          slot.errorValue = undefined;
          return value;
        } catch {
          const err = { ok: false, reason: 'error' };
          slot.errorValue = err;
          slot.errorAt = clock();
          return err;
        } finally {
          if (slot.inflight === work) slot.inflight = undefined;
        }
      })();
      slot.inflight = work;
      return await work;
    } catch {
      return { ok: false, reason: 'error' };
    }
  };
}

function isAllowedOrigin(req) {
  const origin = req?.headers?.origin ?? req?.headers?.Origin;
  if (typeof origin !== 'string' || origin.trim() === '') return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    const reqHost = req?.headers?.host ?? req?.headers?.Host;
    if (typeof reqHost === 'string' && reqHost.length > 0 && parsed.host.toLowerCase() === reqHost.toLowerCase()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function wantsCatalog(names) {
  return names.some((name) => !name.toLowerCase().includes('deepseek'));
}

/** Render a supplied ledger for local clients without storing it. */
export async function handleSpendReport(req, res) {
  const method = req.method;
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method-not-allowed' }, { method, headers: { allow: 'POST' } });
    return;
  }
  const origin = req.headers?.origin;
  const ownOrigin = (req.socket?.encrypted ? 'https://' : 'http://') + req.headers?.host;
  if (!isLoopbackAddress(req.socket?.remoteAddress) || (origin !== undefined && origin !== ownOrigin)) {
    sendJson(res, 403, { ok: false, reason: 'forbidden' });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] ?? '')) {
    sendJson(res, 415, { ok: false, reason: 'expected-json' });
    return;
  }

  let payload;
  try {
    payload = await readBoundedJson(req, { maxBytes: REPORT_BODY_LIMIT });
  } catch (error) {
    sendJson(res, error.status ?? 400, { ok: false, reason: 'invalid-body' });
    return;
  }
  const { format, ledger, options, language } = payload ?? {};
  if (typeof format !== 'string' || !Object.hasOwn(REPORT_FORMATS, format)
    || (ledger?.version !== 2 && ledger?.version !== 3)
    || !ledger.days || typeof ledger.days !== 'object' || Array.isArray(ledger.days)
    || !options || typeof options !== 'object' || Array.isArray(options)) {
    sendJson(res, 400, { ok: false, reason: 'invalid-report' });
    return;
  }

  let report;
  try {
    report = createSpendReport(ledger, options);
  } catch {
    sendJson(res, 400, { ok: false, reason: 'invalid-range' });
    return;
  }
  if (res.writableEnded || res.destroyed) return;
  const content = serializeSpendReport(report, format, language);
  res.writeHead(200, {
    'content-type': REPORT_FORMATS[format],
    'content-disposition': 'attachment; filename="' + spendReportFilename(report, format) + '"',
    'content-length': Buffer.byteLength(content, 'utf8'),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(content);
}

/** Build the `/session-meter/prices` HTTP handler. */
export function createPriceHandler(store) {
  let responseCacheStamp = '';
  const responseCache = new Map();

  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' }, { method: req.method });
        return;
      }
      if (req.socket !== undefined && !isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, reason: 'forbidden' }, { method: req.method });
        return;
      }
      if (!isAllowedOrigin(req)) {
        sendJson(res, 403, { ok: false, reason: 'forbidden' }, { method: req.method });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://session-meter.invalid');
      let names = [];
      const raw = url.searchParams.get('m');
      if (typeof raw === 'string' && raw.length > 0) {
        names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0).slice(0, MAX_NAMES);
      }

      const { state, status } = store;
      if (wantsCatalog(names)) {
        store.markCatalogWanted();
        if (store.stale()) {
          const pending = store.refresh();
          if (state.fetchedAt === 0) await pending;
        }
      }

      // Include `error` and `usdToCny` in the cache stamp so a failed refresh
      // or FX change invalidates cached responses instead of masking errors.
      const stamp = `${state.fetchedAt}|${state.usdToCny}|${state.error ?? ''}`;
      if (responseCacheStamp !== stamp) {
        responseCache.clear();
        responseCacheStamp = stamp;
      }

      const cacheKey = names.join('\n');
      let entry = responseCache.get(cacheKey);
      const cacheHit = entry !== undefined;
      if (cacheHit) {
        responseCache.delete(cacheKey);
        responseCache.set(cacheKey, entry);
      } else {
        const models = selectModels(state.models, names);
        entry = {
          hits: Object.keys(models),
          priced: classifyNames(names, models),
          payload: {
            ok: state.fetchedAt > 0,
            fetchedAt: state.fetchedAt,
            currency: 'CNY',
            usdToCny: state.usdToCny,
            error: state.error,
            models,
          },
        };
        responseCache.set(cacheKey, entry);
        while (responseCache.size > RESPONSE_CACHE_MAX) {
          const oldest = responseCache.keys().next().value;
          responseCache.delete(oldest);
        }
      }

      status.last_request_hits = entry.hits;
      status.last_request_priced = entry.priced;
      status.requests += 1;
      status.last_request_at = new Date().toISOString();
      status.last_request_names = names;
      status.last_request_answered = state.fetchedAt > 0;
      status.priced_models = store.getPricedCount();
      store.writeStatusThrottled();

      sendJson(res, 200, entry.payload, {
        method: req.method,
        headers: { 'x-session-meter-cache': cacheHit ? 'hit' : 'miss' },
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }, { method: req?.method });
    }
  };
}

/** Build the loopback-only `/session-meter/balance` HTTP handler. */
export function createBalanceHandler(readBalance) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' }, { method: req.method });
        return;
      }
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, reason: 'forbidden' }, { method: req.method });
        return;
      }
      let value;
      try {
        value = await readBalance();
      } catch {
        value = { ok: false, reason: 'error' };
      }
      sendJson(res, 200, value, { method: req.method });
    } catch {
      sendJson(res, 500, { ok: false, reason: 'error' }, { method: req?.method });
    }
  };
}
