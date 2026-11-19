import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

function harness(t, { permission = 'granted', payload = { ok: false } } = {}) {
  let captured;
  let focused = 0;
  let grants = 0;
  let currentPayload = payload;
  const notes = [];
  const opened = [];
  const timers = new Map();
  const deadlines = new Map();
  const requests = [];
  let nextTimer = 0;
  let fetchOverride = null;
  const listeners = new Map();
  const disposers = [];
  let visibilityState = 'visible';
  class FakeNotification {
    static permission = permission;
    static requestPermission() { grants += 1; this.permission = 'granted'; return Promise.resolve('granted'); }
    constructor(title, options) { this.title = title; this.options = options; this.closed = false; notes.push(this); }
    close() { this.closed = true; }
  }
  const window = {
    __ModuleLoader__: { load: (opts) => { captured = opts; } },
    setInterval: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    focus: () => { focused += 1; },
    setTimeout: (fn, ms) => { const id = ++nextTimer; deadlines.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => deadlines.delete(id),
  };
  const document = {
    get visibilityState() { return visibilityState; },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    body: null,
  };
  const React = { createElement: () => null, useState: () => [null, () => {}], useEffect() {} };
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    return fetchOverride ? fetchOverride(url, options) : { ok: currentPayload.ok === true, json: async () => currentPayload };
  };
  new Function('window', 'document', 'React', 'fetch', 'Notification', source)(window, document, React, fakeFetch, FakeNotification);
  assert.ok(captured);
  const mod = captured.factory((name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name); });
  function apply(withWorkspace = true) {
    const ctx = {
      locale: { register() {}, bind: () => (k) => k },
      slots: { inject() {}, register() {} },
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
      get: () => undefined,
    };
    if (withWorkspace) ctx.uiWorkspace = { openSession: (id) => opened.push(id) };
    mod.apply(ctx);
  }
  function dispose() { for (const fn of disposers.splice(0).reverse()) fn(); }
  t.after(dispose);
  return { mod, apply, notes, opened, timers, deadlines, requests, listeners, FakeNotification, dispose,
    setFetch: (fn) => { fetchOverride = fn; },
    expire: () => { for (const { fn } of [...deadlines.values()]) fn(); },
    focusCount: () => focused, grantCount: () => grants,
    setPayload: (value) => { currentPayload = value; },
    gesture: (name) => { for (const fn of [...(listeners.get(name) || [])]) fn(); },
    hide: () => { visibilityState = 'hidden'; },
    show: () => { visibilityState = 'visible'; } };
}

test('client declares workspace and locale services', (t) => {
  const h = harness(t);
  assert.equal(h.mod.name, 'task-radar');
  for (const name of ['uiWorkspace', 'slots', 'locale']) assert.ok(h.mod.inject.includes(name));
});

test('notification click focuses the window, opens its session and closes itself', (t) => {
  const h = harness(t);
  h.apply();
  h.mod.__internals.showSystemNotification('finished', 'Done', 'Body', 'Location', 'session-123');
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].options.body, 'Body\nLocation');
  assert.match(h.notes[0].options.tag, /finished-session-123$/, 'tag must be scoped per session so one session cannot swallow another');
  h.notes[0].onclick();
  assert.deepEqual(h.opened, ['session-123']);
  assert.equal(h.focusCount(), 1);
  assert.equal(h.notes[0].closed, true);
  h.mod.__internals.openSessionById('');
  h.mod.__internals.openSessionById(undefined);
  assert.equal(h.opened.length, 1);
});

test('missing workspace and denied notification permissions are no-ops', (t) => {
  const h = harness(t, { permission: 'denied' });
  h.apply(false);
  assert.doesNotThrow(() => h.mod.__internals.openSessionById('x'));
  h.mod.__internals.showSystemNotification('finished', 'Done', 'Body', '', 'x');
  assert.equal(h.notes.length, 0);
  h.gesture('pointerdown');
  assert.equal(h.grantCount(), 0);
});

