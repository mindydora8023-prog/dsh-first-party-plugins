import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function harness() {
  let api;
  const requests = [], timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) { api = module.factory(() => ({})).__internals; } } },
    historyCompletion() {}, normalizeForMatch() {}, AbortController,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({
      url, options, reject,
      resolve(items) { resolve({ ok: true, json: async () => ({ items }) }); },
      resolveBody(body) { resolve({ ok: true, json: async () => body }); },
    })); },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  function expire() {
    const [id, timer] = timers.entries().next().value;
    assert.equal(timer.ms, 10000);
    timers.delete(id); timer.fn();
  }
  return { cache: api.createHistoryCache(), requests, timers, expire };
}
const item = (text) => ({ text, role: 'user' });

test('cache retains at most sixteen sessions and reading refreshes recency', () => {
  const { cache } = harness();
  for (let i = 0; i < 16; i++) cache.set(`s${i}`, [item(`question ${i}`)]);
  assert.equal(cache.get('s0')[0].text, 'question 0');
  cache.set('new', [item('latest')]);
  assert.equal(cache.get('s1'), undefined);
  assert.equal(cache.get('s0')[0].text, 'question 0');
  assert.equal(cache.get('new')[0].text, 'latest');
});

test('cache stores only the newest 200 valid human messages with bounded text', () => {
  const { cache } = harness();
  const input = Array.from({ length: 300 }, (_, i) => item(String(i)));
  input.push({ role: 'assistant', text: 'not user text' }, null, item('x'.repeat(4000)));
  cache.set('s', input);
  const result = cache.get('s');
  assert.equal(result.length, 200);
  assert.equal(result[0].text, '101');
  assert.equal(result.at(-1).text.length, 2000);
  assert.equal(result.some((entry) => entry.text === 'not user text'), false);
});

test('aggregate character budget evicts old pools even below the session count limit', () => {
  const { cache } = harness();
  const large = Array.from({ length: 200 }, () => item('x'.repeat(2000)));
  cache.set('a', large); cache.set('b', large); cache.set('c', large);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b').length, 200);
  assert.equal(cache.get('c').length, 200);
  cache.clear('b'); cache.set('d', large);
  assert.equal(cache.get('c').length, 200, 'clearing returns its character budget');
  cache.set('d', [item('small')]); cache.set('e', large);
  assert.equal(cache.get('c').length, 200, 'replacing a pool returns its previous budget');
});

test('an evicted pending request never reintroduces a forgotten pool', async () => {
  const { cache, requests } = harness();
  const pending = cache.refresh('old');
  for (let i = 0; i < 16; i++) cache.set(`s${i}`, [item(`question ${i}`)]);
  requests[0].resolve([item('stale')]); await pending;
  assert.equal(cache.get('old'), undefined);
  assert.equal(cache.get('s0')[0].text, 'question 0');
});

test('clear and reopen invalidate an earlier request for the same session', async () => {
  const { cache, requests } = harness();
  const first = cache.refresh('s');
  cache.clear('s');
  const second = cache.refresh('s');
  requests[1].resolve([item('fresh')]); await second;
  requests[0].resolve([item('stale')]); await first;
  assert.equal(cache.get('s')[0].text, 'fresh');
});

test('out-of-order refresh and explicit set preserve the newest version', async () => {
  const { cache, requests } = harness();
  const first = cache.refresh('s'), second = cache.refresh('s');
  requests[1].resolve([item('fresh')]); await second;
  requests[0].resolve([item('stale')]); await first;
  assert.equal(cache.get('s')[0].text, 'fresh');
  const third = cache.refresh('s'); cache.set('s', [item('explicit')]);
  requests[2].resolve([item('late')]); await third;
  assert.equal(cache.get('s')[0].text, 'explicit');
});

test('malformed history responses preserve the last successful pool', async () => {
  const { cache, requests } = harness();
  cache.set('s', [item('cached')]);
  for (const body of [null, {}, { ok: false, items: [] }, { items: 'invalid' }]) {
    const pending = cache.refresh('s'); requests.at(-1).resolveBody(body); await pending;
    assert.equal(cache.get('s')[0].text, 'cached');
  }
});

test('history read deadline releases waiting and ignores a late replacement', async () => {
  const { cache, requests, timers, expire } = harness();
  cache.set('s', [item('cached')]);
  const old = cache.refresh('s'); expire(); await old;
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(cache.get('s')[0].text, 'cached');
  const fresh = cache.refresh('s'); requests[1].resolve([item('fresh')]); await fresh;
  requests[0].resolve([item('late')]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.get('s')[0].text, 'fresh');
  assert.equal(timers.size, 0);
});

test('history read cancellation settles even when fetch never observes it', async () => {
  const { cache, requests, timers } = harness();
  cache.set('s', [item('cached')]);
  const controller = new AbortController();
  const pending = cache.refresh('s', controller.signal);
  controller.abort(); await pending;
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(cache.get('s')[0].text, 'cached');
});

test('cancelled or failed refresh preserves the last successful pool', async () => {
  const { cache, requests } = harness();
  cache.set('s', [item('cached')]);
  const signal = { aborted: false };
  const first = cache.refresh('s', signal);
  signal.aborted = true; requests[0].resolve([item('cancelled')]); await first;
  const second = cache.refresh('s'); requests[1].reject(new Error('offline')); await second;
  assert.equal(cache.get('s')[0].text, 'cached');
});
