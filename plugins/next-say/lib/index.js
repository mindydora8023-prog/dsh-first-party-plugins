/**
 * Host half of dsh-plugin-next-say.
 *
 * Responsibilities, and nothing else:
 *   1. Record ONE finished turn per session, from the durable `agent/turn-stopping`
 *      event, so the browser can ask "may I predict now?" without polling
 *      `agent/status` (which flips once per step and would look like many turns).
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
import { readFileSync, writeFileSync } from 'node:fs';
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
  isUserAuthored,
  normalizeSuggestion,
  recentMessages,
  resolveRoute,
} from './predict.js';
import {
  DEFAULTS,
  applyPatch,
  isPaused,
  pauseUntil,
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
  for (const key of attempts.keys()) {
    if (key.startsWith(`${sessionId}\u0000`)) attempts.delete(key);
  }
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
async function readJsonBody(request, limit = 64 * 1024) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new Error('request body too large');

  let text = '';
  const body = request.body;
  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && typeof body.getReader !== 'function' && !(body instanceof ReadableStream)) {
      // Already decoded by the carrier.
      return body;
    }
    if (typeof body === 'string') {
      text = body;
    } else if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new Error('request body too large');
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
  } else if (typeof request[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > limit) throw new Error('request body too large');
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }

  return text.trim() === '' ? {} : JSON.parse(text);
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

  try {
    const call = await llm.prepareCall(
      {
        provider: route.provider,
        model: route.model,
        maxTokens: charsToTokens(budgetChars, language),
      },
      abort.signal,
    );
    // Dispatch with the PREPARED config, not the one built here.
    //
    // `stream()` asserts `callConfigEquals(options, prepared.config)` and throws
    // "prepared LLM call config changed before adapter dispatch" otherwise.
    // `prepareCall` materializes adapter defaults (reasoning effort, temperature,
    // maxTokens, ...), so re-sending raw provider/model/maxTokens is never equal
    // to what was prepared. Observed live as an instant, message-less failure.
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
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        output += chunk.text;
        // A provider that ignores maxTokens must not fill memory.
        if (output.length > MAX_RAW_CHARS) break;
      }
      if (chunk?.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    release();
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'superseded' : 'failed',
      message: message.slice(0, 300),
      elapsedMs: Date.now() - startedAt,
    };
  }

  release();

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

      // TEMP OBSERVABILITY: lets a local run answer "is the client half alive and
      // what did it say?" without a browser console. Removed before delivery.
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
        const items = [];
        let messages = [];
        try {
          messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
        } catch {
          messages = [];
        }
        for (const message of messages) {
          if (message?.role !== 'user') continue;
          // Injected context arrives as a user message; only the human's own text
          // is valid completion material.
          if (!isUserAuthored(message)) continue;
          const blocks = Array.isArray(message.content) ? message.content : [];
          const text = blocks
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text.trim())
            .filter((value) => value !== '')
            .join(' ');
          if (text === '') continue;
          items.push({ text: text.slice(0, 2000), role: 'user' });
        }
        json(response, 200, { ok: true, items: items.slice(-500), paused: isPaused(settings) });
        return;
      }

      if (path === `${ROUTE}/predict` && request.method === 'POST') {
        const body = await readJsonBody(request);
        const settings = state.settings;
        // TEMP OBSERVABILITY (removed before delivery).
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
        const turn = typeof body.turn === 'number' && Number.isFinite(body.turn) ? body.turn : undefined;
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
        const result = await generate(ctx, session, settings, {
          avoid: typeof body.avoid === 'string' ? body.avoid : undefined,
          forceDifferent: body.forceDifferent === true,
          draft: typeof body.draft === 'string' ? body.draft : undefined,
        });
        if (turn !== undefined) {
          const key = `${sessionId}\u0000${turn}`;
          const used = (attempts.get(key) ?? 0) + 1;
          if (result.ok === true || used >= MAX_ATTEMPTS) {
            deliveredTurns.set(sessionId, turn);
            attempts.delete(key);
          } else {
            attempts.set(key, used);
          }
        } else {
        }
        json(response, 200, result);
        return;
      }

      json(response, 404, { ok: false, reason: 'not-found' });
    } catch (error) {
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

  // Record one finished turn per session. `agent/turn-stopping` fires when the
  // turn is about to close with no live tool calls, which is the exact moment
  // "the assistant has finished answering".
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
  deliveredTurns,
  predictingIn,
  memory,
  historyOf,
  lastCompletedTurn,
  resetState() {
    deliveredTurns.clear();
    predictingIn.clear();
    scanCache.clear();
  },
};
