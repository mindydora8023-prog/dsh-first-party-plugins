import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { __internals } from '../lib/index.js';
import { DEFAULTS } from '../lib/config.js';

const { readJsonBody, createHandler, BODY_TIMEOUT_MS } = __internals;
const LIMIT = 64 * 1024;
const never = () => new Promise(() => {});

async function bounded(work, timeout = 800) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('body operation did not settle')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nodeRequest(chunks, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

function trackedReader(read, cancel = async () => {}) {
  const calls = { cancel: 0, release: 0, read: 0 };
  return {
    calls,
    body: { getReader() { return {
      read() { calls.read += 1; return read(calls.read); },
      cancel() { calls.cancel += 1; return cancel(); },
      releaseLock() { calls.release += 1; },
    }; } },
  };
}

async function withRoute(run, rejection) {
  const dir = mkdtempSync(join(tmpdir(), 'next-say-http-body-'));
  const state = { file: join(dir, 'settings.json'), settings: { ...DEFAULTS } };
  const calls = { auth: 0, sessions: 0, prepare: 0 };
  const services = {
    connection: { requestRejection() { calls.auth += 1; return rejection; } },
    sessions: { get() { calls.sessions += 1; return undefined; } },
    llm: { prepareCall() { calls.prepare += 1; throw new Error('unexpected prediction'); } },
  };
  const handler = createHandler({ get: (name) => services[name] }, state);
  const hit = async (request, path = 'predict', timeout = 800) => {
    const response = {
      writeHead(status) { this.status = status; },
      end(payload) { this.body = JSON.parse(payload); },
    };
    await bounded(handler({ method: 'POST', url: `/next-say/${path}`, ...request }, response), timeout);
    return { status: response.status, body: response.body };
  };
  try {
    await run({ hit, state, calls });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expected(status, reason) {
  return { status, body: { ok: false, reason } };
}

for (const path of ['settings', 'predict']) {
  test(`${path}: malformed and non-object JSON fail before side effects`, async () => {
    await withRoute(async ({ hit, calls, state }) => {
      for (const body of ['null', '[]', '42', 'true', '"secret-value"', '{"secret-value":', '', '  ']) {
        const result = await hit(nodeRequest([body]), path);
        assert.deepEqual(result, expected(400, 'invalid-body'));
      }
      assert.equal(state.settings.enabled, DEFAULTS.enabled);
      assert.equal(calls.sessions, 0);
      assert.equal(calls.prepare, 0);
      assert.throws(() => readFileSync(state.file), { code: 'ENOENT' });
    });
  });

  test(`${path}: decoded bodies obey object and UTF-8 limits`, async () => {
    await withRoute(async ({ hit, state, calls }) => {
      const cyclic = {};
      cyclic.self = cyclic;
      for (const body of [null, [], 7, false, new Date(), cyclic, { toJSON: () => null }]) {
        assert.deepEqual(await hit({ body }, path), expected(400, 'invalid-body'));
      }
      assert.deepEqual(await hit({ body: { draft: '\u4e2d'.repeat(24000) } }, path),
        expected(413, 'body-too-large'));
      assert.equal(calls.sessions, 0);
      assert.equal(calls.prepare, 0);
      assert.throws(() => readFileSync(state.file), { code: 'ENOENT' });
    });
  });

  test(`${path}: declared length accepts Node and Fetch headers`, async () => {
    await withRoute(async ({ hit }) => {
      for (const headers of [
        { 'content-length': String(LIMIT + 1) },
        { 'Content-Length': String(LIMIT + 1) },
        new Headers({ 'content-length': String(LIMIT + 1) }),
      ]) {
        assert.deepEqual(await hit({ headers, body: '{}' }, path), expected(413, 'body-too-large'));
      }
    });
  });
}

test('actual UTF-8 byte cap covers string, Node chunks, bytes and Fetch streams', async () => {
  const exact = JSON.stringify({ draft: '\u4e2d'.repeat(21840) + 'x'.repeat(4) });
  assert.equal(Buffer.byteLength(exact), LIMIT);
  const over = JSON.stringify({ draft: '\u4e2d'.repeat(21841) + 'x'.repeat(4) });
  assert.ok(over.length < LIMIT);
  await withRoute(async ({ hit }) => {
    const exactResult = await hit({ body: exact });
    assert.equal(exactResult.body.reason, 'missing-session');
    assert.equal(exactResult.status, 400);
    for (const request of [
      { body: over },
      { body: Buffer.from(over) },
      nodeRequest([over.slice(0, 100), over.slice(100)], { 'content-length': '2' }),
      { headers: new Headers({ 'content-length': '2' }), body: new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(over)); controller.close(); },
      }) },
    ]) {
      assert.deepEqual(await hit(request), expected(413, 'body-too-large'));
    }
  });
});

test('Fetch chunk boundaries preserve multibyte JSON and release the native lock', async () => {
  const bytes = Buffer.from('{"draft":"\u4e2d"}');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.deepEqual(await bounded(readJsonBody({ body: stream })), { draft: '\u4e2d' });
  assert.equal(stream.locked, false);
});

