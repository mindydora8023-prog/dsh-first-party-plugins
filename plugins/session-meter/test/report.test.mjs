import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { createSpendReport, serializeSpendReport, spendReportFilename } from '../lib/report.js';

const MODEL_A = {
  model: 'alpha', provider: 'relay',
  uncachedInputTokens: 200, outputTokens: 80, cacheReadTokens: 700, cacheWriteTokens: 100,
  costCny: 6, cacheSavedCny: 4,
};
const MODEL_B = {
  model: 'beta', provider: 'direct',
  uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
  costCny: 2, cacheSavedCny: 0,
};

const MONTH = { month: '2028-02' };
const SAMPLE = { version: 3, days: {
  '2028-01-30': { a: { 1: MODEL_A } },
  '2028-02-01': { a: { 2: MODEL_A }, b: { 1: MODEL_B } },
  '2028-02-29': {
    a: { 3: { ...MODEL_A, costCny: null, cacheSavedCny: null } },
    b: { 2: { ...MODEL_B, costCny: 0 } },
    legacy: { 1: 1, __overflow: 2 },
  },
  '2028-03-01': { a: { 4: MODEL_A } },
  '2028-02-30': { invalid: { 1: 9000 } },
} };

test('empty reports have no model rows and undefined rates remain null', () => {
  const all = createSpendReport(undefined, { period: 'all' });
  assert.deepEqual(all.range, { period: 'all', from: null, to: null });
  assert.equal(all.totals.costCny, 0);
  assert.equal(all.totals.cacheSavingsRate, null);
  assert.deepEqual(all.models, []);
  assert.deepEqual(all.daily, []);
  assert.equal(spendReportFilename(all, 'html'), 'session-meter-all.html');
  assert.match(serializeSpendReport(all, 'html'), /No requests recorded/);
  assert.match(serializeSpendReport(all, 'csv'), /^section,from,to,date,/);
});

test('monthly report covers a leap month and preserves costs without model details', () => {
  const report = createSpendReport(SAMPLE, MONTH);
  assert.deepEqual(report.range, { period: 'month', from: '2028-02-01', to: '2028-02-29' });
  assert.equal(report.totals.costCny, 11);
  assert.equal(report.totals.legacyCostCny, 3);
  assert.equal(report.totals.hasLegacyCosts, true);
  assert.equal(report.totals.requests, 4);
  assert.equal(report.totals.pricedRequests, 3);
  assert.equal(report.totals.cacheSavedCny, 4);
  assert.equal(report.totals.cacheSavingsRate, 4 / (8 + 4));
  assert.deepEqual(report.models, [
    {
      provider: 'relay', model: 'alpha', requests: 2, pricedRequests: 1, inputTokens: 2000,
      outputTokens: 160, cacheReadTokens: 1400, costCny: 6, cacheSavedCny: 4,
      cacheHitRate: 0.7, averageRequestCostCny: 6, costShare: 6 / 11,
    },
    {
      provider: 'direct', model: 'beta', requests: 2, pricedRequests: 2, inputTokens: 600,
      outputTokens: 100, cacheReadTokens: 0, costCny: 2, cacheSavedCny: 0,
      cacheHitRate: 0, averageRequestCostCny: 1, costShare: 2 / 11,
    },
  ]);
  assert.equal(report.daily.length, 29);
  assert.deepEqual(report.daily[1], { date: '2028-02-02', costCny: 0, recorded: false });
  assert.deepEqual(report.daily.filter((day) => day.recorded), [
    { date: '2028-02-01', costCny: 8, recorded: true },
    { date: '2028-02-29', costCny: 3, recorded: true },
  ]);
  assert.deepEqual(JSON.parse(serializeSpendReport(report, 'json')), report);
  const csv = serializeSpendReport(report, 'csv');
  assert.match(csv, /model,2028-02-01,2028-02-29,,relay,alpha,2,1,2000,160,1400,6,4,/);
  assert.match(csv, /day,2028-02-01,2028-02-29,2028-02-29,,,,,,,,3,/);
});

