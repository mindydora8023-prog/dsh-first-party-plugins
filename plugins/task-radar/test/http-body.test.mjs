import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { __internals, createHandler, REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS } from '../lib/index.js';
const { readBody } = __internals;

class Request extends EventEmitter {
  constructor(headers = {}) { super(); this.headers = headers; this.paused = false; }
  pause() { this.paused = true; }
}
function response() {
  return { status: 0, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body || ''; },
  };
}
function closeAndCheck(req) {
  req.emit('close');
  for (const name of ['data', 'end', 'error', 'close']) assert.equal(req.listenerCount(name), 0, name);
}
function handlerHarness() {
  const saved = [];
  return { saved, handler: createHandler(() => ({}), (value) => saved.push(value), [], '/fixture/config.json') };
}

test('body reader counts UTF-8 bytes and reconstructs split multibyte chunks', async () => {
  const bytes = Buffer.from('a\u4e2db');
  const req = new Request();
  const work = readBody(req, bytes.length);
  req.emit('data', bytes.subarray(0, 2));
  req.emit('data', bytes.subarray(2));
  req.emit('end');
  assert.equal(await work, 'a\u4e2db');
  assert.equal(req.listenerCount('data'), 0);
  closeAndCheck(req);
});

test('oversized chunked bodies stop buffering and return 413 without saving', async () => {
  const h = handlerHarness();
  const req = Object.assign(new Request(), { method: 'POST', url: '/api/task-radar/config' });
  const res = response();
  const work = h.handler(req, res);
  req.emit('data', Buffer.alloc(REQUEST_BODY_LIMIT));
  req.emit('data', Buffer.from('x'));
  await work;
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).reason, 'body-too-large');
  assert.equal(res.headers.connection, 'close');
  assert.equal(req.paused, true);
  assert.equal(req.listenerCount('data'), 0);
  assert.deepEqual(h.saved, []);
  assert.doesNotThrow(() => req.emit('error', new Error('late ECONNRESET')));
  closeAndCheck(req);
});

test('declared oversized bodies are rejected before data is buffered', async () => {
  const req = new Request({ 'content-length': String(REQUEST_BODY_LIMIT + 1) });
  await assert.rejects(readBody(req, REQUEST_BODY_LIMIT), { status: 413, reason: 'body-too-large' });
  assert.equal(req.listenerCount('data'), 0);
  closeAndCheck(req);
});

test('a stalled body has a finite deadline and releases listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new Request();
  const rejection = assert.rejects(readBody(req, 100, 10), { status: 408, reason: 'request-timeout' });
  t.mock.timers.tick(10);
  await rejection;
  assert.equal(req.paused, true);
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.listenerCount('end'), 0);
  closeAndCheck(req);
});

test('HTTP deadline responds 408 without saving partial JSON', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = handlerHarness();
  const req = Object.assign(new Request(), { method: 'POST', url: '/api/task-radar/config' });
  const res = response();
  const work = h.handler(req, res);
  req.emit('data', Buffer.from('{'));
  assert.ok(REQUEST_BODY_TIMEOUT_MS > 0 && REQUEST_BODY_TIMEOUT_MS <= 30000);
  t.mock.timers.tick(REQUEST_BODY_TIMEOUT_MS);
  await work;
  assert.equal(res.status, 408);
  assert.equal(JSON.parse(res.body).reason, 'request-timeout');
  assert.deepEqual(h.saved, []);
  closeAndCheck(req);
});

test('premature close, transport error and already aborted requests settle without saving', async () => {
  for (const mode of ['close', 'error', 'aborted']) {
    const h = handlerHarness();
    const req = Object.assign(new Request(), { method: 'POST', url: '/api/task-radar/config' });
    if (mode === 'aborted') req.aborted = true;
    const res = response();
    const work = h.handler(req, res);
    if (mode === 'close') req.emit('close');
    if (mode === 'error') req.emit('error', new Error('transport failure'));
    await work;
    assert.deepEqual(h.saved, []);
    if (mode === 'aborted') assert.equal(res.status, 0, 'do not write to a disconnected request');
    else assert.equal(res.status, 400);
    closeAndCheck(req);
  }
});

test('non-object JSON and invalid wrappers never reset the saved configuration', async () => {
  const h = handlerHarness();
  for (const value of [null, false, true, 3, 'text', [], { config: null }, { config: false }, { config: [] }]) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { method: 'POST', url: '/api/task-radar/config' });
    const res = response();
    await h.handler(req, res);
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.equal(JSON.parse(res.body).reason, 'invalid-config');
  }
  assert.deepEqual(h.saved, []);
});

test('malformed JSON returns bad-json and HEAD advertises content length without sending a body', async () => {
  const h = handlerHarness();
  const req = Object.assign(Readable.from([Buffer.from('{')]), { method: 'POST', url: '/api/task-radar/config' });
  const malformed = response();
  await h.handler(req, malformed);
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).reason, 'bad-json');
  const head = response();
  await h.handler({ method: 'HEAD', url: '/api/task-radar/radar' }, head);
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);
  assert.deepEqual(h.saved, []);
});

async function serverHarness(t, handler) {
  const server = createServer(handler);
  server.on('checkContinue', handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

test('real HTTP returns 413 for oversized declared and streamed uploads', { timeout: 5000 }, async (t) => {
  const h = handlerHarness();
  const port = await serverHarness(t, h.handler);
  const cases = [
    // The server can reject this from the headers. Sending the body anyway
    // races the response against a TCP reset when the server closes the socket.
    { headers: { 'content-length': String(REQUEST_BODY_LIMIT + 1), expect: '100-continue' } },
    { headers: { 'transfer-encoding': 'chunked' }, body: Buffer.alloc(REQUEST_BODY_LIMIT + 1) },
  ];
  for (const { headers, body } of cases) {
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/task-radar/config', method: 'POST', headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.on('continue', () => req.destroy(new Error('oversized upload received 100 Continue')));
      req.setTimeout(3000, () => req.destroy(new Error('fixture request timeout')));
      req.end(body);
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.body).reason, 'body-too-large');
  }
  assert.deepEqual(h.saved, []);
});

test('real client disconnect is observed and the handler terminates without saving', { timeout: 5000 }, async (t) => {
  const h = handlerHarness();
  let started;
  let finished;
  const start = new Promise((resolve) => { started = resolve; });
  const done = new Promise((resolve) => { finished = resolve; });
  const port = await serverHarness(t, (req, res) => {
    const work = h.handler(req, res);
    started();
    work.finally(finished);
  });
  const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/task-radar/config', method: 'POST',
    headers: { 'content-length': '100' } });
  req.on('error', () => {});
  req.setTimeout(3000, () => req.destroy());
  req.write('{');
  await start;
  req.destroy();
  await done;
  assert.deepEqual(h.saved, []);
});
