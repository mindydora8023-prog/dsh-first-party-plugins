import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { historyCompletion, normalizeForMatch } from '../lib/match.js';

// The parent owns a hard deadline, including synchronous VM or fake-hook bugs.
if (process.env.NEXT_SAY_LIFECYCLE_CHILD !== '1') {
  test('client lifecycle cases finish within the process deadline', () => {
    const env = { ...process.env, NEXT_SAY_LIFECYCLE_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
      env,
      encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  const source = readFileSync(new URL('../client/client.template.js', import.meta.url), 'utf8')
    .replace('/*__LOCALES__*/', 'const zh = {}, en = {};');
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function harness(options = {}) {
    const ghostHooks = [], controlHooks = [];
    let hooks = ghostHooks;
    const requests = [];
    const timers = new Map();
    const listeners = new Map();
    const paints = [];
    const inserted = [], focused = [];
    let cursor = 0, timerId = 0, dirty = true, effects = [], api;
    const clock = { now: Date.now() };
    const state = { draft: '', phase: 'plain', running: false };
    const props = {
      sessionId: 'a', t: (key) => key,
      useInput: (select) => select(state),
      useSession: (select) => select(state),
      inputActions: { captureInsertion: () => ({}), insertText: (text) => { inserted.push(text); return true; }, focus: () => focused.push(props.sessionId) },
    };
    const React = {
      createElement(type, props, ...children) { return { type, props, children }; },
      useState(initial) {
        const i = cursor++, pool = hooks;
        if (!pool[i]) pool[i] = { value: typeof initial === 'function' ? initial() : initial };
        return [pool[i].value, (next) => {
          const value = typeof next === 'function' ? next(pool[i].value) : next;
          if (!Object.is(value, pool[i].value)) { pool[i].value = value; dirty = true; }
        }];
      },
      useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
      useMemo(factory, deps) {
        const i = cursor++;
        if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { value: factory(), deps };
        return hooks[i].value;
      },
      useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
      useEffect(factory, deps) {
        const i = cursor++, pool = hooks;
        if (!pool[i] || !same(pool[i].deps, deps)) {
          const previous = pool[i];
          pool[i] = { deps, cleanup: previous && previous.cleanup };
          effects.push(() => {
            if (pool[i].cleanup) pool[i].cleanup();
            pool[i].cleanup = factory();
          });
        }
      },
    };
    const doc = {
      visibilityState: 'visible', activeElement: null,
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    };
    const context = vm.createContext({
      window: { __ModuleLoader__: { load(module) { api = module.factory(() => React).__internals; } } },
      document: doc, AbortController, historyCompletion, normalizeForMatch,
      paintGhost: (...args) => paints.push(args.slice(1)), clearGhost: () => paints.push(['clear']),
      setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); }, Date: { now: () => clock.now },
      fetch(url, init) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        requests.push({ url, init, resolve: (body) => resolve({ json: async () => body }), reject });
        return promise;
      },
    });
    vm.runInContext(source, context, { timeout: 1000 });
    api.settingsStore.set({ ...api.DEFAULT_SETTINGS, mode: 'manual', ...options });
    context.__row = api.GhostPainter;
    context.__control = api.ManualControl;
    context.__props = props;
    function render() {
      dirty = true;
      for (let guard = 0; dirty && guard < 30; guard++) {
        dirty = false; cursor = 0; effects = [];
        vm.runInContext('__row(__props)', context, { timeout: 1000 });
        for (const effect of effects) effect();
      }
      assert.equal(dirty, false, 'bounded render queue settled');
    }
    async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
    function fire(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `timer ${ms} exists`);
      timers.delete(entry[0]); entry[1].fn();
    }
    function predict() {
      const callback = hooks.find((hook) => hook && hook.value && hook.value.constructor?.name === 'AsyncFunction');
      assert.ok(callback, 'prediction callback exists');
      return callback.value({ manual: true });
    }
    function key(session = props.sessionId, external = false, name = 'Tab') {
      const editor = { closest: () => ({ getAttribute: () => session }) };
      doc.activeElement = { isContentEditable: true, closest: () => external ? null : editor };
      const event = { key: name, preventDefault() { this.prevented = true; }, stopPropagation() {} };
      for (const fn of listeners.get('keydown') || []) fn(event);
      return event;
    }
    function control() {
      hooks = controlHooks;
      let tree;
      try {
        dirty = true;
        for (let guard = 0; dirty && guard < 30; guard++) {
          dirty = false; cursor = 0; effects = [];
          tree = vm.runInContext('__control(__props)', context, { timeout: 1000 });
          for (const effect of effects) effect();
        }
        assert.equal(dirty, false, 'control render queue settled');
        return tree;
      } finally { hooks = ghostHooks; }
    }
    function unmountControl() {
      for (const hook of controlHooks) if (hook?.cleanup) { hook.cleanup(); hook.cleanup = null; }
    }
    function unmount() {
      for (const hook of [...ghostHooks, ...controlHooks]) if (hook?.cleanup) { hook.cleanup(); hook.cleanup = null; }
    }
    render();
    return { state, props, hooks: ghostHooks, requests, timers, listeners, paints, inserted, focused, doc, clock, api, render, control, settle, fire, predict, key, unmount, unmountControl };
  }

  test('late history from the previous session never replaces the current pool', async () => {
    const h = harness();
    const old = h.requests[0];
    h.props.sessionId = 'b'; h.render();
    assert.equal(old.init.signal.aborted, true);
    h.requests.find((r) => r.url.includes('sessionId=b')).resolve({ items: [{ text: 'hello beta' }] });
    await h.settle();
    old.resolve({ items: [{ text: 'hello alpha' }] }); await h.settle();
    h.state.draft = 'hello'; h.render();
    h.key();
    assert.deepEqual(h.inserted, [' beta']);
    h.unmount();
  });

  test('session switch immediately hides the previous local completion', async () => {
    const h = harness();
    h.requests[0].resolve({ items: [{ text: 'hello alpha' }] }); await h.settle();
    h.state.draft = 'hello'; h.render();
    h.props.sessionId = 'b'; h.render();
    assert.equal(h.key().prevented, undefined);
    assert.deepEqual(h.inserted, []);
    h.unmount();
  });

  test('stale prediction and finally do not mutate the next request', async () => {
    const h = harness();
    const first = h.predict();
    const old = h.requests.at(-1);
    h.props.sessionId = 'b'; h.render();
    assert.equal(old.init.signal.aborted, true);
    const second = h.predict();
    const fresh = h.requests.at(-1);
    old.resolve({ ok: true, suggestion: 'stale' }); await first; await h.settle();
    assert.equal(h.hooks[3].value, true, 'new request remains busy');
    assert.equal(h.hooks[1].value, '');
    fresh.resolve({ ok: true, suggestion: 'fresh' }); await second; await h.settle();
    assert.equal(h.hooks[1].value, 'fresh');
    h.unmount();
  });

  test('repeated prediction triggers preserve the active request and its busy state', async () => {
    const h = harness();
    const first = h.predict(); const request = h.requests.at(-1);
    const second = h.predict(); await second; await h.settle();
    assert.equal(request.init.signal.aborted, false);
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
    assert.equal(h.hooks[3].value, true);
    request.resolve({ ok: true, suggestion: 'result' }); await first; await h.settle();
    assert.equal(h.hooks[3].value, false);
    h.unmount();
  });

  test('starting a turn cancels a prediction and ignores its late response', async () => {
    const h = harness(); const work = h.predict(); const request = h.requests.at(-1);
    h.state.running = true; h.render();
    assert.equal(request.init.signal.aborted, true);
    request.resolve({ ok: true, suggestion: 'obsolete' }); await work; await h.settle();
    h.state.running = false; h.render();
    assert.equal(h.hooks[1].value, '');
    h.unmount();
  });

  test('a prediction follow-up history response stays in its original session', async () => {
    const h = harness(); const work = h.predict();
    h.requests.at(-1).resolve({ ok: true, suggestion: 'model' }); await work; await h.settle();
    const followup = h.requests.at(-1);
    h.props.sessionId = 'b'; h.render();
    assert.equal(followup.init.signal.aborted, true);
    h.requests.at(-1).resolve({ items: [{ text: 'hello beta' }] }); await h.settle();
    followup.resolve({ items: [{ text: 'hello alpha' }] }); await h.settle();
    h.state.draft = 'hello'; h.render(); h.key();
    assert.deepEqual(h.inserted, [' beta']);
    h.unmount();
  });

  test('a cancelled mount timer gets a new attempt when the composer is idle', () => {
    const h = harness({ mode: 'auto' });
    h.state.draft = 'typing'; h.render();
    assert.ok(![...h.timers.values()].some((t) => t.ms === 1200));
    h.state.draft = ''; h.render();
    h.fire(1200);
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
    h.unmount();
  });

  test('keyboard accepts the visible local suffix instead of a hidden model prediction', async () => {
    const h = harness();
    h.requests[0].resolve({ items: [{ text: 'hello world' }] }); await h.settle();
    const work = h.predict(); h.requests.at(-1).resolve({ ok: true, suggestion: 'next model text' });
    await work; await h.settle();
    h.state.draft = 'hello'; h.render();
    assert.equal(h.key('a', true).prevented, undefined, 'unrelated contenteditable');
    assert.equal(h.key('other').prevented, undefined, 'another session composer');
    assert.equal(h.key().prevented, true);
    assert.deepEqual(h.inserted, [' world']);
    h.unmount();
  });

  test('Escape immediately dismisses local completion and further typing restores it', async () => {
    const h = harness(); h.requests[0].resolve({ items: [{ text: 'hello world' }] }); await h.settle();
    h.state.draft = 'hello'; h.render();
    assert.equal(h.key('a', false, 'Escape').prevented, true);
    h.render();
    assert.equal(h.key().prevented, undefined);
    assert.deepEqual(h.inserted, []);
    h.state.draft = 'hello w'; h.render();
    assert.equal(h.key().prevented, true);
    assert.deepEqual(h.inserted, ['orld']);
    h.unmount();
  });

  test('submitting and paused composers do not consume Tab', async () => {
    const h = harness(); h.requests[0].resolve({ items: [{ text: 'hello world' }] }); await h.settle();
    h.state.draft = 'hello'; h.state.phase = 'submitting'; h.render();
    assert.equal(h.key().prevented, undefined);
    h.state.phase = 'plain';
    h.api.settingsStore.set({ ...h.api.DEFAULT_SETTINGS, pausedUntil: Date.now() + 60000 }); h.render();
    assert.equal(h.key().prevented, undefined);
    h.unmount();
  });

  test('manual dock calls once, announces success and fills without sending', async () => {
    const h = harness(); const tree = h.control(); const button = tree.children[0];
    assert.equal(button.children[0], 'manualPredict'); assert.equal(button.props.disabled, false);
    const target = { isConnected: true }; h.doc.activeElement = target;
    const first = button.props.onClick({ currentTarget: target });
    const repeated = button.props.onClick({ currentTarget: target });
    h.render();
    assert.equal(h.control().children[0].props.disabled, true);
    const requests = h.requests.filter((r) => r.url.endsWith('/predict'));
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].init.body).manual, true);
    requests[0].resolve({ ok: true, suggestion: 'Review the results' });
    await first; await repeated; await h.settle();
    assert.equal(h.control().children[1].children[0], 'manualReady');
    assert.deepEqual(h.focused, ['a']);
    assert.equal(h.key().prevented, true);
    assert.deepEqual(h.inserted, ['Review the results']);
    assert.equal(h.control().children[0].type, 'button'); h.unmount();
    assert.equal(h.api.manualControls.entries.size, 0);
    assert.equal(h.api.manualControls.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  });

  test('manual dock is absent outside manual mode and explains blocked states', async () => {
    const auto = harness({ mode: 'auto' }); assert.equal(auto.control(), null); auto.unmount();
    const off = harness({ enabled: false }); assert.equal(off.control(), null); off.unmount();
    for (const [change, settings, reason] of [
      [{ draft: 'draft' }, {}, 'manualDraft'],
      [{ phase: 'sending' }, {}, 'manualInputBusy'],
      [{ running: true }, {}, 'manualRunning'],
      [{}, { pausedUntil: Date.now() + 60000 }, 'manualPaused'],
    ]) {
      const h = harness(settings); Object.assign(h.state, change); h.render();
      const tree = h.control(); assert.equal(tree.children[0].props.disabled, true);
      assert.equal(tree.children[1].children[0], reason);
      await tree.children[0].props.onClick({ currentTarget: {} });
      assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 0); h.unmount();
    }
  });

  test('manual failures have feedback and never automatically retry', async () => {
    for (const [reason, key] of [['no-history', 'noHistory'], ['no-route', 'manualNoRoute'],
      ['timeout', 'timeout'], ['empty', 'manualNoResult'], ['failed', 'failed'], ['constructor', 'failed'], ['__proto__', 'failed']]) {
      const h = harness(); const work = h.control().children[0].props.onClick({ currentTarget: {} });
      h.requests.at(-1).resolve({ ok: false, reason }); await work; await h.settle();
      assert.equal(h.control().children[1].children[0], key);
      assert.equal(h.control().children[0].props.disabled, false);
      assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
      assert.ok(![...h.timers.values()].some((timer) => [900, 1200, 2000].includes(timer.ms)));
      h.unmount();
    }
  });

  test('manual transport deadline settles even when fetch ignores cancellation', async () => {
    const h = harness(); const work = h.control().children[0].props.onClick({ currentTarget: {} });
    const request = h.requests.at(-1); h.fire(22000); await work; await h.settle();
    assert.equal(request.init.signal.aborted, true);
    assert.equal(h.control().children[1].children[0], 'timeout');
    assert.equal(h.control().children[0].props.disabled, false);
    request.resolve({ ok: true, suggestion: 'late' }); await h.settle();
    assert.equal(h.hooks[1].value, ''); h.unmount();
  });

  test('manual reroll sends avoidance and a failure preserves the usable suggestion', async () => {
    const h = harness(); const first = h.control().children[0].props.onClick({ currentTarget: {} });
    h.requests.at(-1).resolve({ ok: true, suggestion: 'first suggestion' }); await first; await h.settle();
    const tree = h.control(); assert.equal(tree.children[0].children[0], 'reroll');
    const second = tree.children[0].props.onClick({ currentTarget: {} });
    const request = h.requests.at(-1), body = JSON.parse(request.init.body);
    assert.equal(body.forceDifferent, true); assert.equal(body.avoid, 'first suggestion');
    request.reject(new Error('offline')); await second; await h.settle();
    assert.equal(h.control().children[1].children[0], 'failed');
    assert.equal(h.key().prevented, true); assert.deepEqual(h.inserted, ['first suggestion']); h.unmount();
  });

  test('stale manual controls cannot trigger the replacement session or steal focus', async () => {
    const h = harness(); const old = h.control().children[0]; const target = { isConnected: true };
    h.doc.activeElement = target;
    const work = old.props.onClick({ currentTarget: target }); const request = h.requests.at(-1);
    h.props.sessionId = 'b'; h.render(); request.resolve({ ok: true, suggestion: 'stale' }); await work; await h.settle();
    await old.props.onClick({ currentTarget: target });
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
    assert.deepEqual(h.focused, []); assert.equal(h.api.manualControls.entries.has('a'), false);
    assert.equal(h.control().children[0].props.disabled, false); h.unmount();
  });

  test('manual completion never steals focus after the user moves elsewhere', async () => {
    const h = harness(); const target = { isConnected: true }; h.doc.activeElement = target;
    const work = h.control().children[0].props.onClick({ currentTarget: target });
    h.doc.activeElement = {}; h.requests.at(-1).resolve({ ok: true, suggestion: 'result' }); await work; await h.settle();
    assert.deepEqual(h.focused, []); h.unmount();
  });

  test('independent dock unmount removes subscription and prevents a late focus', async () => {
    const h = harness(); const target = { isConnected: true }; h.doc.activeElement = target;
    const button = h.control().children[0];
    const work = button.props.onClick({ currentTarget: target }); const request = h.requests.at(-1);
    assert.equal(h.api.manualControls.listeners.size, 1);
    h.unmountControl();
    assert.equal(h.api.manualControls.listeners.size, 0);
    assert.equal(request.init.signal.aborted, false, 'the overlay still owns its request');
    request.resolve({ ok: true, suggestion: 'result' }); await work; await h.settle();
    assert.deepEqual(h.focused, []);
    await button.props.onClick({ currentTarget: target });
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
    assert.equal(h.key().prevented, true, 'the overlay remains usable'); h.unmount();
  });

  test('pause expiry wakes an idle manual control without polling or typing', async () => {
    const h = harness({ pausedUntil: Date.now() + 1000 });
    h.requests[0].resolve({ items: [] }); await h.settle();
    assert.equal(h.control().children[0].props.disabled, true);
    const pause = [...h.timers.values()].find((timer) => timer.ms <= 1000);
    assert.ok(pause);
    h.clock.now += 2000; h.fire(pause.ms); h.render();
    assert.equal(h.control().children[0].props.disabled, false);
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 0);
    assert.equal(h.timers.size, 0); h.unmount();
  });

  test('a stalled turn read times out and polling recovers on the next interval', async () => {
    const h = harness({ mode: 'auto' });
    h.requests[0].resolve({ items: [] }); await h.settle();
    h.fire(900); const old = h.requests.at(-1);
    assert.ok(old.url.includes('/turn?'));
    h.fire(10000); await h.settle();
    assert.equal(old.init.signal.aborted, true);
    h.fire(2000); const fresh = h.requests.at(-1);
    assert.ok(fresh.url.includes('/turn?'));
    assert.notEqual(fresh.init.signal, old.init.signal);
    old.resolve({ ok: true, turn: 99 }); await h.settle();
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 0);
    fresh.resolve({ ok: true, turn: 3 }); await h.settle();
    const requests = h.requests.filter((r) => r.url.endsWith('/predict'));
    assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0].init.body).turn, 3);
    h.unmount(); await h.settle(); assert.equal(h.timers.size, 0);
  });

  test('all non-plain input phases suppress completion and prediction', async () => {
    for (const phase of ['adjudicating', 'claimed', 'submitting', 'sending', 'inert', undefined]) {
      const h = harness();
      h.requests[0].resolve({ items: [{ text: 'hello world' }] }); await h.settle();
      h.state.draft = 'hello'; h.render();
      h.state.phase = phase; h.render();
      assert.equal(h.key().prevented, undefined, String(phase));
      assert.deepEqual(h.inserted, []);
      assert.equal(h.paints.at(-1)[1], '', 'no ghost while input is unavailable');
      h.state.draft = ''; h.render(); await h.predict();
      assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 0);
      h.unmount();
    }
  });

  test('non-plain input phases cancel pending predictions and ignore late responses', async () => {
    for (const phase of ['adjudicating', 'claimed', 'submitting', 'sending']) {
      const h = harness(); const work = h.predict(); const request = h.requests.at(-1);
      h.state.phase = phase; h.render();
      assert.equal(request.init.signal.aborted, true, phase);
      request.resolve({ ok: true, suggestion: 'obsolete' }); await work; await h.settle();
      h.state.phase = 'plain'; h.render();
      assert.equal(h.hooks[1].value, ''); h.unmount();
    }
  });

  test('automatic timers wait until the input returns to plain', () => {
    const h = harness({ mode: 'auto' });
    h.state.phase = 'sending'; h.render();
    assert.ok(![...h.timers.values()].some((timer) => timer.ms === 900 || timer.ms === 1200));
    h.state.phase = 'plain'; h.render(); h.fire(1200);
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 1);
    h.unmount();
  });

  test('turn polling is single flight and cleanup aborts requests and removes resources', async () => {
    const h = harness({ mode: 'auto' });
    h.fire(900);
    const turn = h.requests.find((r) => r.url.includes('/turn?'));
    for (const fn of h.listeners.get('visibilitychange')) fn();
    h.fire(0);
    assert.equal(h.requests.filter((r) => r.url.includes('/turn?')).length, 1);
    h.unmount();
    assert.equal(turn.init.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.ok([...h.listeners.values()].every((set) => set.size === 0));
    turn.resolve({ ok: true, turn: 3 }); await h.settle();
    assert.equal(h.requests.filter((r) => r.url.endsWith('/predict')).length, 0);
    h.unmount();
  });
}
