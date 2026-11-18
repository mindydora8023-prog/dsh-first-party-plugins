import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { adaptHandler } from '../lib/fetch-handler.js';
import { createHandler, REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS } from '../lib/index.js';

const BASE = 'http://fixture.invalid/api/task-radar';
const turn = () => new Promise((resolve) => setImmediate(resolve));
function request(path = '/config', options = {}) {
  return new Request(BASE + path, options);
}
function upload(body, options = {}) {
  return request('/config', { method: 'POST', body, duplex: 'half', ...options });
}
function source(start) {
  const state = { cancelled: false, reason: undefined };
  state.stream = new ReadableStream({
    start,
    cancel(reason) { state.cancelled = true; state.reason = reason; },
  });
  return state;
}
function realHandler() {
  let config = {};
  const saved = [];
  const handler = createHandler(() => config, (value) => {
    saved.push(value);
    config = value;
  }, [], '/fixture/config.json', () => { throw new Error('No real notifications'); }, 'fixture-journal');
  return { handler, saved };
}
function assertClean(req, input) {
  assert.equal(req.destroyed, true);
  assert.equal(req.closed, true);
  assert.deepEqual(req.eventNames(), []);
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
}

test('maps method, relative URL, headers and response status/headers/bytes', async () => {
  let seen;
  const input = request('/radar?q=1%202', { headers: { 'X-Fixture': 'present' } });
  const response = await adaptHandler(async (req, res) => {
    seen = req;
    assert.ok(req instanceof Readable);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/task-radar/radar?q=1%202');
    assert.equal(req.headers['x-fixture'], 'present');
    let chunks = 0;
    for await (const chunk of req) chunks += chunk.length;
    assert.equal(chunks, 0);
    res.writeHead(201, { 'x-result': 'created', 'content-type': 'application/octet-stream', 'set-cookie': ['a=1', 'b=2'] });
    res.end(Buffer.from([0, 255, 42]));
  })(input);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-result'), 'created');
  assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 42]));
  assertClean(seen, input);
});

test('HEAD and bodyless status codes retain headers without a response body', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304]]) {
    const input = request('/radar', { method });
    const response = await adaptHandler(async (_req, res) => {
      res.writeHead(status, 'Fixture', { 'content-length': '12', 'x-result': 'empty' });
      res.end('discard this');
    })(input);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-length'), '12');
    assert.equal(response.headers.get('x-result'), 'empty');
    assert.equal(response.body, null);
  }
});

test('streams uploads incrementally and leaves unread uploads bounded', async () => {
  let pulls = 0;
  let cancelled = false;
  const input = upload(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  }));
  let seen;
  const response = await adaptHandler(async (req, res) => {
    seen = req;
    // A handler must be reached while the unbounded source is still unread.
    await turn();
    assert.ok(pulls <= 2, `unexpected eager buffering: ${pulls}`);
    const chunk = await new Promise((resolve, reject) => {
      req.once('data', (value) => { req.pause(); resolve(value); });
      req.once('error', reject);
    });
    assert.equal(chunk.length, 65536);
    res.end('early');
  })(input);
  assert.equal(await response.text(), 'early');
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, `unexpected eager buffering: ${pulls}`);
  assertClean(seen, input);
});

test('real handler serves GET/HEAD and persists streamed JSON without notifications', async () => {
  const h = realHandler();
  const fetch = adaptHandler(h.handler);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(request('/radar', { method }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('content-length')) > 0);
    if (method === 'HEAD') assert.equal(response.body, null);
    else assert.equal((await response.json()).journalId, 'fixture-journal');
  }
  const body = source((controller) => {
    controller.enqueue(Buffer.from('{"config":'));
    controller.enqueue(Buffer.from('{"enabled":false}}'));
    controller.close();
  });
  const response = await fetch(upload(body.stream));
  assert.equal(response.status, 200);
  assert.deepEqual(h.saved, [{ enabled: false }]);
  assert.equal((await response.json()).config.enabled, false);
});

test('real handler rejects malformed and missing POST bodies', async () => {
  const h = realHandler();
  for (const input of [upload('{'), upload(undefined)]) {
    const response = await adaptHandler(h.handler)(input);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, 'bad-json');
  }
  assert.deepEqual(h.saved, []);
});

