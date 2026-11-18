import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const config = { enabled: true, events: {}, system: { enabled: true } };
const entry = (sequence) => ({ at: 10, sequence, kind: 'finished', title: 'Private title ' + sequence, body: 'Private body', session: 's1' });
const payload = (journal = [], journalId = 'generation-a') => ({ ok: true, journalId, journal, config });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function environment() {
  const values = new Map();
  const env = { busy: false, delayed: false, readError: false, writeError: false, rejectLock: false, waiting: [], values };
  env.storage = {
    getItem(key) { if (env.readError) throw new Error('storage read disabled'); return values.get(key) ?? null; },
    setItem(key, value) { if (env.writeError) throw new Error('storage write disabled'); values.set(key, value); },
  };
  env.locks = {
    request(_name, options, callback) {
      assert.equal(options.ifAvailable, true, 'never hold a background leader lock');
      if (env.rejectLock) return Promise.reject(new Error('Web Locks disabled'));
      if (env.delayed) return new Promise((resolve, reject) => env.waiting.push(() => {
        try { resolve(callback({ name: 'fixture' })); } catch (error) { reject(error); }
      }));
      return Promise.resolve().then(() => {
        if (env.busy) return callback(null);
        env.busy = true;
        try { return callback({ name: 'fixture' }); } finally { env.busy = false; }
      });
    },
  };
  return env;
}

function tab(t, env, { locks = true, storage = true } = {}) {
  let registration;
  let data = payload();
  let throwNotification = false;
  const notes = [];
  const deadlines = new Map();
  const disposers = [];
  let next = 0;
  const window = {
    __ModuleLoader__: { load(value) { registration = value; } },
    navigator: locks ? { locks: env.locks } : {},
    localStorage: storage ? env.storage : undefined,
    setTimeout(fn) { const id = ++next; deadlines.set(id, fn); return id; },
    clearTimeout(id) { deadlines.delete(id); },
    setInterval() { return 1000; }, clearInterval() {}, focus() {},
  };
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  class Notification {
    static permission = 'granted';
    constructor(title, options) {
      if (throwNotification) throw new Error('notification engine failed');
      this.title = title;
      this.options = options;
      notes.push(this);
    }
  }
  const fetch = async () => ({ ok: true, json: async () => data });
  new Function('window', 'document', 'fetch', 'Notification', source)(window, document, fetch, Notification);
  const module = registration.factory(() => ({}));
  function dispose() { for (const fn of disposers.splice(0).reverse()) fn(); }
  t.after(dispose);
  return { notes, deadlines, watcher: module.__internals.watcher, tick: module.__internals.tick, dispose,
    set: (journal, id) => { data = payload(journal, id); },
    failNotifications: (value) => { throwNotification = value; },
    expire() { for (const fn of [...deadlines.values()]) fn(); },
    apply() { module.apply({
      effect(fn) { const stop = fn(); if (typeof stop === 'function') disposers.push(stop); },
    }); },
  };
}

test('two independently seeded tabs display a new event once across the shared origin', async (t) => {
  const env = environment();
  const a = tab(t, env);
  const b = tab(t, env);
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(env.values.size, 0, 'initial seeding does not publish receipts');
  a.set([entry(1), entry(2)]);
  b.set([entry(1), entry(2)]);
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(a.notes.length + b.notes.length, 2);
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(a.notes.length + b.notes.length, 2);
});

test('a newly opened tab never consumes an event on behalf of an older tab', async (t) => {
  const env = environment();
  const older = tab(t, env);
  await older.tick();
  const newer = tab(t, env);
  newer.set([entry(1)]);
  await newer.tick();
  assert.equal(env.values.size, 0);
  older.set([entry(1)]);
  await older.tick();
  assert.equal(older.notes.length, 1);
  assert.equal(newer.notes.length, 0);
});

test('a higher sequence delivered by another tab does not suppress an earlier unseen sequence', async (t) => {
  const env = environment();
  const a = tab(t, env);
  await a.tick();
  const b = tab(t, env);
  b.set([entry(1)]);
  await b.tick();
  b.set([entry(1), entry(2)]);
  await b.tick();
  a.set([entry(1)]);
  await a.tick();
  assert.deepEqual([...a.notes, ...b.notes].map((note) => note.title).sort(), ['Private title 1', 'Private title 2']);
});

test('lock contention leaves the local cursor available for a later poll', async (t) => {
  const env = environment();
  const a = tab(t, env);
  await a.tick();
  a.set([entry(1)]);
  env.busy = true;
  await a.tick();
  assert.equal(a.notes.length, 0);
  assert.equal(a.watcher.lastSequence, 0);
  env.busy = false;
  await a.tick();
  assert.equal(a.notes.length, 1);
  assert.equal(a.watcher.lastSequence, 1);
});

