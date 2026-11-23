/**
 * Same-origin HTTP route handlers for dsh-plugin-next-say.
 *
 * Uses shared `sendJson` from `./http-utils.js` for consistent JSON framing,
 * `HEAD` empty-body semantics, and closed-socket guards. Reserves daily call
 * budget atomically BEFORE dispatching an auxiliary model call so concurrent
 * requests cannot race past the daily cap, refunding only when no model call
 * actually ran (`elapsedMs === undefined`).
 *
 * Source is kept pure ASCII (workspace convention).
 */
import { sendJson } from './http-utils.js';
import { recentUserHistory } from './predict.js';
import { DEFAULTS, applyPatch, isPaused, writeSettings } from './config.js';
import {
  MAX_ATTEMPTS,
  generate,
  lastCompletedTurn,
  service,
  setBounded,
} from './turn.js';

/** Prefix route owned by this plugin. Longest-prefix wins over the SPA fallback. */
export const ROUTE = '/next-say';

/** Hard wall-clock deadline for reading a JSON request body. */
export const BODY_TIMEOUT_MS = 5000;

export class BodyError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Read a JSON object body from either a Fetch Request (`body.getReader()`),
 * Node `IncomingMessage` (`Symbol.asyncIterator`), or pre-decoded test carrier,
 * with strict UTF-8 byte cap, total wall-clock timeout, immediate reader/iterator
 * release, and safe `Promise.race` cleanup (no unhandled rejection leaks).
 */
export async function readJsonBody(request, limit = 64 * 1024, timeoutMs = BODY_TIMEOUT_MS) {
  let reader;
  let iterator;
  let completed = false;
  let stopped = false;
  let timer;
  const stop = (callback) => {
    try { Promise.resolve(callback()).catch(() => {}); } catch { /* ignore */ }
  };
  const tooLarge = () => new BodyError(413, 'body-too-large');
  const invalid = () => new BodyError(400, 'invalid-body');
  const checkObject = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    return value;
  };
  const parse = (text) => {
    if (Buffer.byteLength(text, 'utf8') > limit) throw tooLarge();
    return checkObject(JSON.parse(text));
  };
  const chunks = [];
  let total = 0;
  const append = (chunk) => {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw invalid();
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw tooLarge();
    if (buffer.byteLength > 0) chunks.push(buffer);
  };

  try {
    const headers = request.headers;
    const declared = Number(typeof headers?.get === 'function'
      ? headers.get('content-length')
      : headers?.['content-length'] ?? headers?.['Content-Length']);
    if (Number.isFinite(declared) && declared > limit) throw tooLarge();

    const body = request.body;
    if (typeof body === 'string') return parse(body);
    if (body instanceof Uint8Array) {
      append(body);
      return parse(Buffer.concat(chunks).toString('utf8'));
    }
    if (body !== undefined && body !== null && typeof body.getReader !== 'function') {
      checkObject(body);
      return parse(JSON.stringify(body));
    }

    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : BODY_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new BodyError(408, 'body-timeout')), budget);
      if (typeof timer.unref === 'function') timer.unref();
    });
    expired.catch(() => {});

    if (typeof body?.getReader === 'function') reader = body.getReader();
    else if (typeof request[Symbol.asyncIterator] === 'function') iterator = request[Symbol.asyncIterator]();
    else throw invalid();

    const reading = (async () => {
      for (;;) {
        if (stopped || Date.now() >= deadline) throw new BodyError(408, 'body-timeout');
        const step = await (reader ? reader.read() : iterator.next());
        if (stopped || Date.now() >= deadline) throw new BodyError(408, 'body-timeout');
        if (step.done) break;
        append(step.value);
      }
    })();
    reading.catch(() => {});

    await Promise.race([reading, expired]);
    completed = true;
    return parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw invalid();
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (reader) {
      if (!completed) stop(() => reader.cancel());
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    if (iterator && !completed && typeof iterator.return === 'function') stop(() => iterator.return());
  }
}

/** UTC date key (YYYY-MM-DD) for the daily call budget. */
export function dayKey(nowMs) {
  try {
    return new Date(nowMs).toISOString().slice(0, 10);
  } catch {
    return '1970-01-01';
  }
}

/** Current budget usage for a state object, rolling over at UTC midnight. */
export function usageFor(state, settings, nowMs) {
  const day = dayKey(nowMs);
  if (state.usage === undefined || state.usage === null || state.usage.day !== day) {
    state.usage = { day, used: 0 };
  }
  return { day: state.usage.day, used: state.usage.used, budget: Number(settings?.dailyCallBudget) || 0 };
}