test('Fetch read errors and overflow cancel then release without leaking carrier errors', async () => {
  await withRoute(async ({ hit }) => {
    for (const [read, status, reason] of [
      [() => Promise.reject(Object.assign(new Error('secret-value'), { code: 'secret-code', status: 599 })), 400, 'invalid-body'],
      [() => Promise.resolve({ done: false, value: Buffer.alloc(LIMIT + 1) }), 413, 'body-too-large'],
    ]) {
      const tracked = trackedReader(read, never);
      assert.deepEqual(await hit({ body: tracked.body }), expected(status, reason));
      assert.equal(tracked.calls.cancel, 1);
      assert.equal(tracked.calls.release, 1);
      assert.equal(tracked.calls.read, 1);
    }
  });
});

test('native Fetch reader releases its lock after overflow and read rejection', async () => {
  for (const fail of [false, true]) {
    const stream = new ReadableStream({ start(controller) {
      if (fail) controller.error(new Error('secret-value'));
      else controller.enqueue(Buffer.alloc(LIMIT + 1));
    } });
    await assert.rejects(bounded(readJsonBody({ body: stream })), { status: fail ? 400 : 413 });
    assert.equal(stream.locked, false);
  }
});

test('reader total deadline bounds stalled Fetch and Node cleanup', async () => {
  const tracked = trackedReader(never, never);
  await assert.rejects(bounded(readJsonBody({ body: tracked.body }, LIMIT, 20)),
    { status: 408, code: 'body-timeout' });
  assert.equal(tracked.calls.cancel, 1);
  assert.equal(tracked.calls.release, 1);
  let returned = 0;
  const request = { [Symbol.asyncIterator]() { return {
    next: never,
    return() { returned += 1; return never(); },
  }; } };
  await assert.rejects(bounded(readJsonBody(request, LIMIT, 20)), { status: 408, code: 'body-timeout' });
  assert.equal(returned, 1);
});

test('empty chunks use one deadline race for the entire body', async (t) => {
  const tracked = trackedReader(async () => ({ done: false, value: new Uint8Array() }));
  const originalRace = Promise.race;
  let races = 0;
  const race = t.mock.method(Promise, 'race', function (values) {
    races += 1;
    return Reflect.apply(originalRace, this, [values]);
  });
  try {
    await assert.rejects(readJsonBody({ body: tracked.body }, LIMIT, 20),
      { status: 408, code: 'body-timeout' });
  } finally {
    race.mock.restore();
  }
  assert.ok(tracked.calls.read > 1);
  assert.equal(races, 1);
  assert.equal(tracked.calls.cancel, 1);
  assert.equal(tracked.calls.release, 1);
});

test('late reader result is never inspected after the deadline', async () => {
  let finishRead;
  let inspected = 0;
  const tracked = trackedReader(() => new Promise((resolve) => { finishRead = resolve; }));
  await assert.rejects(bounded(readJsonBody({ body: tracked.body }, LIMIT, 20)),
    { status: 408, code: 'body-timeout' });
  finishRead({
    get done() { inspected += 1; return false; },
    get value() { inspected += 1; return Buffer.from('{}'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspected, 0);
  assert.equal(tracked.calls.read, 1);
  assert.equal(tracked.calls.cancel, 1);
  assert.equal(tracked.calls.release, 1);
});

test('handler body deadline ends before settings writes or prediction lifecycle changes', async () => {
  assert.ok(BODY_TIMEOUT_MS > 0 && BODY_TIMEOUT_MS <= 10000);
  await withRoute(async ({ hit, state, calls }) => {
    let finishRead;
    const tracked = trackedReader(() => new Promise((resolve) => { finishRead = resolve; }), never);
    assert.deepEqual(await hit({ body: tracked.body }, 'settings', BODY_TIMEOUT_MS + 1000),
      expected(408, 'body-timeout'));
    finishRead({ done: false, value: Buffer.from('{"enabled":false}') });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tracked.calls.read, 1);
    assert.equal(state.settings.enabled, DEFAULTS.enabled);
    assert.equal(tracked.calls.cancel, 1);
    assert.equal(tracked.calls.release, 1);
    assert.equal(calls.sessions, 0);
    assert.equal(calls.prepare, 0);
    assert.throws(() => readFileSync(state.file), { code: 'ENOENT' });
  });
});

test('authentication rejection precedes body reads', async () => {
  for (const rejection of [401, 403]) {
    await withRoute(async ({ hit, calls }) => {
      const tracked = trackedReader(() => { throw new Error('body read before auth'); });
      assert.deepEqual(await hit({ body: tracked.body }),
        expected(rejection, rejection === 401 ? 'unauthorized' : 'forbidden'));
      assert.equal(tracked.calls.read, 0);
      assert.equal(calls.auth, 1);
    }, rejection);
  }
});

test('valid decoded settings and Fetch JSON preserve route behavior', async () => {
  await withRoute(async ({ hit, state }) => {
    const settings = await hit({ body: { enabled: false } }, 'settings');
    assert.equal(settings.status, 200);
    assert.equal(JSON.parse(readFileSync(state.file, 'utf8')).enabled, false);
    const request = new Request('http://next-say.invalid/next-say/predict', {
      method: 'POST', body: JSON.stringify({ sessionId: 'body-test' }),
    });
    assert.deepEqual(await hit({ body: request.body, headers: request.headers }), expected(200, 'disabled'));
    assert.equal(request.body.locked, false);
  });
});