test('permission is requested on a user gesture and listeners are removed on disposal', async (t) => {
  const h = harness(t, { permission: 'default', payload: { ok: true, config: { enabled: true, system: { enabled: true } }, journal: [] } });
  h.apply();
  h.gesture('pointerdown');
  assert.equal(h.grantCount(), 0, 'do not request permission before saved settings arrive');
  await flush();
  assert.equal(h.grantCount(), 0);
  assert.equal(h.listeners.get('pointerdown').size, 1);
  h.gesture('pointerdown');
  assert.equal(h.grantCount(), 1);
  h.gesture('keydown');
  assert.equal(h.grantCount(), 1);
  h.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.get('pointerdown').size, 0);
  assert.equal(h.listeners.get('keydown').size, 0);
});

test('globally disabled reminders never request permission from incidental gestures', async (t) => {
  const h = harness(t, { permission: 'default', payload: { ok: true, config: { enabled: false, system: { enabled: true } }, journal: [] } });
  h.apply();
  await flush();
  h.gesture('pointerdown');
  h.gesture('keydown');
  assert.equal(h.grantCount(), 0);
});

test('permission API promise rejection resolves without an unhandled rejection', async (t) => {
  const h = harness(t, { permission: 'default' });
  h.FakeNotification.requestPermission = () => Promise.reject(new Error('fixture permission failure'));
  assert.equal(await h.mod.__internals.requestSystemPermission(), 'denied');
});

test('the first poll seeds the watermark without replaying old journal entries', async (t) => {
  const entry = (at, kind = 'finished') => ({ at, kind, title: 'Done', body: 'Body', session: 's1' });
  const h = harness(t, { payload: { ok: true, config: { enabled: true, system: { enabled: true } }, journal: [entry(1), entry(2)] } });
  // A page opened after the fact must NOT re-toast the events already in the
  // host journal; the first poll only records where the watermark is.
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 0, 'a fresh page must not replay pre-existing journal entries');
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 0);
  // A genuinely new entry after the watermark is shown exactly once.
  h.setPayload({ ok: true, config: { enabled: true, system: { enabled: true } }, journal: [entry(1), entry(2), entry(3)] });
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 1);
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 1, 'repeated polls never redisplay consumed journal entries');
  for (const config of [
    { enabled: false, system: { enabled: true } },
    { enabled: true, system: { enabled: false } },
    { enabled: true, system: { enabled: true }, events: { finished: false } },
  ]) {
    const at = h.mod.__internals.watcher.lastAt + 1;
    h.setPayload({ ok: true, config, journal: [entry(1), entry(2), entry(3), entry(at)] });
    await h.mod.__internals.tick();
    assert.equal(h.notes.length, 1);
    assert.equal(h.mod.__internals.watcher.lastAt, at);
  }
  h.setPayload({ ok: true, config: { enabled: true, system: { enabled: true } }, journal: [entry(h.mod.__internals.watcher.lastAt + 1)] });
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 2);
});

test('a hidden page keeps polling and disposal clears its timer', (t) => {
  const h = harness(t);
  h.apply();
  assert.equal(h.timers.size, 1, 'a visible page polls');
  assert.equal(h.listeners.get('visibilitychange').size, 1);
  h.hide();
  h.gesture('visibilitychange');
  assert.equal(h.timers.size, 1, 'a hidden page must still deliver browser notifications');
  h.show();
  h.gesture('visibilitychange');
  assert.equal(h.timers.size, 1, 'becoming visible arms the timer again');
  h.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.get('visibilitychange').size, 0);
});

const config = { enabled: true, toast: { enabled: false }, system: { enabled: true } };
const entry = (sequence, at = 10) => ({ sequence, at, kind: 'finished', title: 'Event ' + sequence, body: '', session: 's' + sequence });
const payload = (journal, journalId = 'generation-a') => ({ ok: true, config, journal, journalId });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('sequenced journal delivers same-millisecond events within and across polls exactly once', async (t) => {
  const h = harness(t, { payload: payload([]) });
  await h.mod.__internals.tick();
  h.setPayload(payload([entry(1), entry(2)]));
  await h.mod.__internals.tick();
  h.setPayload(payload([entry(1), entry(2), entry(3)]));
  await h.mod.__internals.tick();
  await h.mod.__internals.tick();
  assert.deepEqual(h.notes.map((note) => note.title), ['Event 1', 'Event 2', 'Event 3']);
  assert.equal(h.deadlines.size, 0);
});

