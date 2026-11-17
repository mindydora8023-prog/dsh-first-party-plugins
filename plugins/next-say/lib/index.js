/**
 * Host half of dsh-plugin-next-say.
 *
 * Responsibilities, and nothing else:
 *   1. Derive the latest completed turn from durable `turn/end` events so the
 *      browser can ask "may I predict now?" without polling `agent/status`
 *      (which flips once per step and would look like many turns).
 *   2. Own the auxiliary model call. The Client never talks to a provider.
 *   3. Serve the small same-origin API the suggestion row and the settings page
 *      read, behind DSH's own browser authentication.
 *
 * The plugin never appends a session event: a prediction is not part of the
 * conversation, so it must not appear in the log, in fork/resume, or in the
 * model's context.
 *
 * Source is kept pure ASCII (workspace convention).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildRequestText,
  buildSystemPrompt,
  charsToTokens,
  createSuggestionMemory,
  dedupeKey,
  detectConversationLanguage,
  isNearDuplicate,
  normalizeSuggestion,
  recentMessages,
  recentUserHistory,
  resolveRoute,
} from './predict.js';
import {
  DEFAULTS,
  applyPatch,
  isPaused,
  readSettings,
  settingsPath,
  writeSettings,
} from './config.js';

/** Prefix route owned by this plugin. Longest-prefix wins over the SPA fallback. */
const ROUTE = '/next-say';

/** Hard cap on one auxiliary reply, regardless of settings. */
const MAX_RAW_CHARS = 8000;

/** One prediction in flight per session; a newer request supersedes the older. */
const inflight = new Map();

/** Last shown suggestion per session, so a duplicate can be refused. */
const memory = createSuggestionMemory(100);

/**
 * The last COMPLETED turn the browser has already been handed, per session.
 *
 * This is the only turn bookkeeping the plugin keeps. The finished turn itself is
 * not recorded anywhere: it is DERIVED from the session log on demand (see
 * `lastCompletedTurn`), because a plugin-side event listener proved unreliable --
 * the route answered "no turn" forever while the plugin row reported `active`.
 * The log is durable and is the documented source of truth, so deriving from it
 * also survives a restart and a page refresh.
 */
const deliveredTurns = new Map();

/** Per-session memo of a log scan, keyed by the log length it was taken at. */
const scanCache = new Map();

/**
 * Attempts per (session, turn).
 *
 * The turn is now claimed only when a suggestion was actually produced, so a
 * failed generation is retried instead of burning the turn. This counter stops
 * that retry from becoming an infinite loop of model calls.
 */
const attempts = new Map();

/** One retry after a failure, then give up on the turn. */
const MAX_ATTEMPTS = 2;

/** Sessions with a prediction in flight, and how many. */
const predictingIn = new Map();

/**
 * The newest turn whose `turn/end` says `completed`, read backwards from the log.
 *
 * Why not listen for `agent/turn-stopping`: a root-context listener for that event
 * never fired in the live composition (the feed answered `no turn` after every
 * single turn while the plugin itself was active), and there is no way to observe
 * the difference from outside. The log, by contrast, is durable, is what the
 * harness itself treats as truth, and works after a restart or a page refresh.
 *
 * Bounded: at most SCAN_EVENTS events are inspected, and the result is memoised
 * per (session, log length) so a 2 s poll does not rescan a long log.
 */
const SCAN_EVENTS = 2000;

function lastCompletedTurn(session) {
  let seq;
  try {
    seq = Number(session.seq);
  } catch {
    return null;
  }
  if (!Number.isFinite(seq) || seq <= 0) return null;

  const id = String(session.id);
  const cached = scanCache.get(id);
  if (cached !== undefined && cached.seq === seq) return cached.turn;

  let turn = null;
  try {
    const from = Math.max(0, seq - SCAN_EVENTS);
    const events = session.snapshotEvents(from, seq);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) continue;
      // Only `turn/end` matters. Do NOT stop at `turn/start`: the current turn's
      // start sits AFTER the previous turn's end in the log, so breaking there
      // discarded the very completion being looked for. Running this against a
      // real session log is what surfaced it.
      if (event.type !== 'turn/end') continue;
      const reason = event.data === undefined ? undefined : event.data.reason;
      if (reason === undefined || reason.kind !== 'completed') continue;
      turn = typeof event.data.turn === 'number' ? event.data.turn : null;
      break;
    }
  } catch {
    turn = null;
  }

  scanCache.set(id, { seq, turn });
  return turn;
}