test('last 30 days, all retained, and custom dates use inclusive calendar boundaries', () => {
  const last30 = createSpendReport(SAMPLE, { period: 'last30', today: '2028-03-01' });
  assert.deepEqual(last30.range, { period: 'last30', from: '2028-02-01', to: '2028-03-01' });
  assert.equal(last30.daily.length, 30);
  assert.equal(last30.totals.costCny, 17);
  assert.equal(createSpendReport(SAMPLE, { period: 'all' }).totals.costCny, 23);
  assert.equal(createSpendReport(SAMPLE, { period: 'custom', from: '2028-02-29', to: '2028-02-29' }).totals.costCny, 3);
  assert.throws(() => createSpendReport(SAMPLE, { period: 'custom', from: '2028-02-30', to: '2028-03-01' }), RangeError);
  assert.throws(() => createSpendReport(SAMPLE, { period: 'custom', from: '2028-03-01', to: '2028-02-29' }), RangeError);
  assert.throws(() => createSpendReport(SAMPLE, { month: '2028-13' }), RangeError);
});

test('legacy readings preserve spend but do not turn missing usage into zero-valued rates', () => {
  const report = createSpendReport({
    version: 2,
    days: { '2028-02-01': { a: { request: 3, __overflow: 7 } } },
  }, MONTH);
  assert.equal(report.totals.costCny, 10);
  assert.equal(report.totals.legacyCostCny, 10);
  assert.equal(report.totals.cacheSavingsRate, null);
  assert.deepEqual(report.models, []);
});

test('HTML escapes all model fields and stays self-contained, CSV neutralizes formulas', () => {
  const record = { ...MODEL_A, provider: '<img src=x onerror=alert(1)>', model: '  =HYPERLINK("x","y")</th><script> & \'' };
  const report = createSpendReport({ version: 3, days: { '2028-02-28': { a: { request: record } } } }, MONTH);
  const html = serializeSpendReport(report, 'html', 'zh');
  assert.match(html, /<html lang="zh">/);
  assert.match(html, /<svg role="img"[^>]*><rect/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;x&quot;,&quot;y&quot;\)&lt;\/th&gt;&lt;script&gt; &amp; &#39;/);
  assert.doesNotMatch(html, /<(?:script|img|link)\b/i);
  assert.match(serializeSpendReport(report, 'csv'), /"'  =HYPERLINK\(""x"",""y""\)/);
});

test('registered report endpoint returns bounded loopback-only file downloads', { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-meter-report-'));
  const keys = ['SESSION_METER_OFFLINE', 'SESSION_METER_STATUS_FILE', 'SESSION_METER_CACHE_FILE'];
  const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SESSION_METER_OFFLINE = '1';
  process.env.SESSION_METER_STATUS_FILE = join(dir, 'status.json');
  process.env.SESSION_METER_CACHE_FILE = join(dir, 'cache.json');
  const disposers = [];
  const routes = new Map();
  const webServer = {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
  };
  apply({
    get: (key) => key === 'webServer' ? webServer : undefined,
    effect: (effect) => disposers.push(effect()),
  });
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    for (const key of keys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const route = routes.get('/session-meter/report');
  assert.equal(route.kind, 'exact');
  const server = createServer(route.handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    return closed;
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const url = origin + route.path;
  const payload = { ledger: SAMPLE, options: MONTH };
  const post = (body, headers = {}) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  for (const [format, mime] of [['html', 'text/html'], ['json', 'application/json'], ['csv', 'text/csv']]) {
    const response = await post({ ...payload, format }, { origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime + '; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="session-meter-2028-02.' + format + '"');
    assert.equal(await response.text(), serializeSpendReport(createSpendReport(SAMPLE, MONTH), format));
  }
  const method = await fetch(url, { method: 'HEAD' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal(await method.text(), '');
  const errors = [
    [403, await post({ ...payload, format: 'json' }, { origin: 'http://127.0.0.1:1234' })],
    [415, await post({ ...payload, format: 'json' }, { 'content-type': 'text/plain' })],
    [400, await post('{')],
    [400, await post({ ...payload, format: 'toString' })],
    [400, await post({ ...payload, format: 'json', options: { month: 'invalid' } })],
    [413, await post(' '.repeat(8 * 1024 * 1024 + 1))],
  ];
  for (const [status, response] of errors) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  const remote = await new Promise((resolve) => route.handler({
    method: 'POST', socket: { remoteAddress: '192.0.2.1' }, headers: {},
  }, { writeHead: resolve, end() {} }));
  assert.equal(remote, 403);
});