test('journal generation changes recover after restart and wall clock rollback', async (t) => {
  const h = harness(t, { payload: payload([entry(100, 1000)]) });
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 0);
  h.setPayload(payload([entry(1, 1)], 'generation-b'));
  await h.mod.__internals.tick();
  await h.mod.__internals.tick();
  h.setPayload(payload([entry(1, 1), entry(2, 0)], 'generation-b'));
  await h.mod.__internals.tick();
  assert.deepEqual(h.notes.map((note) => note.title), ['Event 1', 'Event 2']);
});

test('disabled sequenced entries are consumed and do not replay after re-enabling', async (t) => {
  const h = harness(t, { payload: payload([]) });
  await h.mod.__internals.tick();
  h.setPayload({ ...payload([entry(1)]), config: { ...config, enabled: false } });
  await h.mod.__internals.tick();
  h.setPayload(payload([entry(1), entry(2)]));
  await h.mod.__internals.tick();
  assert.deepEqual(h.notes.map((note) => note.title), ['Event 2']);
});

test('legacy hosts also deliver distinct same-millisecond entries across polls', async (t) => {
  const h = harness(t, { payload: { ok: true, config, journal: [] } });
  await h.mod.__internals.tick();
  h.setPayload({ ok: true, config, journal: [entry(1), entry(2)] });
  await h.mod.__internals.tick();
  h.setPayload({ ok: true, config, journal: [entry(1), entry(2), entry(3)] });
  await h.mod.__internals.tick();
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 3);
});

test('browser-only notifications arrive while the page is hidden', async (t) => {
  const h = harness(t, { payload: payload([]) });
  h.hide();
  h.apply();
  await flush();
  h.setPayload(payload([entry(1)]));
  for (const fn of h.timers.values()) fn();
  await flush();
  assert.equal(h.notes.length, 1);
  h.dispose();
  assert.equal(h.deadlines.size, 0);
});

for (const phase of ['fetch', 'json']) {
  test('deadline releases the poll lock when ' + phase + ' stalls, even if abort is ignored', async (t) => {
    const h = harness(t, { payload: payload([]) });
    await h.mod.__internals.tick();
    const stalled = deferred();
    h.setFetch(() => phase === 'fetch' ? stalled.promise : { ok: true, json: () => stalled.promise });
    const pending = h.mod.__internals.tick();
    await flush();
    const signal = h.requests.at(-1).options.signal;
    assert.equal(h.deadlines.size, 1);
    assert.equal([...h.deadlines.values()][0].ms, 10000);
    h.expire();
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(h.mod.__internals.watcher.inFlight, false);
    h.setFetch(null);
    h.setPayload(payload([entry(1)]));
    await h.mod.__internals.tick();
    assert.equal(h.notes.length, 1);
    stalled.resolve(phase === 'fetch' ? { ok: true, json: async () => payload([entry(2)]) } : payload([entry(2)]));
    await flush();
    assert.equal(h.notes.length, 1, 'late timed-out response cannot notify');
  });
}

test('disposal aborts in-flight polls and old responses cannot affect a reapplied client', async (t) => {
  const h = harness(t, { payload: payload([]) });
  h.apply();
  await flush();
  const stalled = deferred();
  h.setFetch(() => stalled.promise);
  const pending = h.mod.__internals.tick();
  await flush();
  const signal = h.requests.at(-1).options.signal;
  h.dispose();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(h.deadlines.size, 0);
  assert.equal(h.mod.__internals.watcher.inFlight, false);
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 0);
  h.setFetch(null);
  h.apply();
  await flush();
  stalled.resolve({ ok: true, json: async () => payload([entry(100)]) });
  await flush();
  assert.equal(h.notes.length, 0);
  assert.equal(h.mod.__internals.watcher.lastSequence, 0);
  h.setPayload(payload([entry(1)]));
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 1);
});

test('an in-page card opens its session and then disappears', async (t) => {
  const h = harness(t, { payload: payload([]) });
  h.apply();
  await h.mod.__internals.tick();
  h.mod.__internals.watcher.cfg = { toast: { durationMs: 8000 }, page: { enabled: true } };
  h.mod.__internals.pushNotice({ kind: 'finished', title: 'Done', body: 'Body', location: 'Here', session: 'session-9' });
  assert.equal(h.mod.__internals.notices.length, 1);
  h.mod.__internals.activateNotice(h.mod.__internals.notices[0].id);
  assert.deepEqual(h.opened, ['session-9']);
  assert.equal(h.mod.__internals.notices.length, 0);
});
