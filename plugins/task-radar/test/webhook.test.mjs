/**
 * Generic webhook channel: config normalization, bounded sender, and wiring.
 * No real network: fetch is injected, and the wiring drives events through a
 * fake ctx exactly like wire.test.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, createWebhookSender } from '../lib/index.js';
import { normalizeConfig } from '../lib/config.js';

test('normalizeConfig accepts only http(s) webhook URLs and round-trips enabled', () => {
  const on = normalizeConfig({ webhook: { enabled: true, url: 'https://example.com/hook' } });
  assert.equal(on.webhook.enabled, true);
  assert.equal(on.webhook.url, 'https://example.com/hook');
  assert.equal(normalizeConfig({ webhook: { enabled: true, url: 'ftp://x/y' } }).webhook.url, '');
  assert.equal(normalizeConfig({ webhook: { enabled: true, url: 'javascript:alert(1)' } }).webhook.url, '');
  assert.equal(normalizeConfig({ webhook: { enabled: true, url: '  not a url ' } }).webhook.url, '');
  assert.equal(normalizeConfig({}).webhook.enabled, false);
});

test('createWebhookSender POSTs JSON to the configured URL', async () => {
  const calls = [];
  const send = createWebhookSender({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  const sent = send({ logger: { warn() {} } }, { webhook: { enabled: true, url: 'https://example.com/hook' } }, {
    title: 'T', body: 'B', location: 'L', kind: 'finished', session: 's1', at: 123,
  });
  assert.equal(sent, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/hook');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.title, 'T');
  assert.equal(body.kind, 'finished');
  assert.equal(body.session, 's1');
});

test('createWebhookSender skips empty url and swallows fetch failures', async () => {
  let called = 0;
  const skipped = createWebhookSender({ fetchImpl: async () => { called += 1; return { ok: true }; } });
  assert.equal(skipped({ logger: { warn() {} } }, { webhook: { enabled: true, url: '' } }, {}), false);
  const failing = createWebhookSender({ fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(failing({ logger: { warn() {} } }, { webhook: { enabled: true, url: 'https://x/y' } }, {}), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(called, 0);
});

test('apply() fires the injected webhook sender on a finished turn', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-radar-webhook-'));
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify({ schema: 2, webhook: { enabled: true, url: 'https://example.com/hook' } }));
  const previous = process.env.TASK_RADAR_CONFIG_FILE;
  process.env.TASK_RADAR_CONFIG_FILE = file;

  const handlers = new Map();
  const disposers = [];
  const hooks = [];
  const ctx = {
    logger: { warn() {}, debug() {} },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    inject(_names, fn) { fn(ctx); },
    get: () => undefined,
    agents: { list: () => [] },
    workspaceRegistry: { list: () => [{ sessionIds: ['s1'], title: 'WS' }] },
    sessionTitle: { get: () => ({ title: 'Sess' }) },
  };
  try {
    apply(ctx, {
      toastSender: () => true,
      webhookSender: (_c, cfg, payload) => { hooks.push({ cfg, payload }); return true; },
      now: () => 100000,
    });
  } finally {
    if (previous === undefined) delete process.env.TASK_RADAR_CONFIG_FILE;
    else process.env.TASK_RADAR_CONFIG_FILE = previous;
  }
  t.after(() => { for (const d of disposers.reverse()) d(); rmSync(directory, { recursive: true, force: true }); });

  const session = { id: 's1', header: { delegationDepth: 0, cwd: '/fixture/project' } };
  const event = (type, data) => handlers.get('session/event')?.(session, { type, data });
  const status = (value) => handlers.get('agent/status')?.({ agent: { id: 's1', session }, status: value });
  status('running');
  event('turn/start', { turn: 1 });
  event('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'build it' }] });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  status('idle');

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.kind, 'finished');
  assert.match(hooks[0].payload.title, /dsh/);
});