/** Per-session bookkeeping that must not outlive the session. */
function forgetSession(sessionId) {
  deliveredTurns.delete(sessionId);
  scanCache.delete(sessionId);
  attempts.delete(sessionId);
  inflight.get(sessionId)?.abort();
  predictingIn.delete(sessionId);
  memory.delete(sessionId);
  inflight.delete(sessionId);
}

// `DSH_HOME` is the documented per-user store; `DSH_PROFILE_DIR` is the
// profile fallback when the Host was booted with one but no explicit home.
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.trim() !== '') return dirname(profile);
  return join(homedir(), '.dsh');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read a JSON body from EITHER carrier.
 *
 * `ctx.connection.fetch` routes receive a Fetch `Request`; `ctx.webServer`
 * routes receive the raw Node `IncomingMessage`, which is an async iterable but
 * has no `body` stream and no `getReader()`. Handling both keeps this one
 * handler usable from either registration without a silent "empty body".
 */
const BODY_TIMEOUT_MS = 5000;

class BodyError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(request, limit = 64 * 1024, timeoutMs = BODY_TIMEOUT_MS) {
  let reader;
  let iterator;
  let completed = false;
  let stopped = false;
  let timer;
  // Cleanup is best effort: a hostile carrier's cancel/return can also hang.
  const stop = (callback) => {
    try { Promise.resolve(callback()).catch(() => {}); } catch {}
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
      // Decoded carriers get the same shape and serialized UTF-8 budget checks.
      checkObject(body);
      return parse(JSON.stringify(body));
    }

    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : BODY_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new BodyError(408, 'body-timeout')), budget);
    });
    if (typeof body?.getReader === 'function') reader = body.getReader();
    else if (typeof request[Symbol.asyncIterator] === 'function') iterator = request[Symbol.asyncIterator]();
    else throw invalid();

    const reading = (async () => {
      for (;;) {
        // Resolved empty chunks can starve timers; also enforce elapsed wall time.
        if (stopped || Date.now() >= deadline) throw new BodyError(408, 'body-timeout');
        const step = await (reader ? reader.read() : iterator.next());
        if (stopped || Date.now() >= deadline) throw new BodyError(408, 'body-timeout');
        if (step.done) break;
        append(step.value);
      }
    })();
    // One race per body, so chunks do not accumulate reactions on `expired`.
    await Promise.race([reading, expired]);
    completed = true;
    return parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    // Never publish parser excerpts or arbitrary carrier error fields/messages.
    if (error instanceof BodyError) throw error;
    throw invalid();
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (reader) {
      if (!completed) stop(() => reader.cancel());
      try { reader.releaseLock(); } catch {}
    }
    if (iterator && !completed && typeof iterator.return === 'function') stop(() => iterator.return());
  }
}

/**
 * Read an optional Cordis service.
 *
 * `ctx.<name>` is a hard dependency: Cordis throws when the service is not in
 * the plugin's `inject` list. This plugin declares no hard dependencies (it
 * degrades instead of refusing to mount), so EVERY service access must go
 * through `ctx.get()`. A thrown access inside a route handler is what turns an
 * ordinary "service missing" into an opaque HTTP 400 with an empty body.
 */
function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * Which provider/model the auxiliary call runs on.
 *
 * Order: an explicitly pinned route from the settings page, then the session's own
 * model, then the global default.
 *
 * The settings page has offered `provider` / `model` ("pin a cheaper model") since
 * the first version, but this function ignored them -- the fields were decorative
 * and picking a model there changed nothing. Silent settings are worse than absent
 * ones, so they are honoured here.
 */
function routeFor(ctx, session, settings) {
  const pinnedProvider = typeof settings?.provider === 'string' ? settings.provider.trim() : '';
  const pinnedModel = typeof settings?.model === 'string' ? settings.model.trim() : '';
  if (pinnedProvider !== '' && pinnedModel !== '') {
    return { provider: pinnedProvider, model: pinnedModel };
  }

  const selection = service(ctx, 'agentDefaultModel');
  let fallback;
  try {
    fallback = typeof selection?.currentSelection === 'function' ? selection.currentSelection() : undefined;
  } catch {
    fallback = undefined;
  }
  return resolveRoute(session, fallback);
}

