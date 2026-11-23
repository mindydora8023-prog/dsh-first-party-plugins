/**
 * Daily call budget: config clamping and the /predict refusal path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, normalizeSettings } from '../lib/config.js';
import { __internals } from '../lib/index.js';

const { createHandler } = __internals;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; if (headers) this.headers = headers; },
    end(chunk) { this.body += chunk || ''; },
  };
  return res;
}

function handlerFor(state, services) {
  return createHandler({ get: (name) => services[name] }, state);
}

test('dailyCallBudget defaults to 0 and clamps to [0, 100000]', () => {
  assert.equal(DEFAULTS.dailyCallBudget, 0);
  assert.equal(normalizeSettings({}).dailyCallBudget, 0);
  assert.equal(normalizeSettings({ dailyCallBudget: -5 }).dailyCallBudget, 0);
  assert.equal(normalizeSettings({ dailyCallBudget: 42 }).dailyCallBudget, 42);
  assert.equal(normalizeSettings({ dailyCallBudget: 999999 }).dailyCallBudget, 100000);
  assert.equal(normalizeSettings({ dailyCallBudget: '' }).dailyCallBudget, 0);
});

test('GET /settings reports usage with the budget', async () => {
  const state = { file: 'x', settings: normalizeSettings({ dailyCallBudget: 3 }) };
  const handler = handlerFor(state, {
    connection: { requestRejection() {} },
    sessions: { get: () => undefined },
  });
  const res = fakeRes();
  await handler({ method: 'GET', url: '/next-say/settings' }, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.usage.budget, 3);
  assert.equal(payload.usage.used, 0);
  assert.equal(payload.usage.day, today());
});

test('/predict refuses with reason "budget" once the daily cap is reached', async () => {
  const state = {
    file: 'x',
    settings: normalizeSettings({ enabled: true, mode: 'auto', provider: 'p', model: 'm', dailyCallBudget: 1 }),
    usage: { day: today(), used: 1 },
  };
  const session = { id: 's1', deriveMessages: () => [] };
  const handler = handlerFor(state, {
    connection: { requestRejection() {} },
    sessions: { get: () => session },
  });
  const res = fakeRes();
  const body = Buffer.from(JSON.stringify({ sessionId: 's1', manual: true }));
  await handler({ method: 'POST', url: '/next-say/predict', body }, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'budget');
  assert.equal(payload.usage.used, 1);
});

test('a new UTC day resets the used counter', async () => {
  const state = {
    file: 'x',
    settings: normalizeSettings({ enabled: true, mode: 'auto', provider: 'p', model: 'm', dailyCallBudget: 1 }),
    usage: { day: '2000-01-01', used: 1 },
  };
  const handler = handlerFor(state, {
    connection: { requestRejection() {} },
    sessions: { get: () => ({ id: 's1', deriveMessages: () => [] }) },
  });
  const res = fakeRes();
  await handler({ method: 'POST', url: '/next-say/predict', body: Buffer.from(JSON.stringify({ sessionId: 's1', manual: true })) }, res);
  const payload = JSON.parse(res.body);
  // The stale day is rolled over, so the budget no longer blocks; the call then
  // proceeds to generate() which has no llm here and reports no-llm.
  assert.notEqual(payload.reason, 'budget');
});

test('concurrent /predict calls cannot race past dailyCallBudget and pre-check refusals refund', async () => {
  let releaseCall;
  let modelCalls = 0;
  const state = {
    file: 'x',
    settings: normalizeSettings({ enabled: true, mode: 'auto', provider: 'p', model: 'm', dailyCallBudget: 1 }),
  };
  const session = {
    id: 's-race',
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Run tests' }] }],
  };
  const llm = {
    prepareCall: async () => {
      modelCalls += 1;
      await new Promise((resolve) => { releaseCall = resolve; });
      return {
        async *stream() {
          yield { type: 'text-delta', text: 'Check logs' };
        },
      };
    },
  };
  const handler = handlerFor(state, {
    connection: { requestRejection() {} },
    sessions: { get: () => session },
    llm,
  });
  const res1 = fakeRes();
  const res2 = fakeRes();
  const p1 = handler({ method: 'POST', url: '/next-say/predict', body: { sessionId: 's-race', manual: true } }, res1);
  const p2 = handler({ method: 'POST', url: '/next-say/predict', body: { sessionId: 's-race', manual: true } }, res2);
  await new Promise((resolve) => setImmediate(resolve));
  releaseCall();
  await Promise.all([p1, p2]);
  assert.equal(modelCalls, 1, 'only one request may execute when dailyCallBudget is 1');
  const bodies = [JSON.parse(res1.body), JSON.parse(res2.body)];
  assert.equal(bodies.filter((b) => b.ok === true).length, 1);
  assert.equal(bodies.filter((b) => b.reason === 'budget').length, 1);
  assert.equal(state.usage.used, 1);

  // Refund check: when no llm is available (elapsedMs === undefined), reserved budget is refunded.
  const refundState = {
    file: 'x',
    settings: normalizeSettings({ enabled: true, mode: 'auto', provider: 'p', model: 'm', dailyCallBudget: 1 }),
  };
  const noLlmHandler = handlerFor(refundState, {
    connection: { requestRejection() {} },
    sessions: { get: () => session },
  });
  const res3 = fakeRes();
  await noLlmHandler({ method: 'POST', url: '/next-say/predict', body: { sessionId: 's-race', manual: true } }, res3);
  assert.equal(JSON.parse(res3.body).reason, 'no-llm');
  assert.equal(refundState.usage.used, 0, 'failed pre-check must refund reserved daily budget');
});

test('reroll with forceDifferent rejects near-duplicate of avoid text', async () => {
  const runtime = __internals.createRuntimeState();
  const session = {
    id: 's-dup',
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Run tests' }] }],
  };
  const llm = {
    prepareCall: async () => ({
      async *stream() {
        yield { type: 'text-delta', text: 'Run all the tests now.' };
      },
    }),
  };
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
  const result = await __internals.generate(
    ctx,
    session,
    normalizeSettings({ provider: 'p', model: 'm' }),
    { avoid: 'Run all the tests now', forceDifferent: true },
    runtime,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate');
});
