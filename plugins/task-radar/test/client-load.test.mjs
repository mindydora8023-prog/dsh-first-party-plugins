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
  const listeners = new Map();
  const disposers = [];
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
    setTimeout: () => 0,
  };
  const document = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    body: null,
  };
  const React = { createElement: () => null, useState: () => [null, () => {}], useEffect() {} };
  const fakeFetch = async () => ({ ok: currentPayload.ok === true, json: async () => currentPayload });
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
  return { mod, apply, notes, opened, timers, listeners, FakeNotification, dispose,
    focusCount: () => focused, grantCount: () => grants,
    setPayload: (value) => { currentPayload = value; },
    gesture: (name) => { for (const fn of [...(listeners.get(name) || [])]) fn(); } };
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

test('permission is requested on a user gesture and listeners are removed on disposal', (t) => {
  const h = harness(t, { permission: 'default' });
  h.apply();
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
