import assert from 'node:assert/strict';
import test from 'node:test';
import { __internals } from '../lib/index.js';
import { DEFAULTS } from '../lib/config.js';

const session = {
  id: 'lifecycle',
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Run the tests' }] }],
};
const never = () => new Promise(() => {});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('prediction did not settle')), 700);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    __internals.resetState();
  }
}
function generate(llm, timeoutMs = 30) {
  return __internals.generate(
    { get: (name) => name === 'llm' ? llm : undefined },
    session,
    { ...DEFAULTS, timeoutMs, provider: 'p', model: 'm' },
  );
}

test('deadline settles even when prepareCall ignores cancellation', async () => {
  const result = await bounded(generate({ prepareCall: never }));
  assert.equal(result.reason, 'timeout');
  assert.equal(__internals.inflight.size, 0);
});

test('deadline settles even when iterator next ignores cancellation', async () => {
  const result = await bounded(generate({ prepareCall: async () => ({
    stream: () => ({ [Symbol.asyncIterator]() { return this; }, next: never }),
  }) }));
  assert.equal(result.reason, 'timeout');
});

test('late prepareCall result never dispatches after its deadline', async () => {
  const ready = deferred();
  let streams = 0;
  const result = await bounded(generate({ prepareCall: () => ready.promise }));
  ready.resolve({ stream() { streams += 1; return []; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reason, 'timeout');
  assert.equal(streams, 0);
});

test('superseding settles an uncooperative old call without publishing it', async () => {
  const ready = deferred();
  const old = generate({ prepareCall: () => ready.promise }, 500);
  const fresh = generate({ prepareCall: async () => ({
    async *stream() { yield { type: 'text-delta', text: 'Review the results' }; },
  }) }, 500);
  const [before, after] = await bounded(Promise.all([old, fresh]));
  assert.equal(before.reason, 'superseded');
  assert.equal(after.suggestion, 'Review the results');
  ready.resolve({ stream() { throw new Error('stale call was dispatched'); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(__internals.memory.get(session.id), 'Review the results');
});

test('output cap cancels adapter and does not wait for iterator cleanup', async () => {
  let signal;
  const result = await bounded(generate({ prepareCall: async (config, cancellation) => {
    signal = cancellation;
    return { stream: () => ({
      [Symbol.asyncIterator]() { return this; },
      next: async () => ({ done: false, value: { type: 'text-delta', text: 'x'.repeat(9000) } }),
      return: never,
    }) };
  } }, 500));
  assert.equal(result.reason, 'failed');
  assert.match(result.message, /output limit/);
  assert.equal(signal.aborted, true);
});
