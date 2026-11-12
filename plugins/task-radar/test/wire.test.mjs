import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function harness(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-radar-wire-'));
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  const previous = process.env.TASK_RADAR_CONFIG_FILE;
  process.env.TASK_RADAR_CONFIG_FILE = file;
  const handlers = new Map();
  const disposers = [];
  const sends = [];
  const routes = [];
  const debug = [];
  let now = 100000;
  const ctx = {
    logger: { warn() {}, debug: (line) => debug.push(line) },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject(_names, fn) { fn(ctx); },
    get: (name) => name === 'webServer' ? ctx.webServer : undefined,
    webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
    agents: { list: () => [] },
    workspaceRegistry: { list: () => [{ sessionIds: ['s1'], title: 'WS' }] },
    sessionTitle: { get: () => ({ title: 'Sess' }) },
  };
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const fn of disposers.reverse()) fn();
  }
  t.after(() => {
    dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    apply(ctx, { toastSender: (_context, cfg, payload) => { sends.push({ cfg, payload }); return true; }, now: () => now });
  } finally {
    if (previous === undefined) delete process.env.TASK_RADAR_CONFIG_FILE;
    else process.env.TASK_RADAR_CONFIG_FILE = previous;
  }
  const session = { id: 's1', header: { delegationDepth: 0, cwd: '/fixture/project' } };
  const event = (type, data, target = session) => handlers.get('session/event')?.(target, { type, data });
  const status = (value, target = session) => handlers.get('agent/status')?.({ agent: { id: target.id, session: target }, status: value });
  function finish(target = session, reason = 'completed') {
    event('turn/start', undefined, target);
    status('running', target);
    event('turn/end', { reason: { kind: reason } }, target);
    status('idle', target);
  }
  async function journal() {
    const res = { writeHead() {}, end(body) { this.body = body; } };
    await routes[0].handler({ method: 'GET', url: '/task-radar/radar' }, res);
    return JSON.parse(res.body).journal;
  }
  return { handlers, routes, sends, debug, session, event, status, finish, journal, dispose,
    advance: (ms) => { now += ms; } };
}

test('finished lifecycle dispatches the injected Toast sender and browser journal once', async (t) => {
  const h = harness(t);
  h.event('user/message', { message: { content: [{ type: 'text', text: '  finish this\n task ' }] } });
  h.finish();
  h.status('idle');
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].payload.title, /Turn finished/);
  assert.match(h.sends[0].payload.body, /finish this task/);
  assert.match(h.sends[0].payload.location, /WS/);
  const entries = await h.journal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'finished');
  assert.equal(entries[0].session, 's1');
  assert.equal(h.debug.length, 1);
});

test('question waiting fires during running, and matching result clears stale question state', (t) => {
  const h = harness(t);
  h.event('turn/start');
  h.status('running');
  h.event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Pick one?' }] }) });
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].payload.title, /Waiting for you/);
  assert.match(h.sends[0].payload.body, /Pick one\?/);
  h.event('tool/result', { message: { callId: 'other' } });
  h.event('tool/result', { message: { callId: 'q1' } });
  h.advance(5000);
  h.handlers.get('agent/disposed')({ agent: { id: 's1', session: h.session } });
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].payload.body.includes('Pick one?'), false);
});

test('cooldown suppresses repeated kind per session and permits later notifications', async (t) => {
  const h = harness(t, { cooldownMs: 4000 });
  h.finish();
  h.advance(2000);
  h.finish();
  assert.equal(h.sends.length, 1);
  h.advance(2001);
  h.finish();
  assert.equal(h.sends.length, 2);
  assert.equal((await h.journal()).length, 2);
});

test('rootsOnly ignores nested sessions; disabling it includes nested sessions', async (t) => {
  const nested = { id: 'child', header: { delegationDepth: 1, cwd: '/fixture/child' } };
  const roots = harness(t);
  roots.finish(nested);
  assert.equal(roots.sends.length, 0);
  assert.deepEqual(await roots.journal(), []);
  const all = harness(t, { rootsOnly: false });
  all.finish(nested);
  assert.equal(all.sends.length, 1);
});

test('global disable and per-event disable suppress both channels', async (t) => {
  for (const config of [{ enabled: false }, { events: { finished: false } }]) {
    const h = harness(t, config);
    h.finish();
    assert.equal(h.sends.length, 0);
    assert.deepEqual(await h.journal(), []);
  }
});

test('disabling host Toast keeps the independent browser journal', async (t) => {
  const h = harness(t, { toast: { enabled: false }, system: { enabled: true } });
  h.finish();
  assert.equal(h.sends.length, 0);
  assert.equal((await h.journal()).length, 1);
});

test('turn end maps aborted and error reasons, while inactive idle transitions stay silent', async (t) => {
  const h = harness(t);
  h.status('running');
  h.status('idle');
  assert.equal(h.sends.length, 0);
  h.finish(h.session, 'aborted');
  h.finish(h.session, 'error');
  assert.deepEqual((await h.journal()).map((entry) => entry.kind), ['aborted', 'error']);
});

test('journal stays bounded and lifecycle listeners and route are disposed', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 30; i += 1) { h.advance(5000); h.finish(); }
  assert.equal((await h.journal()).length, 24);
  assert.equal(h.handlers.size, 3);
  h.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.routes.length, 0);
  h.finish();
  assert.equal(h.sends.length, 30);
});