/**
 * Collect the plain-text messages an auxiliary call may read.
 *
 * `deriveMessages()` is the read-only message view, so nothing here can steer
 * the conversation or create a fork.
 */
function historyOf(session, settings) {
  let messages = [];
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
  } catch {
    messages = [];
  }
  return recentMessages(messages, {
    maxMessages: settings.contextMessages,
    maxChars: settings.contextChars,
  });
}

/**
 * One auxiliary call, bounded end to end.
 *
 * The deadline covers adapter retries as well: `prepareCall` and `stream` share
 * one AbortSignal, so a slow provider cannot outlive the user's patience.
 */
async function generate(ctx, session, settings, options = {}) {
  // Order matters: each refusal names the FIRST thing that is missing, so the
  // reason a prediction did not happen is never misreported.
  const route = options.route ?? routeFor(ctx, session, settings);
  if (route === undefined) {
    return { ok: false, reason: 'no-route' };
  }

  const history = historyOf(session, settings);
  if (history.length === 0) {
    return { ok: false, reason: 'no-history' };
  }

  // No `llm` in this composition is a well-formed refusal, not a crash.
  const llm = service(ctx, 'llm');
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    return { ok: false, reason: 'no-llm' };
  }

  const language = detectConversationLanguage(history);
  const budgetChars = settings.maxSuggestionChars;
  const system = buildSystemPrompt(language, budgetChars);
  const requestText = buildRequestText(history, language, {
    avoid: options.avoid,
    forceDifferent: options.forceDifferent === true,
  });

  const abort = new AbortController();
  const sessionId = String(session.id);
  const previous = inflight.get(sessionId);
  // Supersede rather than queue: an older prediction is no longer what the user
  // is looking at, and a queued one would spend money on a stale answer.
  if (previous !== undefined) previous.abort();

  const timer = setTimeout(() => {
    abort.abort(Object.assign(new Error('prediction timed out'), { name: 'TimeoutError' }));
  }, settings.timeoutMs);

  let output = '';
  let finish;
  const startedAt = Date.now();

  inflight.set(sessionId, abort);
  predictingIn.set(sessionId, (predictingIn.get(sessionId) ?? 0) + 1);

  const release = () => {
    clearTimeout(timer);
    if (inflight.get(sessionId) === abort) inflight.delete(sessionId);
    const left = (predictingIn.get(sessionId) ?? 1) - 1;
    if (left <= 0) predictingIn.delete(sessionId);
    else predictingIn.set(sessionId, left);
  };

  let onAbort;
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
  });

  try {
    // Racing the work bounds waiting even when an adapter ignores its signal.
    // Keep all publication outside this task so a late completion is inert.
    const work = (async () => {
      const call = await llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          maxTokens: charsToTokens(budgetChars, language),
        },
        abort.signal,
      );
      abort.signal.throwIfAborted();
      // Dispatch with the PREPARED config, not the one built here.
      // `prepareCall` materializes adapter defaults, and stream() requires the
      // same prepared controls rather than raw provider/model/maxTokens.
      const streamOptions = {
        ...call.config,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: requestText }],
          },
        ],
        system,
        sessionId: session.id,
        signal: abort.signal,
      };
      for await (const chunk of call.stream(streamOptions)) {
        abort.signal.throwIfAborted();
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // Check before appending: one chunk can exceed the entire budget.
          if (output.length + chunk.text.length > MAX_RAW_CHARS) {
            abort.abort(new Error('prediction exceeded output limit'));
            abort.signal.throwIfAborted();
          }
          output += chunk.text;
        }
        if (chunk?.type === 'finish') finish = chunk.reason;
      }
    })();
    await Promise.race([work, cancelled]);
    abort.signal.throwIfAborted();
  } catch (error) {
    const cause = abort.signal.aborted ? abort.signal.reason : error;
    const name = cause instanceof Error ? cause.name : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      reason: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'superseded' : 'failed',
      message: message.slice(0, 300),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
    release();
  }

  if (finish?.kind === 'aborted') {
    return { ok: false, reason: 'superseded', elapsedMs: Date.now() - startedAt };
  }
  // A stream that ended with an error still carries usable text when the error
  // arrived after the last token, so only an empty result is a failure.
  const suggestion = normalizeSuggestion(output, budgetChars);
  if (suggestion === '') {
    return {
      ok: false,
      reason: finish?.kind === 'max-tokens' ? 'truncated' : 'empty',
      elapsedMs: Date.now() - startedAt,
      language,
    };
  }

  const truncated = finish?.kind === 'max-tokens' || String(output).trim().length > budgetChars;

  // A prediction that repeats the draft the user is ALREADY typing is worth
  // nothing: accepting it would insert the same sentence twice. The caller sends
  // the draft for history completion, so it is available here too -- refuse at
  // the source rather than showing it and letting the Client filter it.
  const draft = typeof options.draft === 'string' ? options.draft.trim() : '';
  if (draft !== '' && dedupeKey(suggestion) === dedupeKey(draft)) {
    return { ok: false, reason: 'repeats-draft', elapsedMs: Date.now() - startedAt, language };
  }

  const previousSuggestion = memory.get(sessionId);
  const nearDuplicate = !options.forceDifferent && isNearDuplicate(suggestion, previousSuggestion);
  memory.set(sessionId, suggestion);

  return {
    ok: true,
    suggestion,
    truncated,
    duplicate: nearDuplicate,
    language,
    route,
    historySize: history.length,
    elapsedMs: Date.now() - startedAt,
  };
}


