import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, createHandler } from '../lib/index.js';

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'task-radar-save-'));
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify({ titlePrefix: 'Original' }));
  const previous = process.env.TASK_RADAR_CONFIG_FILE;
  process.env.TASK_RADAR_CONFIG_FILE = file;
  const disposers = [];
  const handlers = new Map();
  const ctx = {
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject(_names, fn) { fn(ctx); },
    connection: { fetch: { register(route) { handlers.set(route.path, route.fetch); return () => {}; } } },
  };
  try { apply(ctx); } finally {
    if (previous === undefined) delete process.env.TASK_RADAR_CONFIG_FILE;
    else process.env.TASK_RADAR_CONFIG_FILE = previous;
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const fn of [...disposers].reverse()) fn();
  }
  t.after(() => {
    dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  async function handle(req) {
    const res = await handlers.get(new URL(req.url).pathname)(req);
    return { status: res.status, body: await res.json() };
  }
  async function request(config) {
    return handle(new Request('http://fixture/api/task-radar/' + (config === undefined ? 'radar' : 'config'),
      config === undefined ? {} : { method: 'POST', body: JSON.stringify({ config }) }));
  }
  return { directory, file, request, dispose, handle };
}

test('saved configuration is normalized on disk and in memory without temporary artifacts', async (t) => {
  const h = harness(t);
  const saved = await h.request({ titlePrefix: '  Updated  ', cooldownMs: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.titlePrefix, 'Updated');
  assert.equal(saved.body.config.cooldownMs, 0);
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')), saved.body.config);
  assert.deepEqual((await h.request()).body.config, saved.body.config);
  assert.deepEqual(readdirSync(h.directory), ['config.json']);
});

test('numeric settings retain the same finite values in memory, response and saved JSON', async (t) => {
  const h = harness(t);
  for (const input of [
    { summaryMaxChars: '1e999', cooldownMs: '1e999' },
    { summaryMaxChars: '1e308', cooldownMs: '1e308' },
    { summaryMaxChars: '0.5', cooldownMs: '0' },
  ]) {
    const saved = await h.request(input);
    assert.equal(saved.status, 200);
    const stored = JSON.parse(readFileSync(h.file, 'utf8'));
    assert.equal(Number.isInteger(stored.summaryMaxChars), true);
    assert.equal(Number.isInteger(stored.cooldownMs), true);
    assert.deepEqual(stored, saved.body.config);
    assert.deepEqual((await h.request()).body.config, stored);
    const again = await h.request(stored);
    assert.deepEqual(again.body.config, stored);
  }
});

test('route disposal prevents configuration writes during streamed body reading', async (t) => {
  const h = harness(t);
  let stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const req = new Request('http://fixture/api/task-radar/config', { method: 'POST', body, duplex: 'half' });
  const work = h.handle(req);
  stream.enqueue(Buffer.from(JSON.stringify({ config: { titlePrefix: 'Must not save after unload' } })));
  h.dispose();
  const res = await work;
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'plugin-unloaded');
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).titlePrefix, 'Original');
  assert.deepEqual(readdirSync(h.directory), ['config.json']);
});

test('lifetime cancellation after body completion prevents a configuration commit', async () => {
  const lifetime = new AbortController();
  const saved = [];
  const handler = createHandler(() => ({}), (value) => saved.push(value), [], '/fixture/config.json', () => false, 'generation', lifetime.signal);
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/task-radar/config', pause() {} });
  const res = { status: 0, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const work = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ config: { titlePrefix: 'Must not commit' } })));
  req.emit('end');
  lifetime.abort();
  await work;
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'plugin-unloaded');
  assert.deepEqual(saved, []);
  req.emit('close');
  for (const name of ['data', 'end', 'error', 'close']) assert.equal(req.listenerCount(name), 0);
});

test('a retained route handler stops serving and saving after its scope is disposed', async (t) => {
  const h = harness(t);
  h.dispose();
  for (const config of [undefined, { titlePrefix: 'Must not activate' }]) {
    const res = await h.request(config);
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'plugin-unloaded');
  }
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).titlePrefix, 'Original');
});

test('failed atomic replacement reports failure, preserves active settings and removes temporary files', async (t) => {
  const h = harness(t);
  const original = (await h.request()).body.config;
  const backup = join(h.directory, 'previous.json');
  renameSync(h.file, backup);
  mkdirSync(h.file); // A directory cannot be replaced by the config file on any supported OS.
  const failed = await h.request({ titlePrefix: 'Must not activate', enabled: false });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  assert.deepEqual((await h.request()).body.config, original);
  assert.equal(JSON.parse(readFileSync(backup, 'utf8')).titlePrefix, 'Original');
  assert.deepEqual(readdirSync(h.directory).sort(), ['config.json', 'previous.json']);
  rmSync(h.file, { recursive: true });
  renameSync(backup, h.file);
  const recovered = await h.request({ titlePrefix: 'Recovered' });
  assert.equal(recovered.status, 200);
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).titlePrefix, 'Recovered');
});

test('failed parent directory creation also leaves active configuration intact', async (t) => {
  const h = harness(t);
  const original = (await h.request()).body.config;
  const moved = h.directory + '-moved';
  renameSync(h.directory, moved);
  writeFileSync(h.directory, 'blocked parent');
  try {
    const failed = await h.request({ titlePrefix: 'Must not activate' });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.ok, false);
    assert.deepEqual((await h.request()).body.config, original);
    assert.equal(JSON.parse(readFileSync(join(moved, 'config.json'), 'utf8')).titlePrefix, 'Original');
  } finally {
    rmSync(h.directory, { force: true });
    renameSync(moved, h.directory);
  }
});