test('real 413 recycles both declared and chunked oversized paused uploads', async () => {
  for (const declared of [false, true]) {
    const h = realHandler();
    const body = source((controller) => {
      if (!declared) controller.enqueue(Buffer.alloc(REQUEST_BODY_LIMIT + 1));
    });
    const input = upload(body.stream, declared ? { headers: { 'content-length': String(REQUEST_BODY_LIMIT + 1) } } : {});
    let seen;
    const response = await adaptHandler((req, res) => { seen = req; return h.handler(req, res); })(input);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).reason, 'body-too-large');
    assert.equal(body.cancelled, true);
    assert.deepEqual(h.saved, []);
    assertClean(seen, input);
  }
});

test('real 408 recycles a stalled paused upload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = realHandler();
  const body = source((controller) => controller.enqueue(Buffer.from('{')));
  const input = upload(body.stream);
  let seen;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const work = adaptHandler((req, res) => {
    seen = req;
    const result = h.handler(req, res);
    ready();
    return result;
  })(input);
  await started;
  t.mock.timers.tick(REQUEST_BODY_TIMEOUT_MS);
  const response = await work;
  assert.equal(response.status, 408);
  assert.equal((await response.json()).reason, 'request-timeout');
  assert.equal(body.cancelled, true);
  assert.deepEqual(h.saved, []);
  assertClean(seen, input);
});

test('initial abort skips handler and cancels the source with original reason', async () => {
  for (const reason of [undefined, new Error('initial cancel'), 'cancelled']) {
    const controller = new AbortController();
    const body = source();
    const input = upload(body.stream, { signal: controller.signal });
    controller.abort(reason);
    let called = false;
    await assert.rejects(adaptHandler(() => { called = true; })(input), (error) => error === controller.signal.reason);
    assert.equal(called, false);
    assert.equal(body.cancelled, true);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
  }
});

test('abort immediately destroys the request and settles a hanging handler', async () => {
  const controller = new AbortController();
  const body = source();
  const input = upload(body.stream, { signal: controller.signal });
  const reason = new Error('active cancel');
  let seen;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const work = adaptHandler((req) => {
    seen = req;
    ready();
    return new Promise(() => {});
  })(input);
  await started;
  const rejected = assert.rejects(work, (error) => error === reason);
  controller.abort(reason);
  assert.equal(seen.aborted, true);
  assert.equal(seen.destroyed, true);
  await rejected;
  assert.equal(body.cancelled, true);
  assertClean(seen, input);
});

test('abort during real readBody has no response or unhandled error and saves nothing', async () => {
  const h = realHandler();
  const controller = new AbortController();
  const body = source((stream) => stream.enqueue(Buffer.from('{')));
  const input = upload(body.stream, { signal: controller.signal });
  let seen;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const work = adaptHandler((req, res) => {
    seen = req;
    const pending = h.handler(req, res);
    ready();
    return pending;
  })(input);
  await started;
  const rejected = assert.rejects(work, { name: 'AbortError' });
  controller.abort();
  await rejected;
  await turn();
  assert.equal(body.cancelled, true);
  assert.deepEqual(h.saved, []);
  assertClean(seen, input);
});

test('a completed response survives abort and cleanup error events', async () => {
  const controller = new AbortController();
  const body = source();
  const input = upload(body.stream, { signal: controller.signal });
  let seen;
  const response = await adaptHandler(async (req, res) => {
    seen = req;
    res.writeHead(202, { 'x-result': 'accepted' });
    res.end('done');
    controller.abort(new Error('after end'));
  })(input);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'done');
  assertClean(seen, input);
});

test('synchronous throw and handler rejection propagate after stream cleanup', async () => {
  for (const sync of [false, true]) {
    const reason = new Error(sync ? 'sync failure' : 'async failure');
    const body = source();
    const input = upload(body.stream);
    let seen;
    await assert.rejects(adaptHandler((req) => {
      seen = req;
      if (sync) throw reason;
      return Promise.reject(reason);
    })(input), (error) => error === reason);
    assert.equal(body.cancelled, true);
    assertClean(seen, input);
  }
});

test('late handler rejection after abort remains observed', async () => {
  const controller = new AbortController();
  const input = upload(source().stream, { signal: controller.signal });
  let reject;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const work = adaptHandler(() => {
    ready();
    return new Promise((_resolve, fail) => { reject = fail; });
  })(input);
  await started;
  const rejected = assert.rejects(work, { name: 'AbortError' });
  controller.abort();
  await rejected;
  reject(new Error('late failure'));
  await turn();
});

