/**
 * Bounded HTTP helpers, shared settings store, history cache, and pure
 * composer utilities for next-say's browser half.
 *
 * Inlined into `lib/client.js` by `tools/build-client.mjs`. Pure ASCII only.
 */

const SETTINGS_TIMEOUT_MS = 10000;

async function fetchJsonRaw(path, options, signal) {
  const init = {
    credentials: 'same-origin',
    ...(options.method ? { method: options.method } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
  const response = await fetch(API + path, init);
  const body = await response.json();
  if (response.ok === false) {
    throw Object.assign(new Error('request failed (' + response.status + ')'), { status: response.status });
  }
  return body;
}

/**
 * Bound a JSON fetch by both wall-clock timeout and an optional external
 * AbortSignal, attaching `.catch(() => {})` to both race branches so the loser
 * can never trigger an UnhandledPromiseRejection.
 */
async function fetchJsonBounded(path, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const externalSignal = options.signal;
  const controller = new AbortController();
  let timer;
  let onAbort;
  const makeTimeoutError = typeof options.timeoutError === 'function'
    ? options.timeoutError
    : () => new Error('read request timed out');
  const cancelFromExternal = () => {
    clearTimeout(timer);
    controller.abort(externalSignal && externalSignal.reason);
  };
  externalSignal?.addEventListener?.('abort', cancelFromExternal, { once: true });
  try {
    if (externalSignal && externalSignal.aborted) cancelFromExternal();
    controller.signal.throwIfAborted();
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    interrupted.catch(() => {});
    timer = setTimeout(() => controller.abort(makeTimeoutError()), timeoutMs);
    const work = fetchJsonRaw(path, options, controller.signal);
    work.catch(() => {});
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    externalSignal?.removeEventListener?.('abort', cancelFromExternal);
  }
}

function getJsonBounded(path, signal, timeoutMs = 10000) {
  return fetchJsonBounded(path, { signal, timeoutMs });
}

function postJsonBounded(path, payload, signal, timeoutMs = 10000, timeoutError) {
  return fetchJsonBounded(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
    timeoutMs,
    timeoutError,
  });
}

/**
 * Whether the caret is in the message editor for `sessionId`.
 */
function inComposer(sessionId) {
  const active = document.activeElement;
  if (!active || typeof active.closest !== 'function') return false;
  const editor = active.closest('[data-composer-input="true"]');
  if (!editor) return false;
  const conversation = editor.closest('[data-conversation-session]');
  return !conversation || conversation.getAttribute('data-conversation-session') === String(sessionId);
}

/** Shared settings snapshot, so the overlay and settings page stay in sync. */
const settingsStore = {
  value: null,
  error: undefined,
  writeUncertain: false,
  listeners: new Set(),
  set(next) {
    this.value = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the others from repainting.
      }
    }
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  },
};

let settingsLoad = null;
let settingsRevision = 0;
let settingsQueueEpoch = 0;
let settingsWrites = Promise.resolve();

function uncertainSettingsError() {
  return Object.assign(new Error('settings require a fresh read'), { code: 'settings-uncertain' });
}

function settingsRequest(payload) {
  const timeoutError = () => Object.assign(new Error('settings request timed out'), { code: 'settings-timeout' });
  if (payload === undefined) {
    return fetchJsonBounded('/settings', { timeoutMs: SETTINGS_TIMEOUT_MS, timeoutError });
  }
  return postJsonBounded('/settings', payload, undefined, SETTINGS_TIMEOUT_MS, timeoutError);
}

function loadSettings() {
  if (settingsLoad !== null) return settingsLoad;
  const revision = settingsRevision;
  settingsLoad = (async () => {
    try {
      const body = await settingsRequest();
      if (!body || body.ok !== true || !body.settings) throw new Error('invalid settings response');
      if (revision === settingsRevision) {
        settingsStore.error = undefined;
        settingsStore.writeUncertain = false;
        settingsStore.set(body.settings);
      }
      return body.settings;
    } catch (error) {
      if (revision === settingsRevision) {
        settingsStore.error = error instanceof Error ? error.message : String(error);
        if (settingsStore.value === null) settingsStore.set({ ...DEFAULT_SETTINGS });
      }
      return undefined;
    } finally {
      settingsLoad = null;
    }
  })();
  return settingsLoad;
}

