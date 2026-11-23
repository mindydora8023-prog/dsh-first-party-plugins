import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise event handlers and async state transitions, not a visual renderer.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function harness(initial = {}, mount = true) {
  const hooks = [], requests = [], timers = new Map();
  let cursor = 0, timerId = 0, effects = [], dirty = false, tree, api;
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
    useState(initialValue) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [hooks[i].value, (next) => {
        const value = typeof next === 'function' ? next(hooks[i].value) : next;
        if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; }
      }];
    },
    useRef(value) { return hooks[cursor++] ||= { current: value }; },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { value: fn(), deps };
      return hooks[i].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || !same(hooks[i].deps, deps)) {
        const previous = hooks[i];
        hooks[i] = { deps, cleanup: previous && previous.cleanup };
        effects.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); });
      }
    },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) { api = module.factory(() => react).__internals; } } },
    historyCompletion() {}, normalizeForMatch() {}, Date, AbortController,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw new Error('unexpected countdown'); }, clearInterval() {},
    fetch(url, options) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({
        url, options, reject,
        resolve(body, ok = true, status = ok ? 200 : 500) { resolve({ ok, status, json: async () => body }); },
        failJson() { resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }); },
      });
      return promise;
    },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  api.settingsStore.set({ ...api.DEFAULT_SETTINGS, ...initial });
  context.renderPage = () => api.SettingsPage({ t: (key) => key });
  function render() {
    dirty = true;
    for (let guard = 0; dirty && guard < 30; guard++) {
      cursor = 0; effects = []; dirty = false;
      tree = vm.runInContext('renderPage()', context, { timeout: 1000 });
      for (const effect of effects) effect();
    }
    assert.equal(dirty, false, 'render queue must settle');
  }
  function all(node = tree, depth = 0) {
    if (!node || typeof node !== 'object') return [];
    assert.ok(depth < 30);
    return [node, ...node.children.flatMap((child) => all(child, depth + 1))];
  }
  function field(label) { return all().find((node) => node.props['aria-label'] === label); }
  function button(label) { return all().find((node) => node.type === 'button' && node.children.includes(label)); }
  function change(label, value) { field(label).props.onChange({ target: { value } }); render(); }
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); if (mount) render(); }
  function saved(index, patch) { requests[index].resolve({ ok: true, settings: { ...api.DEFAULT_SETTINGS, ...patch } }); }
  function status() { return all().find((node) => node.props.role === 'status').children[0]; }
  function unmount() { for (const hook of hooks) hook?.cleanup?.(); }
  if (mount) render();
  function expire() {
    const [id, timer] = timers.entries().next().value;
    assert.equal(timer.ms, 10000);
    timers.delete(id); timer.fn();
  }
  return { api, requests, render, field, button, change, flush, saved, status, unmount, expire, timers };
}
const payload = (request) => JSON.parse(request.options.body);

test('provider and model are edited locally and saved as one complete route', async () => {
  const h = harness();
  h.change('settingsProvider', ' provider ');
  assert.equal(h.button('settingsSaveRoute').props.disabled, true);
  assert.equal(h.field('settingsProvider').props.value, ' provider ');
  h.change('settingsModel', ' model ');
  assert.equal(h.requests.length, 0);
  assert.equal(h.button('settingsSaveRoute').props.disabled, false);
  h.button('settingsSaveRoute').props.onClick(); await h.flush();
  assert.deepEqual(payload(h.requests[0]), { provider: 'provider', model: 'model' });
  h.saved(0, { provider: 'provider', model: 'model' }); await h.flush();
  assert.equal(h.field('settingsProvider').props.value, 'provider');
  assert.equal(h.button('settingsSaveRoute').props.disabled, true);
  assert.equal(h.status(), 'settingsSaved'); h.unmount();
});

test('clearing both route fields saves inheritance without sending a half route', async () => {
  const h = harness({ provider: 'p', model: 'm' });
  h.change('settingsProvider', '');
  assert.equal(h.button('settingsSaveRoute').props.disabled, true);
  h.change('settingsModel', ''); h.button('settingsSaveRoute').props.onClick(); await h.flush();
  assert.deepEqual(payload(h.requests[0]), { provider: '', model: '' }); h.unmount();
});

test('numeric input supports clearing and retyping before a single blur save', async () => {
  const h = harness();
  for (const value of ['', '1', '12', '120', '1200', '12000']) {
    h.change('settingsTimeout', value);
    assert.equal(h.field('settingsTimeout').props.value, value);
    assert.equal(h.requests.length, 0);
  }
  h.field('settingsTimeout').props.onBlur(); await h.flush();
  assert.deepEqual(payload(h.requests[0]), { timeoutMs: 12000 }); h.unmount();
});