test('missing APIs, rejected locks and broken storage retain single-tab delivery', async (t) => {
  for (const mode of ['no-locks', 'no-storage', 'read-error', 'write-error', 'lock-error', 'corrupt']) {
    const env = environment();
    const a = tab(t, env, { locks: mode !== 'no-locks', storage: mode !== 'no-storage' });
    await a.tick();
    if (mode === 'read-error') env.readError = true;
    if (mode === 'write-error') env.writeError = true;
    if (mode === 'lock-error') env.rejectLock = true;
    if (mode === 'corrupt') env.storage.getItem = () => '{not-json';
    a.set([entry(1)]);
    await a.tick();
    await a.tick();
    assert.equal(a.notes.length, 1, mode + ': do not send twice when receipt writing fails');
    assert.equal(a.watcher.lastSequence, 1);
  }
});

test('notification constructor failure records no receipt and is retried on a later poll', async (t) => {
  const env = environment();
  const a = tab(t, env);
  await a.tick();
  a.set([entry(1)]);
  a.failNotifications(true);
  await a.tick();
  assert.equal(a.watcher.lastSequence, 0);
  assert.equal(env.values.size, 0);
  a.failNotifications(false);
  await a.tick();
  assert.equal(a.notes.length, 1);
  assert.equal(a.watcher.lastSequence, 1);
});

test('legacy hosts retain same-timestamp entries when notification construction initially fails', async (t) => {
  const env = environment();
  const a = tab(t, env);
  a.set([], null);
  await a.tick();
  a.set([entry(1), entry(2)], null);
  a.failNotifications(true);
  await a.tick();
  assert.equal(a.notes.length, 0);
  a.failNotifications(false);
  await a.tick();
  await a.tick();
  assert.equal(a.notes.length, 2);
  assert.equal(env.values.size, 0, 'legacy timestamp identities remain local to each page');
});

test('lock callbacks delayed past the poll deadline cannot deliver or write receipts', async (t) => {
  const env = environment();
  const a = tab(t, env);
  await a.tick();
  a.set([entry(1)]);
  env.delayed = true;
  const pending = a.tick();
  await flush();
  assert.equal(env.waiting.length, 1);
  a.expire();
  await pending;
  assert.equal(a.watcher.inFlight, false);
  for (const complete of env.waiting.splice(0)) complete();
  await flush();
  assert.equal(a.notes.length, 0);
  assert.equal(env.values.size, 0);
  env.delayed = false;
  await a.tick();
  assert.equal(a.notes.length, 1);
});

test('a disposed client cannot deliver from an old lock callback after reapplying', async (t) => {
  const env = environment();
  const a = tab(t, env);
  a.apply();
  await flush();
  a.set([entry(1)]);
  env.delayed = true;
  const pending = a.tick();
  await flush();
  a.dispose();
  await pending;
  a.set([]);
  a.apply();
  await flush();
  for (const complete of env.waiting.splice(0)) complete();
  await flush();
  assert.equal(a.notes.length, 0);
  assert.equal(env.values.size, 0);
  assert.equal(a.watcher.lastSequence, 0);
});

test('journal generations have separate receipts for identical sequence numbers', async (t) => {
  const env = environment();
  const a = tab(t, env);
  const b = tab(t, env);
  await Promise.all([a.tick(), b.tick()]);
  for (const id of ['generation-a', 'generation-b']) {
    a.set([entry(1)], id);
    b.set([entry(1)], id);
    await Promise.all([a.tick(), b.tick()]);
  }
  assert.equal(a.notes.length + b.notes.length, 2);
});

test('shared receipts have finite history and contain no notification text', async (t) => {
  const env = environment();
  const a = tab(t, env);
  await a.tick();
  for (let batch = 0; batch < 22; batch += 1) {
    a.set(Array.from({ length: 24 }, (_, i) => entry(batch * 24 + i + 1)));
    await a.tick();
  }
  let stored = [...env.values.values()][0];
  assert.equal(JSON.parse(stored)[0].sequences.length, 512);
  for (let i = 0; i < 5; i += 1) {
    a.set([entry(1)], 'generation-' + i);
    await a.tick();
  }
  stored = [...env.values.values()][0];
  assert.equal(JSON.parse(stored).length, 4);
  assert.equal(stored.includes('Private'), false);
  assert.equal(stored.includes('s1'), false);
  assert.ok(stored.length < 65536);
});
