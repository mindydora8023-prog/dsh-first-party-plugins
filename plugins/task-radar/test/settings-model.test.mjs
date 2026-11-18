import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeConfig } from '../lib/config.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(t) {
  let registration;
  let next = 0;
  const deadlines = new Map();
  const calls = [];
  let serve = async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({}) }) });
  const window = {
    __ModuleLoader__: { load(value) { registration = value; } },
    setTimeout(fn, ms) { const id = ++next; deadlines.set(id, { fn, ms }); return id; },
    clearTimeout(id) { deadlines.delete(id); },
  };
  const fetch = (url, options) => { calls.push({ url, options }); return serve(url, options); };
  // Exercise the form's state machine directly; no React/DOM renderer is used.
  new Function('window', 'fetch', source)(window, fetch);
  const module = registration.factory(() => ({}));
  const model = module.__internals.createSettingsModel();
  t.after(() => model.dispose());
  return { model, calls, deadlines, window,
    serve: (fn) => { serve = fn; },
    expire: () => { for (const { fn, ms } of [...deadlines.values()]) { assert.equal(ms, 10000); fn(); } },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('settings use the shell Fetch carrier for reads, saves and test actions', async (t) => {
  const h = harness(t);
  const carried = [];
  h.window.__DSH_TRANSPORT__ = {
    async fetch(url, options) {
      assert.equal(this, h.window.__DSH_TRANSPORT__);
      carried.push(url);
      assert.ok(options.signal);
      return { ok: true, json: async () => url.endsWith('/test') ? { ok: true, submitted: true }
        : { ok: true, config: normalizeConfig(options.body ? JSON.parse(options.body).config : {}) } };
    },
  };
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Shell saved'; });
  await h.model.save();
  await h.model.test();
  assert.deepEqual(carried, ['/api/task-radar/radar', '/api/task-radar/config', '/api/task-radar/test']);
  assert.equal(h.model.getState().config.titlePrefix, 'Shell saved');
  assert.equal(h.calls.length, 0);
  delete h.window.__DSH_TRANSPORT__;
  await h.model.load();
  assert.equal(h.calls.length, 1);
});

test('a shell carrier failure is reported without a second request through browser HTTP', async (t) => {
  const h = harness(t);
  h.window.__DSH_TRANSPORT__ = { fetch() { throw new Error('carrier unavailable'); } };
  await h.model.load();
  assert.equal(h.model.getState().config, null);
  assert.equal(h.model.getState().loading, false);
  assert.equal(h.calls.length, 0);
});

test('initial loading is distinct from failure, and a failed load can be retried', async (t) => {
  const h = harness(t);
  assert.equal(h.model.getState().loading, true);
  h.serve(async () => ({ ok: false, status: 503, json: async () => ({ ok: false, reason: 'plugin-unloaded' }) }));
  await h.model.load();
  assert.equal(h.model.getState().loading, false);
  assert.equal(h.model.getState().config, null);
  assert.equal(h.model.getState().reason, 'plugin-unloaded');
  h.serve(async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'Recovered' }) }) }));
  await h.model.load();
  assert.equal(h.model.getState().config.titlePrefix, 'Recovered');
  assert.equal(h.model.getState().reason, '');
  assert.equal(h.deadlines.size, 0);
});

test('save completion preserves newer edits and duplicate actions do not issue requests', async (t) => {
  const h = harness(t);
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Submitted'; });
  const pending = deferred();
  h.serve(() => pending.promise);
  const saving = h.model.save();
  await h.model.save();
  await h.model.test();
  assert.equal(h.calls.length, 2, 'one initial load and one POST');
  assert.equal(JSON.parse(h.calls[1].options.body).config.titlePrefix, 'Submitted');
  h.model.set((config) => { config.titlePrefix = 'Newer draft'; });
  h.model.refreshPermission();
  pending.resolve({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'Submitted' }) }) });
  await saving;
  assert.equal(h.model.getState().config.titlePrefix, 'Newer draft');
  assert.equal(h.model.getState().dirty, true);
  assert.equal(h.model.getState().status, 'btn.savedEarlier');
  assert.equal(h.model.getState().busy, '');
});