test('empty numeric input uses the default and clamping happens at commit', async () => {
  const h = harness();
  h.change('settingsMaxChars', ''); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  assert.deepEqual(payload(h.requests[0]), { maxSuggestionChars: 120 });
  h.saved(0, {}); await h.flush();
  h.change('settingsMaxChars', '999');
  assert.equal(h.field('settingsMaxChars').props.value, '999');
  h.field('settingsMaxChars').props.onBlur(); await h.flush();
  assert.deepEqual(payload(h.requests[1]), { maxSuggestionChars: 400 }); h.unmount();
});

test('Enter commits through blur and Escape restores the saved numeric value', async () => {
  const h = harness();
  h.change('settingsMaxChars', '200');
  h.field('settingsMaxChars').props.onKeyDown({ key: 'Escape', preventDefault() {} }); h.render();
  assert.equal(h.field('settingsMaxChars').props.value, '120');
  h.field('settingsMaxChars').props.onBlur(); await h.flush(); assert.equal(h.requests.length, 0);
  h.change('settingsMaxChars', '250');
  h.field('settingsMaxChars').props.onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget: { blur: () => h.field('settingsMaxChars').props.onBlur() } });
  await h.flush(); assert.deepEqual(payload(h.requests[0]), { maxSuggestionChars: 250 }); h.unmount();
});

test('a save response preserves edits made while it was in flight', async () => {
  const h = harness();
  h.change('settingsMaxChars', '200'); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  h.change('settingsMaxChars', '300');
  h.saved(0, { maxSuggestionChars: 200 }); await h.flush();
  assert.equal(h.field('settingsMaxChars').props.value, '300');
  assert.equal(h.status(), 'settingsUnsaved');
  h.field('settingsMaxChars').props.onBlur(); await h.flush();
  assert.deepEqual(payload(h.requests[1]), { maxSuggestionChars: 300 }); h.unmount();
});

test('writes are serialized and an earlier completion never reports a queued edit saved', async () => {
  const h = harness();
  h.field('settingsEnabled').props.onChange({ target: { checked: false } });
  h.field('settingsHistory').props.onChange({ target: { checked: false } }); await h.flush();
  assert.equal(h.requests.length, 1);
  h.saved(0, { enabled: false }); await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.status(), 'settingsSaving');
  assert.deepEqual(payload(h.requests[1]), { historyEnabled: false });
  h.saved(1, { enabled: false, historyEnabled: false }); await h.flush();
  assert.equal(h.status(), 'settingsSaved'); h.unmount();
});

test('failed saves retain edits and the write queue recovers', async () => {
  const h = harness();
  h.change('settingsMaxChars', '210'); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  h.requests[0].resolve({ ok: false }, false, 400); await h.flush();
  assert.equal(h.status(), 'settingsFailed'); assert.equal(h.field('settingsMaxChars').props.value, '210');
  h.field('settingsMaxChars').props.onBlur(); await h.flush();
  h.saved(1, { maxSuggestionChars: 210 }); await h.flush();
  assert.equal(h.status(), 'settingsSaved'); h.unmount();
});

test('late initial GET cannot overwrite a newer saved snapshot', async () => {
  const h = harness({}, false);
  const loading = h.api.loadSettings();
  assert.equal(h.api.loadSettings(), loading, 'deduplicate concurrent loads');
  const saving = h.api.saveSettings({ enabled: false }); await h.flush();
  h.saved(1, { enabled: false }); await saving;
  h.saved(0, { enabled: true }); await loading;
  assert.equal(h.api.settingsStore.value.enabled, false);
});

test('a GET started during a write cannot later replace its saved snapshot', async () => {
  const h = harness({}, false);
  const saving = h.api.saveSettings({ enabled: false }); await h.flush();
  const loading = h.api.loadSettings();
  h.saved(0, { enabled: false }); await saving;
  h.saved(1, { enabled: true }); await loading;
  assert.equal(h.api.settingsStore.value.enabled, false);
});

test('reset and retyping the same text creates a new edit version', async () => {
  const h = harness();
  h.change('settingsMaxChars', '200'); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  h.button('settingsReset').props.onClick(); h.render();
  h.change('settingsMaxChars', '200');
  h.saved(0, { maxSuggestionChars: 200 }); await h.flush();
  h.saved(1, {}); await h.flush();
  assert.equal(h.field('settingsMaxChars').props.value, '200');
  assert.equal(h.status(), 'settingsUnsaved'); h.unmount();
});