/** Build the HTTP route handler bound to one plugin instance's state and runtime. */
export function createHandler(ctx, state, runtime) {
  return async (request, response) => {
    const reply = (status, body) => sendJson(response, status, body, { method: request.method });
    let path = '/';
    try {
      const url = new URL(request.url ?? '/', 'http://next-say.invalid');
      path = url.pathname;

      const connection = service(ctx, 'connection');
      if (typeof connection?.requestRejection === 'function') {
        let rejection;
        try {
          rejection = connection.requestRejection(request);
        } catch {
          rejection = 403;
        }
        if (rejection !== undefined) {
          reply(rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'forbidden' });
          return;
        }
      } else {
        reply(403, { ok: false, reason: 'forbidden' });
        return;
      }

      if (path === `${ROUTE}/settings` && request.method === 'GET') {
        reply(200, { ok: true, settings: state.settings, defaults: DEFAULTS, usage: usageFor(state, state.settings, Date.now()) });
        return;
      }

      if (path === `${ROUTE}/settings` && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (body.reset === true) {
          const reset = applyPatch(state.settings, DEFAULTS);
          state.settings = writeSettings(state.file, reset);
        } else {
          state.settings = writeSettings(state.file, applyPatch(state.settings, body));
        }
        reply(200, { ok: true, settings: state.settings });
        return;
      }

      if (path === `${ROUTE}/turn` && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null || sessionId === '') {
          reply(200, { ok: true, turn: null, enabled: state.settings.enabled });
          return;
        }
        const sessions = service(ctx, 'sessions');
        let session;
        try {
          session = sessions?.get?.(sessionId);
        } catch {
          session = undefined;
        }
        const latest = session === undefined ? null : lastCompletedTurn(session, runtime);
        reply(200, {
          ok: true,
          turn: latest,
          predicted: runtime.deliveredTurns.get(sessionId) ?? null,
          enabled: state.settings.enabled,
          paused: isPaused(state.settings),
          mode: state.settings.mode,
        });
        return;
      }

      if (path === `${ROUTE}/history` && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        const sessions = service(ctx, 'sessions');
        let session;
        try {
          session = sessionId === null ? undefined : sessions?.get?.(sessionId);
        } catch {
          session = undefined;
        }
        if (session === undefined) {
          reply(200, { ok: true, items: [] });
          return;
        }
        const settings = state.settings;
        let messages = [];
        try {
          messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
        } catch {
          messages = [];
        }
        const items = recentUserHistory(messages);
        reply(200, { ok: true, items, paused: isPaused(settings) });
        return;
      }

      if (path === `${ROUTE}/predict` && request.method === 'POST') {
        const body = await readJsonBody(request);
        const settings = state.settings;
        if (settings.enabled !== true) {
          reply(200, { ok: false, reason: 'disabled' });
          return;
        }
        if (body.manual !== true && settings.mode !== 'auto') {
          reply(200, { ok: false, reason: 'manual-only' });
          return;
        }
        if (isPaused(settings)) {
          reply(200, { ok: false, reason: 'paused' });
          return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (sessionId === '') {
          reply(400, { ok: false, reason: 'missing-session' });
          return;
        }
        let turn = typeof body.turn === 'number' && Number.isFinite(body.turn) ? body.turn : undefined;
        if (turn !== undefined) {
          const claimed = runtime.deliveredTurns.get(sessionId);
          if (claimed !== undefined && turn <= claimed) {
            reply(200, { ok: false, reason: 'already-predicted' });
            return;
          }
        }
        const sessions = service(ctx, 'sessions');
        let session;
        try {
          session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
        } catch {
          session = undefined;
        }
        if (session === undefined) {
          reply(200, { ok: false, reason: 'no-session' });
          return;
        }
        if (body.manual !== true) {
          turn ??= lastCompletedTurn(session, runtime) ?? undefined;
          if (turn !== undefined && turn <= (runtime.deliveredTurns.get(sessionId) ?? -Infinity)) {
            reply(200, { ok: false, reason: 'already-predicted' });
            return;
          }
          if (runtime.inflight.has(sessionId)) {
            reply(200, { ok: false, reason: 'in-progress' });
            return;
          }
        }

        // Reserve daily call budget BEFORE dispatching the model call so
        // concurrent requests cannot race past the daily cap. Refund if no
        // model call actually ran (`elapsedMs === undefined`).
        const budget = Number(settings.dailyCallBudget) || 0;
        let budgetReserved = false;
        let reservedDay;
        if (budget > 0) {
          const usage = usageFor(state, settings, Date.now());
          if (usage.used >= budget) {
            reply(200, { ok: false, reason: 'budget', usage });
            return;
          }
          state.usage.used = usage.used + 1;
          reservedDay = state.usage.day;
          budgetReserved = true;
        }

        let result;
        try {
          result = await generate(ctx, session, settings, {
            avoid: typeof body.avoid === 'string' ? body.avoid : undefined,
            forceDifferent: body.forceDifferent === true,
            draft: typeof body.draft === 'string' ? body.draft : undefined,
          }, runtime);
        } catch (error) {
          if (budgetReserved && state.usage && state.usage.day === reservedDay && state.usage.used > 0) {
            state.usage.used -= 1;
          }
          throw error;
        }

        if (budgetReserved) {
          if (result.elapsedMs === undefined && state.usage && state.usage.day === reservedDay && state.usage.used > 0) {
            state.usage.used -= 1;
          }
        } else if (result.elapsedMs !== undefined) {
          const usage = usageFor(state, settings, Date.now());
          state.usage.used = usage.used + 1;
        }

        if (turn !== undefined && result.reason !== 'superseded') {
          const previousAttempt = runtime.attempts.get(sessionId);
          const used = (previousAttempt?.turn === turn ? previousAttempt.used : 0) + 1;
          if (result.ok === true || used >= MAX_ATTEMPTS) {
            setBounded(runtime.deliveredTurns, sessionId, Math.max(turn, runtime.deliveredTurns.get(sessionId) ?? -Infinity));
            runtime.attempts.delete(sessionId);
          } else {
            setBounded(runtime.attempts, sessionId, { turn, used });
          }
        }
        reply(200, result);
        return;
      }

      reply(404, { ok: false, reason: 'not-found' });
    } catch (error) {
      if (error instanceof BodyError) {
        reply(error.status, { ok: false, reason: error.code });
        return;
      }
      reply(500, {
        ok: false,
        reason: 'internal',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  };
}
