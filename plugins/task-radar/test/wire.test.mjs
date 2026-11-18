import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function harness(t, config = {}, carrier = true) {
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
    get: (name) => name === 'connection' ? ctx.connection : undefined,
    connection: carrier ? { fetch: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } } : undefined,
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
  function finish(target = session, reason = 'completed', prompt = null) {
    status('running', target);
    event('turn/start', { turn: 1 }, target);
    if (prompt !== null) event('user/message', { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }, target);
    event('turn/end', { turn: 1, reason: { kind: reason } }, target);
    status('idle', target);
  }
  async function journal() {
    const route = routes.find((item) => item.path === '/api/task-radar/radar');
    const res = await route.fetch(new Request('http://fixture' + route.path));
    return (await res.json()).journal;
  }
  return { handlers, routes, sends, debug, session, event, status, finish, journal, dispose,
    advance: (ms) => { now += ms; } };
}

test('native lifecycle notifications remain active without a browser Connection service', (t) => {
  const h = harness(t, {}, false);
  h.finish();
  assert.equal(h.sends.length, 1);
  assert.equal(h.routes.length, 0);
});

test('browser endpoints register only on authenticated Connection Fetch routes', (t) => {
  const h = harness(t);
  assert.deepEqual(h.routes.map((route) => [route.path, route.methods, route.requestBody]), [
    ['/api/task-radar/radar', ['GET', 'HEAD'], 'buffered'],
    ['/api/task-radar/config', ['POST'], 'streaming'],
    ['/api/task-radar/test', ['POST'], 'streaming'],
  ]);
});

test('finished lifecycle dispatches the injected Toast sender and browser journal once', async (t) => {
  const h = harness(t);
  h.finish(h.session, 'completed', '  finish this\n task ');
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
  h.event('tool/result', { message: { role: 'tool', toolCallId: 'other', source: { kind: 'tool', callId: 'other' }, content: [] } });
  h.event('tool/result', { message: { role: 'tool', toolCallId: 'q1', source: { kind: 'tool', callId: 'q1' }, content: [] } });
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

test('subagent origin is filtered without depth while an independent fork remains a root', (t) => {
  const h = harness(t);
  h.finish({ id: 'legacy-child', header: { origin: 'subagent' } });
  h.finish({ id: 'child-with-zero-depth', header: { origin: 'subagent', delegationDepth: 0 } });
  assert.equal(h.sends.length, 0);
  h.finish({ id: 'ordinary-fork', header: { parentSession: 'historical-source', isSeeded: true } });
  assert.equal(h.sends.length, 1);
});

test('switching rootsOnly on also filters disposal of an already tracked child', async (t) => {
  const h = harness(t, { rootsOnly: false });
  const child = { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } };
  h.status('running', child);
  h.event('turn/start', { turn: 1 }, child);
  const req = new Request('http://fixture/api/task-radar/config', {
    method: 'POST', body: JSON.stringify({ config: { rootsOnly: true } }),
  });
  const res = await h.routes.find((item) => item.path === '/api/task-radar/config').fetch(req);
  assert.equal(res.status, 200);
  h.handlers.get('agent/disposed')({ agent: { id: child.id, session: child } });
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.journal(), []);
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
  const entries = await h.journal();
  assert.equal(entries.length, 24);
  assert.deepEqual(entries.map((entry) => entry.sequence), Array.from({ length: 24 }, (_, i) => i + 7));
  assert.equal(h.handlers.size, 3);
  h.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.routes.length, 0);
  h.finish();
  assert.equal(h.sends.length, 30);
});

test('same-millisecond host events receive distinct monotonic sequences', async (t) => {
  const h = harness(t, { cooldownMs: 0 });
  h.finish();
  h.finish();
  const entries = await h.journal();
  assert.equal(entries[0].at, entries[1].at);
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
});

test('runtime context and skill injections do not overwrite the admitted user task summary', (t) => {
  const h = harness(t);
  h.status('running');
  h.event('turn/start', { turn: 1 });
  h.event('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the notification engine' }] });
  for (const kind of ['runtime-context', 'skill', 'unknown-plugin']) {
    h.event('user/message', { id: kind, role: 'user', source: { kind }, content: [{ type: 'text', text: 'Injected internal context' }] });
  }
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  h.status('idle');
  assert.match(h.sends[0].payload.body, /Review the notification engine/);
  assert.equal(h.sends[0].payload.body.includes('Injected internal context'), false);
});

test('a new running interval does not reuse the previous task summary in start or finish notifications', (t) => {
  const h = harness(t, { cooldownMs: 0, events: { turnStart: true } });
  h.finish(h.session, 'completed', 'Previous task');
  assert.match(h.sends[1].payload.body, /Previous task/);
  h.finish();
  assert.equal(h.sends.length, 4);
  for (const send of h.sends.slice(2)) assert.equal(send.payload.body.includes('Previous task'), false);
});

test('an idle transition clears unresolved question state before the next run', (t) => {
  const h = harness(t, { cooldownMs: 0 });
  h.status('running');
  h.event('turn/start', { turn: 1 });
  h.event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Old question?' }] }) });
  h.event('turn/end', { turn: 1, reason: { kind: 'aborted' } });
  h.status('idle');
  h.status('running');
  h.handlers.get('agent/disposed')({ agent: { id: 's1', session: h.session } });
  assert.equal(h.sends.at(-1).payload.body.includes('Old question?'), false);
});

test('an unrelated tool result keeps the question pending until its matching result arrives', (t) => {
  const h = harness(t, { cooldownMs: 0 });
  h.status('running');
  h.event('turn/start', { turn: 1 });
  h.event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Still pending?' }] }) });
  h.event('tool/result', { message: { toolCallId: 'other', source: { kind: 'tool', callId: 'other' }, content: [] } });
  h.handlers.get('agent/disposed')({ agent: { id: 's1', session: h.session } });
  assert.match(h.sends.at(-1).payload.body, /Still pending/);
});

test('clock rollback does not suppress the next finished notification for the whole rollback duration', (t) => {
  const h = harness(t);
  h.finish();
  h.advance(-10000);
  h.finish();
  assert.equal(h.sends.length, 2);
  h.advance(1000);
  h.finish();
  assert.equal(h.sends.length, 2, 'normal cooldown still applies after rollback');
});