test('initial and active source errors settle real readBody and clean listeners', async () => {
  for (const initial of [false, true]) {
    const h = realHandler();
    let stream;
    const body = source((controller) => {
      stream = controller;
      if (initial) controller.error(new Error('initial source failed'));
    });
    const input = upload(body.stream);
    let seen;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const work = adaptHandler((req, res) => {
      seen = req;
      const pending = h.handler(req, res);
      ready();
      return pending;
    })(input);
    await started;
    if (!initial) stream.error(new Error('active source failed'));
    const response = await work;
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, initial ? 'request-aborted' : 'request-read-error');
    assert.deepEqual(h.saved, []);
    assertClean(seen, input);
  }
});

test('a rejecting Web cancel does not leak a cleanup error', async () => {
  const input = upload(new ReadableStream({
    cancel() { throw new Error('cancel failed'); },
  }));
  let seen;
  const response = await adaptHandler((req, res) => {
    seen = req;
    res.end('complete');
  })(input);
  assert.equal(await response.text(), 'complete');
  assertClean(seen, input);
});

test('a never-settling Web cancel cannot hold an ended response', async () => {
  let seen;
  let cancelCalled = false;
  const input = upload(new ReadableStream({
    cancel() { cancelCalled = true; return new Promise(() => {}); },
  }));
  const work = adaptHandler((req, res) => {
    seen = req;
    res.writeHead(202, { 'x-result': 'accepted' });
    res.end('complete');
  }, { cleanupTimeoutMs: 10 })(input);
  let deadline;
  const timeout = new Promise((resolve) => { deadline = setTimeout(() => resolve('timed out'), 300); });
  try {
    const response = await Promise.race([work, timeout]);
    assert.notEqual(response, 'timed out', 'cleanup must have a finite deadline');
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'complete');
    assert.equal(cancelCalled, true);
    assert.equal(seen.destroyed, true);
    assert.equal(seen.closed, false);
    assert.deepEqual(seen.eventNames().sort(), ['close', 'error']);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
  } finally {
    clearTimeout(deadline);
  }
});

test('cleanup timeout retains its error guard until a late cancel rejection closes the stream', async () => {
  let failCancel;
  let seen;
  const controller = new AbortController();
  const input = upload(new ReadableStream({
    cancel() { return new Promise((_resolve, reject) => { failCancel = reject; }); },
  }), { signal: controller.signal });
  const response = await adaptHandler((req, res) => {
    seen = req;
    res.end('complete');
    controller.abort(new Error('abort after response ended'));
  }, { cleanupTimeoutMs: 5 })(input);
  assert.equal(await response.text(), 'complete');
  assert.equal(seen.closed, false);
  assert.deepEqual(seen.eventNames().sort(), ['close', 'error']);
  assert.equal(seen.listenerCount('error'), 1);
  const events = [];
  seen.on('error', () => events.push('error'));
  const closed = new Promise((resolve) => seen.once('close', () => { events.push('close'); resolve(); }));
  failCancel(new Error('late cancel failed'));
  await closed;
  assert.deepEqual(events, ['error', 'close']);
  assertClean(seen, input);
});

test('default cleanup deadline is 1000ms and validates injected budgets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = upload(new ReadableStream({ cancel() { return new Promise(() => {}); } }));
  let settled = false;
  const work = adaptHandler((_req, res) => res.end('complete'))(input).then((response) => {
    settled = true;
    return response;
  });
  await turn();
  t.mock.timers.tick(999);
  await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = await work;
  assert.equal(await response.text(), 'complete');
  for (const cleanupTimeoutMs of [-1, 1001, 1.5, NaN, Infinity]) {
    assert.throws(() => adaptHandler(() => {}, { cleanupTimeoutMs }), RangeError);
  }
});

test('abort with a hanging Web cancel preserves its reason after bounded cleanup', async () => {
  const controller = new AbortController();
  const input = upload(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { signal: controller.signal });
  let seen;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const work = adaptHandler((req) => {
    seen = req;
    ready();
    return new Promise(() => {});
  }, { cleanupTimeoutMs: 5 })(input);
  await started;
  const reason = new Error('cancel with stalled cleanup');
  const rejected = assert.rejects(work, (error) => error === reason);
  controller.abort(reason);
  assert.equal(seen.destroyed, true);
  await rejected;
  assert.equal(seen.closed, false);
  assert.deepEqual(seen.eventNames().sort(), ['close', 'error']);
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
});

test('missing end fails explicitly and releases unread request resources', async () => {
  const input = upload(source().stream);
  let seen;
  await assert.rejects(adaptHandler((req) => { seen = req; })(input), /without ending/);
  assertClean(seen, input);
  assert.throws(() => adaptHandler(null), TypeError);
});
