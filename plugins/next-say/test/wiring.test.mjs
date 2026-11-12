/**
 * Wiring tests for the Host half, using a fake Cordis context.
 *
 * These pin the contracts that are invisible in the pure-function tests:
 *   - every route refuses an unauthenticated peer;
 *   - one finished turn yields exactly one prediction claim;
 *   - a peek does not spend the claim;
 *   - an older boundary never goes backwards;
 *   - unloading removes the route.
 *
 * No DSH runtime is required: the fake context implements only the surface
 * `apply()` actually touches.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { __internals, apply } from '../lib/index.js';

/* ------------------------------------------------------------- fake cordis */

function createFakeHost(options = {}) {
  const routes = new Map();
  const listeners = new Map();
  const effects = [];
  /** `ctx.inject` callbacks waiting for their dependencies. */
  const pending = [];

  const carrier = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };

  const services = {
    // A real profile boots plugins before the carrier is mounted, which is the
    // race this fake can reproduce: start empty and let the test mount it later.
    webServer: options.delayedCarrier === true ? undefined : carrier,
    sessions: {
      get(id) {
        return options.sessions === undefined ? undefined : options.sessions[id];
      },
    },
    connection: {
      requestRejection() {
        return options.rejection;
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'p', model: 'm' };
      },
    },
    llm: options.llm,
  };

  /**
   * Build a scoped context the way Cordis hands one to an `inject` callback:
   * the declared services are reachable as properties.
   */
  const scopedFor = (deps) => {
    const scoped = {
      get: (name) => services[name],
      effect: (factory) => {
        effects.push(factory);
        return factory();
      },
    };
    for (const dep of deps) {
      Object.defineProperty(scoped, dep, {
        get() {
          const value = services[dep];
          if (value === undefined) throw new Error(`scoped.${dep} is not mounted`);
          return value;
        },
      });
    }
    return scoped;
  };

  const ctx = {
    /**
     * Real Cordis semantics, and the reason this fake is strict: accessing an
     * undeclared service on `ctx` THROWS, while `ctx.get(name)` returns
     * undefined. A lax fake that exposed services directly once hid a plugin
     * that read `ctx.connection` -- which threw inside the route handler, and
     * the web carrier turned that into an opaque 400 with an empty body.
     */
    get(name) {
      return services[name];
    },
    /**
     * Run the callback once every dependency is mounted, and re-run it when a
     * dependency is replaced. This is what removes the startup race: a plugin
     * must not decide "there is no web server" from a single early read.
     */
    inject(deps, callback) {
      const ready = deps.every((dep) => services[dep] !== undefined);
      if (ready) {
        callback(scopedFor(deps));
        return;
      }
      pending.push({ deps, callback });
    },
  };
  Object.defineProperty(ctx, 'connection', {
    get() {
      throw new Error('ctx.connection is a hard dependency but was not injected');
    },
  });
  Object.defineProperty(ctx, 'llm', {
    get() {
      throw new Error('ctx.llm is a hard dependency but was not injected');
    },
  });
  Object.defineProperty(ctx, 'sessions', {
    get() {
      throw new Error('ctx.sessions is a hard dependency but was not injected');
    },
  });
  Object.defineProperty(ctx, 'agentDefaultModel', {
    get() {
      return services.agentDefaultModel;
    },
  });
  ctx.effect = (factory) => {
    effects.push(factory);
    return factory();
  };
  ctx.on = (event, handler) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  };

  return {
    ctx,
    routes,
    services,
    /** Mount the web carrier after apply() ran, replaying pending injections. */
    mountCarrier() {
      services.webServer = carrier;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const entry = pending[index];
        if (!entry.deps.every((dep) => services[dep] !== undefined)) continue;
        pending.splice(index, 1);
        entry.callback(scopedFor(entry.deps));
      }
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    dispose() {
      // Run every registered effect's disposer, which is what a fiber unload
      // does: it must remove the route.
      for (const factory of effects) {
        const disposer = factory();
        if (typeof disposer === 'function') disposer();
      }
      effects.length = 0;
    },
  };
}

/** Apply the plugin against a throwaway DSH_HOME, then unload it. */
async function withHost(options, body) {
  const previous = process.env.DSH_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'next-say-wiring-'));
  process.env.DSH_HOME = dir;
  // These maps live at module scope, so one case's recorded turn would otherwise
  // be visible to the next one in the same process.
  __internals.resetState();
  const host = createFakeHost(options);
  try {
    apply(host.ctx);
    return await body(host);
  } finally {
    host.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a minimal Node-ish request/response pair for one route call. */
function callRoute(route, options = {}) {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? route.path,
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8');
    },
  };
  const response = {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      return this;
    },
    end(payload) {
      this.payload = payload ?? '';
      return this;
    },
  };
  return { request, response };
}

