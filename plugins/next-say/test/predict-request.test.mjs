/**
 * Does a prediction actually reach the network?
 *
 * Every earlier attempt at this feature failed in a way no unit test noticed:
 * `predict()` threw before it ever called `fetch` (an undeclared ref, once), and
 * its own try/catch swallowed the error. The request never appeared, the Host had
 * nothing to log, and the composer stayed empty with no failing assertion
 * anywhere.
 *
 * So this test runs the REAL built bundle with a fake `fetch` and asserts that an
 * idle, empty composer actually issues `POST /next-say/predict`. It is the only
 * check that would have caught that class of bug, and it exercises the shipped
 * bytes rather than the template.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUNDLE = new URL('../lib/client.js', import.meta.url);

/**
 * Load the built client exactly as the browser module loader would.
 *
 * The fetch stub stays installed: the component issues its request from a later
 * timer, and restoring it here (the earlier mistake) sent every request to Node's
 * real `fetch`, which rejects a relative URL.
 */
function loadBundle(fetchImpl) {
  const source = readFileSync(BUNDLE, 'utf8');
  let captured = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
  globalThis.fetch = fetchImpl;
  try {
    // eslint-disable-next-line no-new-func -- mirrors the browser loader.
    new Function(`return (function(){ ${source} })()`)();
  } finally {
    globalThis.window = previousWindow;
  }
  assert.ok(captured !== null, 'the bundle must register a module');
  return captured;
}

/** Minimal React stand-in: records effects so they can be run deliberately. */
function createReact() {
  const effects = [];
  const cleanups = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    // Keep the cleanup: an effect that clears its timer on unmount is the only
    // thing that lets the process exit.
    useEffect: (fn) => { effects.push(fn); },
  };
  const runEffects = () => {
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  };
  const cleanUp = () => {
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch { /* a cleanup must not fail the test */ }
    }
  };
  return { react, effects, runEffects, cleanUp };
}

test('an idle empty composer issues POST /next-say/predict', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const captured = loadBundle((url, options) => {
    calls.push({ url: String(url), method: (options && options.method) || 'GET', body: options && options.body });
    // A refusal is fine: the point is that the request left the component.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, reason: 'stub' }),
    });
  });

  const { react, runEffects, cleanUp } = createReact();
  const mod = captured.factory((name) => (name === 'react' ? react : {}));

  // Settings must be present and in auto mode, or the attempt is correctly skipped.
  mod.__internals.settingsStore.set({ ...mod.__internals.DEFAULT_SETTINGS, mode: 'auto', enabled: true });

  const props = {
    t: (key) => key,
    sessionId: 'session-test',
    // An empty, idle composer.
    useInput: (selector) => selector({ draft: '', phase: 'plain', draftRev: 1 }),
    useSession: (selector) => selector({ running: false }),
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: () => true },
  };

  const element = mod.__internals.SuggestionRow(props);
  assert.notEqual(element, null, 'the entry must render (it renders null itself)');

  // Run the component body so its effects register, then run them.
  mod.__internals.GhostPainter(props);
  assert.doesNotThrow(runEffects, 'no effect may throw while setting up');

  // The mount attempt is delayed; wait past its timer.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  cleanUp();

  const predicts = calls.filter((call) => call.url.includes('/next-say/predict'));
  assert.equal(predicts.length, 1, `expected exactly one prediction request, saw ${JSON.stringify(calls.map((c) => c.url))}`);
  assert.equal(predicts[0].method, 'POST');
  const payload = JSON.parse(predicts[0].body);
  assert.equal(payload.sessionId, 'session-test');
  assert.equal(payload.manual, false, 'this is an automatic prediction');
  globalThis.fetch = realFetch;
});

test('a composer with a draft does not predict', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const captured = loadBundle((url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'stub' }) });
  });
  const { react, runEffects, cleanUp } = createReact();
  const mod = captured.factory((name) => (name === 'react' ? react : {}));
  mod.__internals.settingsStore.set({ ...mod.__internals.DEFAULT_SETTINGS, mode: 'auto', enabled: true });

  const props = {
    t: (key) => key,
    sessionId: 'session-test',
    useInput: (selector) => selector({ draft: 'half typed', phase: 'plain', draftRev: 2 }),
    useSession: (selector) => selector({ running: false }),
    inputActions: { captureInsertion: () => ({ draftRev: 2 }), insertText: () => true },
  };
  mod.__internals.GhostPainter(props);
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  cleanUp();
  globalThis.fetch = realFetch;

  assert.deepEqual(calls.filter((url) => url.includes('/next-say/predict')), []);
});

test('a running turn does not predict', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const captured = loadBundle((url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'stub' }) });
  });
  const { react, runEffects, cleanUp } = createReact();
  const mod = captured.factory((name) => (name === 'react' ? react : {}));
  mod.__internals.settingsStore.set({ ...mod.__internals.DEFAULT_SETTINGS, mode: 'auto', enabled: true });

  const props = {
    t: (key) => key,
    sessionId: 'session-test',
    useInput: (selector) => selector({ draft: '', phase: 'plain', draftRev: 3 }),
    useSession: (selector) => selector({ running: true }),
    inputActions: { captureInsertion: () => ({ draftRev: 3 }), insertText: () => true },
  };
  mod.__internals.GhostPainter(props);
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  cleanUp();
  globalThis.fetch = realFetch;

  assert.deepEqual(calls.filter((url) => url.includes('/next-say/predict')), []);
});
