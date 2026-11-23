/**
 * Per-instance turn tracking and auxiliary model execution for next-say.
 *
 * All runtime bookkeeping lives inside an instance state object created by
 * `createRuntimeState()`, so multiple plugin lifecycles never share mutable
 * module-level Maps and unloading tears down every map and memory entry.
 *
 * Source is kept pure ASCII (workspace convention).
 */
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
  resolveRoute,
} from './predict.js';

/** Hard cap on one auxiliary reply, regardless of settings. */
export const MAX_RAW_CHARS = 8000;

/** Bounded session bookkeeping capacity per plugin instance. */
export const MAX_SESSION_ENTRIES = 256;

/** Bounded log window scanned backwards when finding the latest completed turn. */
export const SCAN_EVENTS = 2000;

/** One retry after a failure, then give up on the turn. */
export const MAX_ATTEMPTS = 2;

/** Insert or refresh a key in a bounded LRU Map. */
export function setBounded(map, key, value, limit = MAX_SESSION_ENTRIES) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Allocate isolated per-apply runtime state. */
export function createRuntimeState() {
  return {
    inflight: new Map(),
    memory: createSuggestionMemory(100),
    deliveredTurns: new Map(),
    scanCache: new Map(),
    attempts: new Map(),
  };
}

/** Read an optional Cordis service without triggering a hard-dependency throw. */
export function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
  } catch {
    return undefined;
  }
}

/** Drop all per-session bookkeeping when a session is disposed. */
export function forgetSession(runtime, sessionId) {
  runtime.deliveredTurns.delete(sessionId);
  runtime.scanCache.delete(sessionId);
  runtime.attempts.delete(sessionId);
  runtime.inflight.get(sessionId)?.abort();
  runtime.inflight.delete(sessionId);
  runtime.memory.delete(sessionId);
}

/** Abort all pending predictions and clear every runtime cache on unload. */
export function disposeRuntime(runtime) {
  for (const controller of runtime.inflight.values()) controller.abort();
  runtime.inflight.clear();
  runtime.deliveredTurns.clear();
  runtime.scanCache.clear();
  runtime.attempts.clear();
  runtime.memory.clear();
}

/**
 * Derive the newest turn whose `turn/end` says `completed` by scanning the
 * durable session log backwards, memoized per (session, seq).
 */
export function lastCompletedTurn(session, runtime) {
  let seq;
  try {
    seq = Number(session.seq);
  } catch {
    return null;
  }
  if (!Number.isFinite(seq) || seq <= 0) return null;

  const id = String(session.id);
  const cached = runtime?.scanCache.get(id);
  if (cached !== undefined && cached.seq === seq) return cached.turn;

  let turn = null;
  try {
    const from = Math.max(0, seq - SCAN_EVENTS);
    const events = session.snapshotEvents(from, seq);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.type !== 'turn/end') continue;
      const reason = event.data === undefined ? undefined : event.data.reason;
      if (reason === undefined || reason.kind !== 'completed') continue;
      turn = typeof event.data.turn === 'number' ? event.data.turn : null;
      break;
    }
  } catch {
    turn = null;
  }

  if (runtime) setBounded(runtime.scanCache, id, { seq, turn });
  return turn;
}

/** A complete settings override wins. Otherwise use the session's last request. */
export function routeFor(session, settings) {
  const provider = settings.provider?.trim();
  const model = settings.model?.trim();
  if (provider && model) return { provider, model };
  return resolveRoute(session);
}

/** Collect the plain-text messages an auxiliary call may read. */
export function historyOf(session, settings) {
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
 * One auxiliary model call, bounded end to end.
 *
 * The deadline covers adapter retries as well: `prepareCall` and `stream` share
 * one AbortSignal, and both branches of `Promise.race` attach `.catch(() => {})`
 * so losing branches never produce unhandled promise rejections.
 */
export async function generate(ctx, session, settings, options = {}, runtime = createRuntimeState()) {
  const route = options.route ?? routeFor(session, settings);
  if (route === undefined) {
    return { ok: false, reason: 'no-route' };
  }

  const history = historyOf(session, settings);
  if (history.length === 0) {
    return { ok: false, reason: 'no-history' };
  }

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
  const previous = runtime.inflight.get(sessionId);
  if (previous !== undefined) previous.abort();

  const timer = setTimeout(() => {
    abort.abort(Object.assign(new Error('prediction timed out'), { name: 'TimeoutError' }));
  }, settings.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  let output = '';
  let finish;
  const startedAt = Date.now();

  runtime.inflight.set(sessionId, abort);

  const release = () => {
    clearTimeout(timer);
    if (runtime.inflight.get(sessionId) === abort) runtime.inflight.delete(sessionId);
  };

  let onAbort;
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
  });
  cancelled.catch(() => {});

  try {
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
          if (output.length + chunk.text.length > MAX_RAW_CHARS) {
            abort.abort(new Error('prediction exceeded output limit'));
            abort.signal.throwIfAborted();
          }
          output += chunk.text;
        }
        if (chunk?.type === 'finish') finish = chunk.reason;
      }
    })();
    work.catch(() => {});
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

  const draft = typeof options.draft === 'string' ? options.draft.trim() : '';
  if (draft !== '' && dedupeKey(suggestion) === dedupeKey(draft)) {
    return { ok: false, reason: 'repeats-draft', elapsedMs: Date.now() - startedAt, language };
  }

  const previousSuggestion = runtime.memory.get(sessionId);
  const avoidText = typeof options.avoid === 'string' ? options.avoid : '';
  if (options.forceDifferent === true) {
    if (isNearDuplicate(suggestion, avoidText) || isNearDuplicate(suggestion, previousSuggestion)) {
      return { ok: false, reason: 'duplicate', elapsedMs: Date.now() - startedAt, language };
    }
  }
  const nearDuplicate = isNearDuplicate(suggestion, previousSuggestion);
  runtime.memory.set(sessionId, suggestion);

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