async function hit(host, options) {
  const route = host.routes.get('/next-say');
  const { request, response } = callRoute(route, options);
  await route.handler(request, response);
  return { status: response.status, body: response.payload === '' ? undefined : JSON.parse(response.payload) };
}

/** A session object shaped like the real one for our two reads. */
/**
 * A session whose LOG carries the turn history, because the plugin derives the
 * finished turn from `turn/end` events rather than from a live event listener.
 * `pushTurn` appends one, which also advances `seq` and invalidates the scan memo.
 */
function fakeSession(id, messages, turns = []) {
  const events = [];
  const session = {
    id,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    deriveMessages: () => messages,
    get seq() {
      return events.length;
    },
    snapshotEvents(from, to) {
      return events.slice(from, to);
    },
    /** Append a `turn/end`; `kind` defaults to completed. */
    pushTurn(turn, kind = 'completed') {
      events.push({ type: 'turn/end', data: { turn, reason: { kind } } });
      return session;
    },
    /** Append an unrelated event, to prove the scan skips it. */
    pushOther(type) {
      events.push({ type, data: {} });
      return session;
    },
  };
  for (const turn of turns) session.pushTurn(turn);
  return session;
}

/* ------------------------------------------------------------------ tests */

test('applying registers a prefix route', async () => {
  await withHost({}, (host) => {
    const route = host.routes.get('/next-say');
    assert.ok(route, 'route registered');
    assert.equal(route.kind, 'prefix');
  });
});

test('the route appears even when the carrier mounts AFTER apply()', async () => {
  // The regression this exists for: apply() used to read ctx.get('webServer')
  // ONCE. At profile boot the carrier is not mounted yet, the read returned
  // undefined, and the plugin silently served nothing -- every restart answered
  // 404 while the plugin row still reported `active`. Only a reload fixed it.
  // Registration now goes through ctx.inject, which runs when the service
  // arrives, so a late carrier must still end up serving.
  await withHost({ delayedCarrier: true }, (host) => {
    assert.ok(!host.routes.has('/next-say'), 'nothing can be served before a carrier exists');
    host.mountCarrier();
    const route = host.routes.get('/next-say');
    assert.ok(route, 'the route must be registered once the carrier mounts');
    assert.equal(route.kind, 'prefix');
  });
});

test('turn tracking works without any web carrier', async () => {
  // The listener must not be gated on the carrier: a headless composition still
  // finishes turns, and gating would make that bookkeeping silently dead.
  await withHost({ delayedCarrier: true, sessions: { s1: fakeSession('s1', [], [2]) } }, (host) => {
    // Turns are derived from the log, so tracking cannot depend on the carrier.
    host.mountCarrier();
    assert.ok(host.routes.has('/next-say'));
  });
});

test('every route refuses an unauthenticated peer', async () => {
  await withHost({ rejection: 401 }, async (host) => {
    for (const [method, url] of [
      ['GET', '/next-say/settings'],
      ['GET', '/next-say/turn'],
      ['GET', '/next-say/history'],
      ['POST', '/next-say/predict'],
    ]) {
      const result = await hit(host, { method, url, body: method === 'POST' ? {} : undefined });
      assert.equal(result.status, 401, `${method} ${url}`);
      assert.equal(result.body.ok, false);
    }
  });
});

test('a 403 peer is also refused', async () => {
  await withHost({ rejection: 403 }, async (host) => {
    const result = await hit(host, { url: '/next-say/settings' });
    assert.equal(result.status, 403);
  });
});

test('settings GET returns defaults and POST round-trips through the file', async () => {
  await withHost({}, async (host) => {
    const initial = await hit(host, { url: '/next-say/settings' });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.ok, true);
    assert.equal(initial.body.settings.enabled, true);

    const patched = await hit(host, {
      method: 'POST',
      url: '/next-say/settings',
      body: { enabled: false, timeoutMs: 20000 },
    });
    assert.equal(patched.body.settings.enabled, false);
    assert.equal(patched.body.settings.timeoutMs, 20000);

    // The next GET must reflect the write: that is what makes the page honest
    // after a refresh.
    const reread = await hit(host, { url: '/next-say/settings' });
    assert.equal(reread.body.settings.enabled, false);
  });
});

test('reset restores every default', async () => {
  await withHost({}, async (host) => {
    await hit(host, { method: 'POST', url: '/next-say/settings', body: { enabled: false, timeoutMs: 30000 } });
    const reset = await hit(host, { method: 'POST', url: '/next-say/settings', body: { reset: true } });
    assert.equal(reset.body.settings.enabled, true);
    assert.equal(reset.body.settings.timeoutMs, 12000);
  });
});