test('an unchanged submitted draft adopts host normalization and clears the dirty marker', async (t) => {
  const h = harness(t);
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = '  Normalized  '; config.summaryMaxChars = ''; config.cooldownMs = ''; });
  assert.equal(h.model.getState().config.summaryMaxChars, '', 'editing can temporarily clear a numeric field');
  assert.equal(h.model.getState().config.cooldownMs, '');
  h.serve(async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'Normalized' }) }) }));
  await h.model.save();
  assert.equal(h.model.getState().config.titlePrefix, 'Normalized');
  assert.equal(h.model.getState().dirty, false);
  assert.equal(h.model.getState().status, 'btn.saved');
});

test('explicit host rejection preserves the draft and reports save failure', async (t) => {
  const h = harness(t);
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Keep this draft'; });
  h.serve(async () => ({ ok: false, status: 413, json: async () => ({ ok: false, reason: 'body-too-large' }) }));
  await h.model.save();
  assert.equal(h.model.getState().dirty, true);
  assert.equal(h.model.getState().config.titlePrefix, 'Keep this draft');
  assert.equal(h.model.getState().status, 'save.error');
  assert.equal(h.model.getState().reason, 'body-too-large');
  h.serve(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, reason: 'internal' }) }));
  await h.model.save();
  assert.equal(h.model.getState().status, 'save.unknown', 'a server failure does not prove a mutating operation had no effect');
  assert.equal(h.model.getState().dirty, true);
});

for (const phase of ['fetch', 'json']) {
  test('a hanging ' + phase + ' releases loading after the deadline and can recover', async (t) => {
    const h = harness(t);
    const pending = deferred();
    h.serve(() => phase === 'fetch' ? pending.promise : { ok: true, json: () => pending.promise });
    const loading = h.model.load();
    await flush();
    h.expire();
    await loading;
    assert.equal(h.model.getState().loading, false);
    assert.equal(h.calls[0].options.signal.aborted, true);
    h.serve(async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'After timeout' }) }) }));
    await h.model.load();
    pending.resolve(phase === 'fetch' ? { ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'Late' }) }) }
      : { ok: true, config: normalizeConfig({ titlePrefix: 'Late' }) });
    await flush();
    assert.equal(h.model.getState().config.titlePrefix, 'After timeout');
  });
}

test('mutating request timeout is reported as uncertain and is not automatically retried', async (t) => {
  const h = harness(t);
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Pending save'; });
  h.serve(() => new Promise(() => {}));
  const saving = h.model.save();
  h.expire();
  await saving;
  assert.equal(h.model.getState().status, 'save.unknown');
  assert.equal(h.model.getState().dirty, true);
  assert.equal(h.model.getState().busy, '');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.at(-1).options.signal.aborted, true);
});

test('test action uses saved host settings and distinguishes submission from display', async (t) => {
  const h = harness(t);
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Unsaved'; });
  for (const submitted of [false, true]) {
    h.serve(async () => ({ ok: true, json: async () => ({ ok: true, submitted }) }));
    await h.model.test();
    assert.equal(h.calls.at(-1).url, '/api/task-radar/test');
    assert.equal(h.calls.at(-1).options.body, undefined);
    assert.equal(h.model.getState().status, submitted ? 'test.sent' : 'test.noToast');
    assert.equal(h.model.getState().dirty, true);
  }
});

test('disposing the form aborts pending requests and prevents late state publication', async (t) => {
  const h = harness(t);
  await h.model.load();
  const updates = [];
  h.model.subscribe((state) => updates.push(state));
  h.model.set((config) => { config.titlePrefix = 'Draft'; });
  const pending = deferred();
  h.serve(() => pending.promise);
  const saving = h.model.save();
  const count = updates.length;
  const state = h.model.getState();
  h.model.dispose();
  await saving;
  assert.equal(h.calls.at(-1).options.signal.aborted, true);
  pending.resolve({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({ titlePrefix: 'Late response' }) }) });
  await flush();
  assert.equal(updates.length, count);
  assert.equal(h.model.getState(), state);
  assert.equal(h.deadlines.size, 0);
});

test('malformed successful API payloads are rejected before rendering or claiming a save', async (t) => {
  const h = harness(t);
  h.serve(async () => ({ ok: true, json: async () => ({ ok: true, config: null }) }));
  await h.model.load();
  assert.equal(h.model.getState().config, null);
  assert.equal(h.model.getState().reason, 'invalid-response');
  h.serve(async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({}) }) }));
  await h.model.load();
  h.model.set((config) => { config.titlePrefix = 'Draft'; });
  h.serve(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await h.model.save();
  assert.equal(h.model.getState().status, 'save.unknown');
  assert.equal(h.model.getState().dirty, true);
});
