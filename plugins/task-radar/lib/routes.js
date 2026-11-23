/**
 * HTTP route handler for dsh-plugin-task-radar (/radar, /config, /test).
 *
 * Supports journalId + configVersion validation on GET /api/task-radar/radar so
 * a host restart (new journalId) or config save (new configVersion) never returns
 * `{ unchanged: true }` and silently drops post-restart events or config updates.
 *
 * ASCII only.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { CONFIG_FILE_MAX_BYTES } from './config-file.js';
import { fireToast } from './toast.js';

export const PROFILE = '/api/task-radar';
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const REQUEST_BODY_TIMEOUT_MS = 10000;
export const REQUEST_BODY_LIMIT = CONFIG_FILE_MAX_BYTES;

function json(res, status, value, { head = false, close = false } = {}) {
  if (!res || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(head ? undefined : body);
}

class RequestBodyError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export function readBody(req, limit, timeoutMs = REQUEST_BODY_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    if (req.aborted || (req.destroyed && !req.readableEnded)) {
      reject(new RequestBodyError(400, 'request-aborted'));
      return;
    }
    if (signal && signal.aborted) {
      reject(new RequestBodyError(503, 'plugin-unloaded'));
      return;
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => fail(408, 'request-timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      if (error) {
        chunks.length = 0;
        req.pause();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
        chunks.length = 0;
      }
      // Keep the error observer until close: IncomingMessage can emit an
      // ECONNRESET after aborted or after a response closes an unread upload.
      if (req.destroyed) detach();
    }
    function fail(status, reason) { finish(new RequestBodyError(status, reason)); }
    function detach() {
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    }
    function onAbort() { fail(503, 'plugin-unloaded'); }
    function onError() { fail(400, req.aborted ? 'request-aborted' : 'request-read-error'); }
    function onClose() {
      fail(400, 'request-aborted');
      detach();
    }
    function onEnd() { finish(); }
    function onData(chunk) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) { fail(413, 'body-too-large'); return; }
      chunks.push(bytes);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', onError);
    req.on('close', onClose);
    req.on('end', onEnd);
    req.on('data', onData);
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) fail(413, 'body-too-large');
  });
}

export function createHandler(
  getCfg,
  persist,
  journal,
  file,
  toastSender = fireToast,
  journalId = randomUUID(),
  signal,
  activeNow = () => false,
  getConfigVersion,
) {
  let localConfigVersion = 1;
  const currentConfigVersion = () => (
    typeof getConfigVersion === 'function' ? getConfigVersion() : localConfigVersion
  );

  return async (req, res) => {
    if (signal && signal.aborted) {
      json(res, 503, { ok: false, reason: 'plugin-unloaded' }, { close: true });
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://api/task-radar.invalid');
    } catch {
      json(res, 400, { ok: false, reason: 'bad-url' });
      return;
    }
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (pathname === PROFILE + '/radar' && (method === 'GET' || method === 'HEAD')) {
        let active = false;
        try { active = activeNow() === true; } catch { active = false; }
        let newest = 0;
        for (const entry of journal) {
          if (entry && Number.isSafeInteger(entry.sequence) && entry.sequence > newest) newest = entry.sequence;
        }
        const configVersion = currentConfigVersion();
        const since = Number(url.searchParams.get('since'));
        const reqJournalId = url.searchParams.get('journalId');
        const reqConfigVersion = url.searchParams.get('configVersion');

        const journalMatches = reqJournalId === null || reqJournalId === '' || reqJournalId === journalId;
        const configMatches = reqConfigVersion === null || reqConfigVersion === '' || Number(reqConfigVersion) === configVersion;

        if (Number.isFinite(since) && since > 0 && newest <= since && journalMatches && configMatches) {
          json(
            res,
            200,
            { ok: true, version, journalId, configVersion, active, sequence: newest, unchanged: true },
            { head: method === 'HEAD' },
          );
          return;
        }
        json(
          res,
          200,
          { ok: true, version, journalId, configVersion, active, sequence: newest, journal: journal.slice(), config: getCfg() },
          { head: method === 'HEAD' },
        );
        return;
      }

      if (pathname === PROFILE + '/config' && method === 'POST') {
        const raw = await readBody(req, REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS, signal);
        if (req.aborted) return;
        if (signal && signal.aborted) throw new RequestBodyError(503, 'plugin-unloaded');
        let incoming;
        try {
          incoming = JSON.parse(raw);
        } catch {
          json(res, 400, { ok: false, reason: 'bad-json' });
          return;
        }
        const candidate = incoming && Object.hasOwn(incoming, 'config') ? incoming.config : incoming;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          json(res, 400, { ok: false, reason: 'invalid-config' });
          return;
        }
        persist(candidate);
        localConfigVersion += 1;
        json(res, 200, { ok: true, config: getCfg(), configVersion: currentConfigVersion(), file });
        return;
      }

      if (pathname === PROFILE + '/test' && method === 'POST') {
        const cfg = getCfg();
        const title = cfg.titlePrefix + ' \u00b7 \u6d4b\u8bd5\u901a\u77e5';
        const body = '\u6d4b\u8bd5\u901a\u77e5\u8bf7\u6c42\u5df2\u63d0\u4ea4\uff0c\u8bf7\u5728 Windows \u901a\u77e5\u4e2d\u6838\u5bf9\u3002';
        const submitted = cfg.toast.enabled
          ? toastSender({ logger: { warn() {} } }, cfg, { title, body, location: '' }) === true
          : false;
        json(res, 200, { ok: true, submitted });
        return;
      }

      json(res, 404, { ok: false, reason: 'not-found' });
    } catch (error) {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      if (error instanceof RequestBodyError) {
        json(res, error.status, { ok: false, reason: error.reason }, { close: true });
        return;
      }
      json(
        res,
        500,
        {
          ok: false,
          reason: 'internal',
          message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        },
      );
    }
  };
}