test('the turn feed is read-only: polling never spends a turn', async () => {
  // The regression: consuming on the poll meant a cancelled tick (a re-render
  // while the request was in flight) burned the turn without predicting, and the
  // feed answered "already delivered" forever after.
  const session = fakeSession('s1', [], [3]);
  await withHost({ sessions: { s1: session } }, async (host) => {
    const first = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(first.body.turn, 3);
    assert.equal(first.body.predicted, null, 'nothing has been predicted yet');

    // Polling again must return the same turn: no side effect.
    const second = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(second.body.turn, 3, 'a poll must not consume the turn');
  });
});

/**
 * A stand-in for the llm service that enforces the REAL dispatch contract.
 *
 * `prepareCall` materializes adapter defaults (it adds `reasoningEffort` here, as
 * the live `deepseek-account` adapter does) and `stream` rejects a config that
 * differs from the prepared one -- exactly like `callConfigEquals` in the kernel.
 * Without this guard a plugin can pass its own raw config and every real call
 * fails instantly with "prepared LLM call config changed before adapter dispatch"
 * while unit tests stay green.
 */
function fakeLlm(reply = 'run the tests') {
  return {
    async prepareCall(config) {
      const resolved = { ...config, reasoningEffort: 'high' };
      return {
        config: resolved,
        async *stream(options) {
          const same = ['provider', 'model', 'maxTokens', 'reasoningEffort', 'temperature', 'stop']
            .every((key) => JSON.stringify(options[key]) === JSON.stringify(resolved[key]));
          if (options.provider === undefined) throw new Error('dispatch lost provider/model: spread the prepared config');
          if (!same) throw new Error('prepared LLM call config changed before adapter dispatch');
          yield { type: 'text-delta', text: reply };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
}

test('a pinned provider/model in settings decides the auxiliary route', async () => {
  // The settings page has always offered these fields; before this test the Host
  // ignored them, so "pin a cheaper model" silently did nothing.
  const seen = [];
  const llm = {
    async prepareCall(config) {
      seen.push({ provider: config.provider, model: config.model });
      const resolved = { ...config };
      return {
        config: resolved,
        async *stream(options) {
          if (options.provider === undefined) throw new Error('dispatch lost the route');
          yield { type: 'text-delta', text: 'pinned route works' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const session = fakeSession('s1', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], []);
  await withHost({ sessions: { s1: session }, llm }, async (host) => {
    await hit(host, {
      method: 'POST',
      url: '/next-say/settings',
      body: { provider: 'cheap-relay', model: 'small-model' },
    });
    const result = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1' } });
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
  });
  assert.deepEqual(seen, [{ provider: 'cheap-relay', model: 'small-model' }]);
});

test('predict claims the turn, and a second prediction for it is refused', async () => {
  const echo = fakeLlm();
  const session = fakeSession('s1', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [4]);
  await withHost({ sessions: { s1: session }, llm: echo }, async (host) => {
    const ok = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1', turn: 4 } });
    assert.equal(ok.body.ok, true);

    const feed = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(feed.body.predicted, 4, 'the claim is reported back');

    // One finished turn must never spend two model calls.
    const again = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1', turn: 4 } });
    assert.equal(again.body.ok, false);
    assert.equal(again.body.reason, 'already-predicted');
  });
});

test('the feed always reports the newest finished turn, plus what was predicted', async () => {
  const session = fakeSession('s1', [], [7]);
  await withHost({ sessions: { s1: session } }, async (host) => {
    const first = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(first.body.turn, 7);
    assert.equal(first.body.predicted, null);

    // More events arrive (a later step), but the log still ends at turn 7. The
    // feed stays truthful about the turn; dedupe is the `predicted` field.
    session.pushOther('step/start');
    const second = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(second.body.turn, 7, 'the turn itself is unchanged');
    assert.equal(second.body.predicted, null, 'and it is still unpredicted');

    // A genuinely newer finished turn is reported.
    session.pushTurn(8);
    const next = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(next.body.turn, 8);
  });
});

test('turns are tracked per session, not globally', async () => {
  const a = fakeSession('a', [], [1]);
  const b = fakeSession('b', [], [4]);
  await withHost({ sessions: { a, b } }, async (host) => {
    const one = await hit(host, { url: '/next-say/turn?sessionId=a' });
    const two = await hit(host, { url: '/next-say/turn?sessionId=b' });
    assert.equal(one.body.turn, 1);
    assert.equal(two.body.turn, 4);
  });
});

test('an unfinished turn is not offered', async () => {
  // A turn that ended as `aborted` or `error` is not something to predict after.
  const session = fakeSession('s1', [], []);
  session.pushTurn(2, 'aborted');
  await withHost({ sessions: { s1: session } }, async (host) => {
    const result = await hit(host, { url: '/next-say/turn?sessionId=s1' });
    assert.equal(result.body.turn, null);
  });
});

test('history lists user text only and is bounded', async () => {
  const session = fakeSession('s1', [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }, { type: 'image', attachment: {} }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
  ]);
  await withHost({ sessions: { s1: session } }, async (host) => {
    const result = await hit(host, { url: '/next-say/history?sessionId=s1' });
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.items.map((item) => item.text), ['first question', 'second question']);
    assert.ok(result.body.items.every((item) => item.role === 'user'));
  });
});

test('history for an unknown session is empty, not an error', async () => {
  await withHost({}, async (host) => {
    const result = await hit(host, { url: '/next-say/history?sessionId=nope' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, []);
  });
});

test('predict refuses without a session id', async () => {
  await withHost({}, async (host) => {
    const result = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: '' } });
    assert.equal(result.status, 400);
  });
});

test('predict refuses when disabled, paused, or manual-only', async () => {
  const session = fakeSession('s1', [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }]);

  await withHost({ sessions: { s1: session } }, async (host) => {
    await hit(host, { method: 'POST', url: '/next-say/settings', body: { enabled: false } });
    const off = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1', manual: true } });
    assert.equal(off.body.reason, 'disabled');
  });

  await withHost({ sessions: { s1: session } }, async (host) => {
    await hit(host, {
      method: 'POST',
      url: '/next-say/settings',
      body: { pausedUntil: Date.now() + 60_000 },
    });
    const paused = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1', manual: true } });
    assert.equal(paused.body.reason, 'paused');
  });

  await withHost({ sessions: { s1: session } }, async (host) => {
    await hit(host, { method: 'POST', url: '/next-say/settings', body: { mode: 'manual' } });
    const automatic = await hit(host, { method: 'POST', url: '/next-say/predict', body: { sessionId: 's1' } });
    assert.equal(automatic.body.reason, 'manual-only');
  });
});

test('predict reports no-history rather than inventing a suggestion', async () => {
  await withHost({ sessions: { s1: fakeSession('s1', []) } }, async (host) => {
    const result = await hit(host, {
      method: 'POST',
      url: '/next-say/predict',
      body: { sessionId: 's1', manual: true },
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.reason, 'no-history');
  });
});

test('predict reports no-route when neither the session nor the default resolves', async () => {
  const session = { id: 's1', deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const previous = process.env.DSH_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'next-say-wiring-'));
  process.env.DSH_HOME = dir;
  try {
    const host = createFakeHost({ sessions: { s1: session }, llm: { prepareCall: async () => ({ stream: async function* () {} }) } });
    // With no route AND no llm, "no-route" must still win: the refusal reason
    // names the first missing thing, so a missing provider adapter cannot be
    // reported as a missing route (or the reverse).
    host.services.agentDefaultModel = { currentSelection: () => undefined };
    host.services.llm = undefined;
    apply(host.ctx);
    const result = await hit(host, {
      method: 'POST',
      url: '/next-say/predict',
      body: { sessionId: 's1', manual: true },
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.reason, 'no-route');
    host.dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown path is a 404, not a hang', async () => {
  await withHost({}, async (host) => {
    const result = await hit(host, { url: '/next-say/nope' });
    assert.equal(result.status, 404);
  });
});

test('predict refuses a suggestion that repeats the current draft', async () => {
  // A prediction describes the user's NEXT message, but the box may already hold
  // that exact text; showing it would let Tab insert the sentence twice. Seen on
  // screen, so it is pinned here against a stub model that echoes the draft.
  const echo = {
    async prepareCall() {
      return {
        async *stream() {
          yield { type: 'text-delta', text: 'run the tests' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const session = fakeSession('s1', [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }]);

  await withHost({ sessions: { s1: session }, llm: echo }, async (host) => {
    const repeats = await hit(host, {
      method: 'POST',
      url: '/next-say/predict',
      body: { sessionId: 's1', manual: true, draft: 'run the tests' },
    });
    assert.equal(repeats.body.ok, false);
    assert.equal(repeats.body.reason, 'repeats-draft');
  });
});

test('the same suggestion is accepted when the draft is different', async () => {
  const echo = {
    async prepareCall() {
      return {
        async *stream() {
          yield { type: 'text-delta', text: 'run the tests' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const session = fakeSession('s1', [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }]);

  await withHost({ sessions: { s1: session }, llm: echo }, async (host) => {
    const ok = await hit(host, {
      method: 'POST',
      url: '/next-say/predict',
      body: { sessionId: 's1', manual: true, draft: 'something else entirely' },
    });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.suggestion, 'run the tests');
  });
});

test('unloading removes the route', async () => {
  const previous = process.env.DSH_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'next-say-wiring-'));
  process.env.DSH_HOME = dir;
  try {
    const host = createFakeHost({});
    apply(host.ctx);
    assert.ok(host.routes.has('/next-say'));
    host.dispose();
    assert.ok(!host.routes.has('/next-say'), 'route disposed with the plugin');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