test('a timed out write stops queued writes until an explicit successful reload', async () => {
  const h = harness();
  h.change('settingsMaxChars', '200'); h.field('settingsMaxChars').props.onBlur();
  h.field('settingsEnabled').props.onChange({ target: { checked: false } }); await h.flush();
  assert.equal(h.requests.length, 1);
  h.expire(); await h.flush();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests.length, 1, 'the queued patch never reaches the server');
  assert.equal(h.status(), 'settingsUncertain');
  assert.equal(h.field('settingsMaxChars').props.value, '200');
  assert.equal(h.button('settingsReset').props.disabled, true);
  // The server may have written despite the client deadline. Ignore its late response.
  h.saved(0, { maxSuggestionChars: 200 }); await h.flush();
  assert.equal(h.api.settingsStore.value.maxSuggestionChars, 120);
  h.button('settingsReload').props.onClick(); await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.method, undefined);
  h.saved(1, { maxSuggestionChars: 200 }); await h.flush();
  assert.equal(h.api.settingsStore.writeUncertain, false);
  assert.equal(h.api.settingsStore.value.maxSuggestionChars, 200);
  h.change('settingsMaxChars', '250'); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(payload(h.requests[2]), { maxSuggestionChars: 250 }); h.unmount();
});

test('ambiguous transport and response failures stop the queued writes', async () => {
  for (const fail of [
    (request) => request.reject(new TypeError('connection closed after write')),
    (request) => request.failJson(),
    (request) => request.resolve({ ok: false }, false, 500),
    (request) => request.resolve({ ok: false }),
  ]) {
    const h = harness();
    h.field('settingsEnabled').props.onChange({ target: { checked: false } });
    h.field('settingsHistory').props.onChange({ target: { checked: false } }); await h.flush();
    fail(h.requests[0]); await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.settingsStore.writeUncertain, true);
    assert.equal(h.status(), 'settingsUncertain'); h.unmount();
  }
});

test('reload cannot replace the saving state while a write is pending', async () => {
  const h = harness();
  h.api.settingsStore.error = 'initial read failed';
  h.field('settingsEnabled').props.onChange({ target: { checked: false } }); await h.flush();
  assert.equal(h.button('settingsReload').props.disabled, true);
  h.button('settingsReload').props.onClick(); await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.status(), 'settingsSaving');
  h.saved(0, { enabled: false }); await h.flush();
  assert.equal(h.status(), 'settingsSaved'); h.unmount();
});

test('a stalled reload remains bounded and keeps writes paused', async () => {
  const h = harness();
  h.field('settingsEnabled').props.onChange({ target: { checked: false } }); await h.flush();
  h.expire(); await h.flush();
  h.button('settingsReload').props.onClick(); await h.flush();
  h.expire(); await h.flush();
  assert.equal(h.status(), 'settingsUncertain');
  assert.equal(h.api.settingsStore.writeUncertain, true);
  assert.equal(h.button('settingsReload').props.disabled, false);
  assert.equal(h.timers.size, 0); h.unmount();
});

test('route fields expose the reason that saving an incomplete route is disabled', () => {
  const h = harness(); h.change('settingsProvider', 'p');
  for (const label of ['settingsProvider', 'settingsModel']) {
    assert.equal(h.field(label).props['aria-describedby'], 'next-say-route-hint');
    assert.equal(h.field(label).props['aria-invalid'], true);
  }
  h.unmount();
});

test('reset discards local fields and stays ordered after pending saves', async () => {
  const h = harness();
  h.change('settingsMaxChars', '200'); h.field('settingsMaxChars').props.onBlur(); await h.flush();
  h.change('settingsProvider', 'unfinished');
  h.button('settingsReset').props.onClick(); h.render();
  assert.equal(h.field('settingsProvider').props.value, '');
  h.saved(0, { maxSuggestionChars: 200 }); await h.flush();
  assert.deepEqual(payload(h.requests[1]), { reset: true });
  h.saved(1, {}); await h.flush();
  assert.equal(h.field('settingsMaxChars').props.value, '120'); h.unmount();
});

test('writeUncertain disables all editable controls while keeping reload enabled', async () => {
  const h = harness();
  h.field('settingsEnabled').props.onChange({ target: { checked: false } }); await h.flush();
  h.expire(); await h.flush();
  assert.equal(h.api.settingsStore.writeUncertain, true);
  for (const label of [
    'settingsEnabled', 'settingsMode', 'settingsMaxChars', 'settingsContextMessages',
    'settingsContextChars', 'settingsTimeout', 'settingsHistory', 'settingsHistoryMinChars',
    'settingsProvider', 'settingsModel',
  ]) {
    assert.equal(h.field(label).props.disabled, true, `${label} must be disabled when writeUncertain`);
  }
  assert.equal(h.button('settingsPause').props.disabled, true);
  assert.equal(h.button('settingsReset').props.disabled, true);
  assert.equal(h.button('settingsReload').props.disabled, false);
  h.unmount();
});
