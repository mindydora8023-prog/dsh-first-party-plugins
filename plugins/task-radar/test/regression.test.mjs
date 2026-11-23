/**
 * Regression tests for P0 host and client fixes in dsh-plugin-task-radar.
 *
 * Pure ASCII + LF only.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import {
  createHandler,
  createToastSender,
  createWebhookSender,
} from '../lib/index.js';

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; if (headers) this.headers = headers; },
    end(chunk) { this.body += chunk || ''; },
  };
}

function clientHarness(t, { localeDict, locks, storage } = {}) {
  let captured;
  let nextTimer = 0;
  const deadlines = new Map();
  const requests = [];
  const notes = [];
  let failNotify = false;
  let serve = async () => ({ ok: true, json: async () => ({ ok: true, config: normalizeConfig({}), journal: [], journalId: 'gen-1', configVersion: 1 }) });

  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) {
      if (failNotify) throw new Error('notification blocked');
      this.title = title;
      this.options = options;
      notes.push(this);
    }
    close() {}
  }

  const window = {
    __ModuleLoader__: { load(opts) { captured = opts; } },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const id = ++nextTimer; deadlines.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => deadlines.delete(id),
    focus: () => {},
    navigator: locks ? { locks } : {},
    localStorage: storage,
  };
  const document = {
    visibilityState: 'hidden',
    title: 'DSH',
    addEventListener() {},
    removeEventListener() {},
  };

  let cursor = 0;
  const hookSlots = [];
  const refSlots = [];
  let refCursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    cloneElement: (el, extra) => ({ ...el, props: { ...el.props, ...extra } }),
    useState: (initial) => {
      const i = cursor++;
      if (!(i in hookSlots)) hookSlots[i] = typeof initial === 'function' ? initial() : initial;
      return [hookSlots[i], (next) => { hookSlots[i] = typeof next === 'function' ? next(hookSlots[i]) : next; }];
    },
    useRef: (initial) => {
      const i = refCursor++;
      if (!(i in refSlots)) refSlots[i] = { current: initial };
      return refSlots[i];
    },
    useEffect: () => {},
  };

  const fetch = (url, options) => {
    requests.push({ url, options });
    return serve(url, options);
  };

  new Function('window', 'document', 'React', 'fetch', 'Notification', clientSource)(
    window, document, React, fetch, FakeNotification,
  );
  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });

  const disposers = [];
  function apply() {
    const dict = localeDict || mod.__internals.en;
    mod.apply({
      locale: { register() {}, bind: () => (key) => dict[key] ?? key },
      slots: { inject() {}, register() {} },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
      get: () => undefined,
    });
  }
  t.after(() => { for (const d of disposers.splice(0).reverse()) d(); });

  return {
    mod,
    document,
    requests,
    notes,
    resetHooks() { cursor = 0; refCursor = 0; },
    setServe(fn) { serve = fn; },
    setFailNotify(v) { failNotify = v; },
    apply,
  };
}

test('radar returns full journal when journalId differs (host restart) or configVersion changes', async () => {
  let cfg = normalizeConfig({});
  let cfgVersion = 1;
  const journal = [{ kind: 'finished', at: 100, sequence: 1, title: 'After restart', body: 'ok', session: 's1' }];
  const handler = createHandler(
    () => cfg,
    (next) => { cfg = normalizeConfig(next); cfgVersion += 1; },
    journal,
    '/fixture/config.json',
    () => false,
    'gen-new',
    undefined,
    () => false,
    () => cfgVersion,
  );

  // Even though client's since=50 > newest=1, mismatched journalId MUST return full journal!
  const restartRes = fakeRes();
  await handler({ method: 'GET', url: '/api/task-radar/radar?since=50&journalId=gen-old' }, restartRes);
  const restartPayload = JSON.parse(restartRes.body);
  assert.equal(restartPayload.unchanged, undefined);
  assert.equal(restartPayload.journalId, 'gen-new');
  assert.equal(restartPayload.configVersion, 1);
  assert.equal(restartPayload.journal.length, 1);
  assert.equal(restartPayload.journal[0].title, 'After restart');

  // Matching journalId + configVersion + since >= newest returns unchanged.
  const sameRes = fakeRes();
  await handler({ method: 'GET', url: '/api/task-radar/radar?since=1&journalId=gen-new&configVersion=1' }, sameRes);
  assert.equal(JSON.parse(sameRes.body).unchanged, true);

  // Saving config increments configVersion, busting unchanged for stale configVersion.
  const saveReq = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({ config: { titlePrefix: 'New' } }))]),
    { method: 'POST', url: '/api/task-radar/config' },
  );
  const saveRes = fakeRes();
  await handler(saveReq, saveRes);
  assert.equal(saveRes.status, 200);
  assert.equal(JSON.parse(saveRes.body).configVersion, 2);

  const afterSave = fakeRes();
  await handler({ method: 'GET', url: '/api/task-radar/radar?since=1&journalId=gen-new&configVersion=1' }, afterSave);
  const afterPayload = JSON.parse(afterSave.body);
  assert.equal(afterPayload.unchanged, undefined);
  assert.equal(afterPayload.configVersion, 2);
  assert.equal(afterPayload.config.titlePrefix, 'New');
});

test('poller sends journalId on ?since= and keeps seeded=true across restart unchanged responses', async (t) => {
  const h = clientHarness(t);
  const cfg = normalizeConfig({ system: { enabled: true }, page: { enabled: false } });

  // Initial seed poll on gen-1 with sequence 10.
  h.setServe(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      journalId: 'gen-1',
      configVersion: 1,
      config: cfg,
      journal: [{ sequence: 10, at: 100, kind: 'finished', title: 'Old', body: '', session: 's0' }],
    }),
  }));
  await h.mod.__internals.tick();
  assert.equal(h.notes.length, 0);

  // Simulate host restart returning unchanged:true with gen-2 first (e.g. legacy host).
  h.setServe(async () => ({
    ok: true,
    json: async () => ({ ok: true, journalId: 'gen-2', configVersion: 1, active: false, sequence: 0, unchanged: true }),
  }));
  await h.mod.__internals.tick();
  assert.match(h.requests.at(-1).url, /since=10/);
  assert.match(h.requests.at(-1).url, /journalId=gen-1/);
  // Must stay seeded so the very first post-restart event is NOT swallowed!
  assert.equal(h.mod.__internals.watcher.seeded, true);

  h.setServe(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      journalId: 'gen-2',
      configVersion: 1,
      config: cfg,
      journal: [{ sequence: 1, at: 200, kind: 'finished', title: 'Post-restart', body: '', session: 's1' }],
    }),
  }));
  await h.mod.__internals.tick();
  assert.deepEqual(h.notes.map((n) => n.title), ['Post-restart']);
});

test('settings save immediately propagates updated config to watcher.cfg and watcher.system', async (t) => {
  const h = clientHarness(t);
  const model = h.mod.__internals.createSettingsModel();
  t.after(() => model.dispose());

  h.setServe(async (url, opts) => {
    if (url.endsWith('/radar')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          configVersion: 1,
          config: normalizeConfig({ system: { enabled: false }, titlePrefix: 'Before' }),
        }),
      };
    }
    const next = normalizeConfig(JSON.parse(opts.body).config);
    return { ok: true, json: async () => ({ ok: true, configVersion: 2, config: next }) };
  });

  await model.load();
  assert.equal(h.mod.__internals.watcher.system, false);

  model.set((c) => { c.system.enabled = true; c.titlePrefix = 'After'; });
  await model.save();
  assert.equal(h.mod.__internals.watcher.system, true);
  assert.equal(h.mod.__internals.watcher.cfg.titlePrefix, 'After');
  assert.equal(h.mod.__internals.watcher.configVersion, 2);
});

test('in-page cards still appear when system notification fails and do not duplicate on retry', async (t) => {
  const h = clientHarness(t);
  const cfg = normalizeConfig({ system: { enabled: true }, page: { enabled: true } });

  h.setServe(async () => ({
    ok: true,
    json: async () => ({ ok: true, journalId: 'gen-1', config: cfg, journal: [] }),
  }));
  await h.mod.__internals.tick();

  // Notification constructor throws on poll 1; page card MUST still appear!
  h.setFailNotify(true);
  h.setServe(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      journalId: 'gen-1',
      config: cfg,
      journal: [{ sequence: 1, at: 100, kind: 'finished', title: 'Task Done', body: 'ok', session: 's1' }],
    }),
  }));
  await h.mod.__internals.tick();
  assert.equal(h.mod.__internals.notices.length, 1);
  assert.equal(h.notes.length, 0);
  assert.equal(h.mod.__internals.watcher.lastSequence, 0);

  // Poll 2 recovers system notification; page card must NOT be duplicated!
  h.setFailNotify(false);
  await h.mod.__internals.tick();
  assert.equal(h.mod.__internals.notices.length, 1);
  assert.equal(h.notes.length, 1);
  assert.equal(h.mod.__internals.watcher.lastSequence, 1);
});

test('noteHidden and NoticeStack use active English locale instead of hardcoded Chinese', (t) => {
  const h = clientHarness(t);
  h.apply();
  h.mod.__internals.noteHidden('waiting');
  assert.match(h.document.title, /Waiting for your choice/);
  h.mod.__internals.noteHidden('finished');
  assert.match(h.document.title, /2 task reminders/);

  h.mod.__internals.pushNotice({ kind: 'finished', title: 'T', body: 'B', location: '', session: 's1' });
  h.resetHooks();
  const tree = h.mod.__internals.NoticeStack({ t: (key) => h.mod.__internals.en[key] });
  const json = JSON.stringify(tree);
  assert.match(json, /"aria-label":"Dismiss"/);
});

test('webhook URL validation uses new URL(), cancels response body, and aborts on lifecycle signal', async () => {
  for (const bad of ['https://', 'http://:80', 'http://[invalid', 'ftp://example.com', 'https://a b.com']) {
    assert.equal(normalizeConfig({ webhook: { enabled: true, url: bad } }).webhook.url, '', `expected invalid: ${bad}`);
  }
  assert.equal(normalizeConfig({ webhook: { enabled: true, url: 'https://hooks.example.com/v1?x=1' } }).webhook.url, 'https://hooks.example.com/v1?x=1');

  let bodyCancelled = 0;
  const send = createWebhookSender({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: { cancel: async () => { bodyCancelled += 1; } },
    }),
  });
  assert.equal(send({ logger: { warn() {} } }, { webhook: { enabled: true, url: 'https://example.com/hook' } }, { title: 'T', body: 'B', kind: 'finished', session: 's1', at: 1 }), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bodyCancelled, 1);

  const lifetime = new AbortController();
  let observedSignal;
  const sendWithSignal = createWebhookSender({
    signal: lifetime.signal,
    fetchImpl: (_url, opts) => {
      observedSignal = opts.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(sendWithSignal({ logger: { warn() {} } }, { webhook: { enabled: true, url: 'https://example.com/hook' } }, { title: 'T', body: 'B', kind: 'finished', session: 's1', at: 1 }), true);
  assert.equal(observedSignal.aborted, false);
  lifetime.abort();
  assert.equal(observedSignal.aborted, true);
  assert.equal(sendWithSignal({ logger: { warn() {} } }, { webhook: { enabled: true, url: 'https://example.com/hook' } }, { title: 'T', body: 'B', kind: 'finished', session: 's1', at: 2 }), false);
});

test('toast sender limits concurrent processes and kills active children on abort signal', () => {
  const children = [];
  const warnings = [];
  const lifetime = new AbortController();
  const sender = createToastSender({
    platform: 'win32',
    fileExists: () => false,
    maxConcurrent: 2,
    signal: lifetime.signal,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.killed = false;
      child.unreffed = false;
      child.unref = () => { child.unreffed = true; };
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    },
  });
  const ctx = { logger: { warn: (m) => warnings.push(m) } };
  const cfg = { toast: { enabled: true, persistent: false } };
  const payload = { title: 'T', body: 'B', location: '' };

  assert.equal(sender(ctx, cfg, payload), true);
  assert.equal(sender(ctx, cfg, payload), true);
  assert.equal(sender(ctx, cfg, payload), false);
  assert.equal(children.length, 2);
  assert.equal(children[0].unreffed, true);
  assert.match(warnings[0], /too many concurrent/);

  // Exiting one frees a slot.
  children[0].emit('exit', 0, null);
  assert.equal(sender(ctx, cfg, payload), true);
  assert.equal(children.length, 3);

  // Unloading kills remaining active children.
  lifetime.abort();
  assert.equal(children[1].killed, true);
  assert.equal(children[2].killed, true);
  assert.equal(sender(ctx, cfg, payload), false);
});

test('NumInput preserves partial string drafts and settings model rejects invalid HH:MM before save', async (t) => {
  const h = clientHarness(t);
  const committed = [];
  let propValue = 4000;
  const renderInput = () => {
    h.resetHooks();
    return h.mod.__internals.NumInput({
      label: 'Cooldown',
      value: propValue,
      scale: 1000,
      onChange: (v) => { committed.push(v); propValue = v; },
    });
  };

  let el = renderInput();
  assert.equal(el.props.value, '4');

  // Typing '-' is NaN; must keep '-' in draft and NOT commit 0 or NaN.
  el.props.onChange({ target: { value: '-' } });
  el = renderInput();
  assert.equal(el.props.value, '-');
  assert.deepEqual(committed, []);

  // Typing '0.' keeps '0.' in draft without jumping back to '0'.
  el.props.onChange({ target: { value: '0.' } });
  el = renderInput();
  assert.equal(el.props.value, '0.');
  assert.deepEqual(committed, [0]);

  el.props.onChange({ target: { value: '0.5' } });
  el = renderInput();
  assert.equal(el.props.value, '0.5');
  assert.deepEqual(committed, [0, 500]);

  // External normalization (e.g. after save) updates the draft cleanly.
  propValue = 8000;
  el = renderInput();
  assert.equal(el.props.value, '8');

  // Quiet hours HH:MM validation prevents save POST and surfaces quiet.invalid.
  const model = h.mod.__internals.createSettingsModel();
  t.after(() => model.dispose());
  await model.load();
  const requestsBefore = h.requests.length;
  model.set((c) => { c.quiet.enabled = true; c.quiet.start = '9:00'; });
  await model.save();
  assert.equal(h.requests.length, requestsBefore, 'invalid HH:MM must not POST to host');
  assert.equal(model.getState().status, 'quiet.invalid');
  assert.equal(model.getState().dirty, true);
});