/** Route table for the same-origin API. */
function createHandler(ctx, state) {
  return async (request, response) => {
    // The whole body runs inside one catch: a throw that escapes a route handler
    // is turned into an opaque `400` with an EMPTY body by the web carrier, which
    // is indistinguishable from "route not found" and hides the real cause.
    let path = '/';
    try {
      const url = new URL(request.url ?? '/', 'http://next-say.invalid');
      path = url.pathname;

      // Every path below is served only to an authenticated browser peer. The
      // call itself may throw (a request shape it does not expect); a throw must
      // mean "refuse", never "crash the route".
      const connection = service(ctx, 'connection');
      if (typeof connection?.requestRejection === 'function') {
        let rejection;
        try {
          rejection = connection.requestRejection(request);
        } catch {
          rejection = 403;
        }
        if (rejection !== undefined) {
          json(response, rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'forbidden' });
          return;
        }
      } else {
        json(response, 403, { ok: false, reason: 'forbidden' });
        return;
      }
      if (path === `${ROUTE}/settings` && request.method === 'GET') {
        json(response, 200, { ok: true, settings: state.settings, defaults: DEFAULTS });
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
        json(response, 200, { ok: true, settings: state.settings });
        return;
      }

      // Turn feed: the browser polls this, it never polls agent/status.
      //
      // The answer is derived from the session log rather than from a recorded
      // event, and `consume=1` records that this turn was already handed out, so
      // one finished turn produces exactly one prediction even across a refresh.
      if (path === `${ROUTE}/turn` && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null || sessionId === '') {
          json(response, 200, { ok: true, turn: null, enabled: state.settings.enabled });
          return;
        }
        const sessions = service(ctx, 'sessions');
        let session;
        try {
          session = sessions?.get?.(sessionId);
        } catch {
          session = undefined;
        }
        const latest = session === undefined ? null : lastCompletedTurn(session);
        // READ ONLY. Marking the turn on the poll is what broke this before: the
        // browser consumed a turn, then its effect re-ran (a `running` or settings
        // change) and returned before calling /predict, so that turn was consumed
        // without ever producing a suggestion and every later poll saw "already
        // delivered". The claim now happens in /predict, immediately before the
        // model call, so a turn is only spent by an actual prediction.
        json(response, 200, {
          ok: true,
          turn: latest,
          predicted: deliveredTurns.get(sessionId) ?? null,
          enabled: state.settings.enabled,
          paused: isPaused(state.settings),
          mode: state.settings.mode,
        });
        return;
      }

      // The local-history pool the row completes from. Read-only, bounded, and
      // deliberately narrower than the model call: text only, user messages
      // only, newest last.
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
          json(response, 200, { ok: true, items: [] });
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
        json(response, 200, { ok: true, items, paused: isPaused(settings) });
        return;
      }

      if (path === `${ROUTE}/predict` && request.method === 'POST') {
        const body = await readJsonBody(request);
        const settings = state.settings;
        if (settings.enabled !== true) {
          json(response, 200, { ok: false, reason: 'disabled' });
          return;
        }
        if (body.manual !== true && settings.mode !== 'auto') {
          json(response, 200, { ok: false, reason: 'manual-only' });
          return;
        }
        if (isPaused(settings)) {
          json(response, 200, { ok: false, reason: 'paused' });
          return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (sessionId === '') {
          json(response, 400, { ok: false, reason: 'missing-session' });
          return;
        }
        // A turn is CLAIMED only once it produced a suggestion.
        //
        // Claiming before the call looked tidier, but it meant a failed generation
        // consumed the turn: the feed then reported "already predicted", the poller
        // stopped, and the composer stayed empty with no way to recover except a
        // new turn. Observed live: `predicted: 12` with nothing on screen.
        let turn = typeof body.turn === 'number' && Number.isFinite(body.turn) ? body.turn : undefined;
        if (turn !== undefined) {
          const claimed = deliveredTurns.get(sessionId);
          if (claimed !== undefined && turn <= claimed) {
            json(response, 200, { ok: false, reason: 'already-predicted' });
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
          json(response, 200, { ok: false, reason: 'no-session' });
          return;
        }
        // Mount predictions omit the turn; infer it so they share the same
        // budget as the turn-feed request. Concurrent automatic requests must
        // not supersede each other and spend a second provider call.
        if (body.manual !== true) {
          turn ??= lastCompletedTurn(session) ?? undefined;
          if (turn !== undefined && turn <= (deliveredTurns.get(sessionId) ?? -Infinity)) {
            json(response, 200, { ok: false, reason: 'already-predicted' });
            return;
          }
          if (inflight.has(sessionId)) {
            json(response, 200, { ok: false, reason: 'in-progress' });
            return;
          }
        }
        const result = await generate(ctx, session, settings, {
          avoid: typeof body.avoid === 'string' ? body.avoid : undefined,
          forceDifferent: body.forceDifferent === true,
          draft: typeof body.draft === 'string' ? body.draft : undefined,
        });
        if (turn !== undefined && result.reason !== 'superseded') {
          const previousAttempt = attempts.get(sessionId);
          const used = (previousAttempt?.turn === turn ? previousAttempt.used : 0) + 1;
          if (result.ok === true || used >= MAX_ATTEMPTS) {
            deliveredTurns.set(sessionId, Math.max(turn, deliveredTurns.get(sessionId) ?? -Infinity));
            attempts.delete(sessionId);
          } else {
            attempts.set(sessionId, { turn, used });
          }
        }
        json(response, 200, result);
        return;
      }

      json(response, 404, { ok: false, reason: 'not-found' });
    } catch (error) {
      if (error instanceof BodyError) {
        json(response, error.status, { ok: false, reason: error.code });
        return;
      }
      json(response, 500, {
        ok: false,
        reason: 'internal',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  };
}

export function apply(ctx) {
  const file = settingsPath(dshHome());
  const state = { file, settings: readSettings(file) };
  ctx.effect(() => () => {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    deliveredTurns.clear();
    scanCache.clear();
    attempts.clear();
    predictingIn.clear();
  }, 'next-say prediction cleanup');

  // Serve the browser API, waiting for the carrier instead of probing it once.
  //
  // A one-shot `ctx.get('webServer')` read is a startup race: at profile-boot
  // time the carrier may not be mounted yet, so the read yields undefined and the
  // plugin silently serves nothing until some later reload happens to run apply()
  // again. That is exactly what was observed -- after every restart the route
  // answered 404 while the plugin row still reported `active`, and only a manual
  // reload brought it back. `ctx.inject` runs the callback once the service is
  // available and re-runs it if the service is replaced, which removes the race.
  ctx.inject(['webServer'], (scoped) => {
    const handler = createHandler(scoped, state);
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'next-say routes',
    );
  });

  // Drop per-session bookkeeping when a session leaves, so a long-lived Host does
  // not accumulate one entry per session ever opened.
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        let sessionId;
        try {
          sessionId = String(session.id);
        } catch {
          return;
        }
        forgetSession(sessionId);
      }),
    'next-say session cleanup',
  );
}

/**
 * Exported for tests: the pure decision surface, not the live wiring.
 *
 * `resetState` exists because these maps are module state shared by every test in
 * one process, and a leftover turn from one case silently changed the result of
 * the next (a consumed turn 4 answered a later test that expected null).
 */
export const __internals = {
  ROUTE,
  BODY_TIMEOUT_MS,
  readJsonBody,
  createHandler,
  deliveredTurns,
  predictingIn,
  memory,
  historyOf,
  generate,
  lastCompletedTurn,
  resetState() {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    attempts.clear();
    deliveredTurns.clear();
    predictingIn.clear();
    scanCache.clear();
  },
};
