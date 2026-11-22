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