function saveSettings(patch) {
  settingsRevision += 1;
  const payload = { ...patch };
  const epoch = settingsQueueEpoch;
  const write = settingsWrites.then(async () => {
    if (settingsStore.writeUncertain || epoch !== settingsQueueEpoch) throw uncertainSettingsError();
    let body;
    try {
      body = await settingsRequest(payload);
      if (!body || body.ok !== true || !body.settings) throw new Error('invalid settings response');
    } catch (error) {
      if (![400, 401, 403, 404, 405, 408, 413].includes(error && error.status)) {
        settingsStore.writeUncertain = true;
        settingsQueueEpoch += 1;
        settingsRevision += 1;
        throw uncertainSettingsError();
      }
      throw error;
    }
    settingsRevision += 1;
    settingsStore.error = undefined;
    settingsStore.set(body.settings);
    return body;
  });
  settingsWrites = write.catch(() => {});
  return write;
}

/**
 * Bounded LRU of user-authored messages per session for zero-cost local completion.
 */
function createHistoryCache() {
  const entries = new Map();
  const maxSessions = 16;
  const maxTotalChars = 1000000;
  let totalChars = 0;
  const forget = (sessionId) => {
    const entry = entries.get(sessionId);
    if (entry) totalChars -= entry.chars;
    entries.delete(sessionId);
  };
  const touch = (sessionId, entry) => {
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    for (let guard = 0; guard <= maxSessions && (entries.size > maxSessions || totalChars > maxTotalChars); guard += 1) {
      forget(entries.keys().next().value);
    }
  };
  const store = (sessionId, entry, items) => {
    const kept = [];
    const source = Array.isArray(items) ? items : [];
    let chars = 0;
    for (let index = source.length - 1; index >= 0 && kept.length < 200; index -= 1) {
      const item = source[index];
      if (!item || typeof item.text !== 'string' || (item.role !== undefined && item.role !== 'user')) continue;
      const text = item.text.slice(0, 2000);
      if (text.trim() === '') continue;
      kept.push({ text, role: 'user' });
      chars += text.length;
    }
    totalChars += chars - entry.chars;
    entry.chars = chars;
    entry.items = kept.reverse();
    touch(sessionId, entry);
  };
  return {
    get(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return undefined;
      touch(sessionId, entry);
      return entry.items;
    },
    set(sessionId, items) {
      const entry = entries.get(sessionId) || { items: [], chars: 0 };
      entry.revision = {};
      store(sessionId, entry, items);
    },
    async refresh(sessionId, signal) {
      if (!sessionId) return [];
      const entry = entries.get(sessionId) || { items: [], chars: 0 };
      const revision = {};
      entry.revision = revision;
      touch(sessionId, entry);
      try {
        const body = await getJsonBounded('/history?sessionId=' + encodeURIComponent(sessionId), signal);
        if (!body || body.ok === false || !Array.isArray(body.items)) throw new Error('invalid history response');
        if (!(signal && signal.aborted) && entries.get(sessionId) === entry && entry.revision === revision) {
          store(sessionId, entry, body && body.items);
        }
      } catch {
        // Keep the last successful pool when a refresh is cancelled or fails.
      }
      return entries.get(sessionId)?.items || [];
    },
    clear: forget,
  };
}

const historyCache = createHistoryCache();

/** Pub-sub bridge between the headless overlay and the composer dock button. */
const manualControls = {
  entries: new Map(),
  listeners: new Set(),
  publish(sessionId, owner, value) {
    this.entries.set(sessionId, { ...value, owner });
    for (const listener of this.listeners) listener(sessionId);
  },
  remove(sessionId, owner) {
    if (this.entries.get(sessionId)?.owner !== owner) return;
    this.entries.delete(sessionId);
    for (const listener of this.listeners) listener(sessionId);
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
};

/**
 * Decide the next ArrowUp/ArrowDown history-recall action.
 */
function historyRecallStep(items, current, draft, key) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
  const recalling = current && typeof current.text === 'string' ? current : null;
  const text = typeof draft === 'string' ? draft : '';
  const blank = text.trim() === '';
  const onRecalled = recalling !== null && text === recalling.text;
  if (!blank && !onRecalled) return null;
  if (key === 'ArrowUp') {
    const nextIndex = blank ? list.length - 1 : Math.max(0, (recalling ? recalling.index : list.length) - 1);
    const next = list[nextIndex];
    const value = next && typeof next.text === 'string' ? next.text : '';
    return value !== '' ? { action: 'set', index: nextIndex, text: value } : null;
  }
  if (recalling === null) return null;
  const nextIndex = recalling.index + 1;
  if (nextIndex >= list.length) return { action: 'clear' };
  const next = list[nextIndex];
  return next && typeof next.text === 'string' ? { action: 'set', index: nextIndex, text: next.text } : null;
}
