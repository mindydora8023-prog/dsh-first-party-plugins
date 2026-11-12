/**
 * Host-half pure helpers + the HTTP handler, driven against a fake res object.
 * No real server, no real network, no OS side effects.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { __internals, createHandler } from '../lib/index.js';
const {
  REASON_KIND,
  resolveWorkspaceLabel,
  resolveSessionLabel,
  composeLocation,
  summarizePrompt,
  extractQuestion,
} = __internals;

test('REASON_KIND maps turn-end kinds to event kinds', () => {
  assert.equal(REASON_KIND.completed, 'finished');
  assert.equal(REASON_KIND.aborted, 'aborted');
  assert.equal(REASON_KIND.interrupted, 'aborted');
  assert.equal(REASON_KIND.error, 'error');
  assert.equal(REASON_KIND['max-tokens'], 'error');
  assert.equal(REASON_KIND.blocked, 'aborted');
});

test('resolveWorkspaceLabel prefers workspaceRegistry title', () => {
  const ctx = { workspaceRegistry: { list: () => [{ sessionIds: ['s1'], title: 'My Project', path: '/x/y' }] } };
  assert.equal(resolveWorkspaceLabel(ctx, { id: 's1' }), 'My Project');
});

test('resolveWorkspaceLabel falls back to cwd basename', () => {
  assert.equal(resolveWorkspaceLabel({}, { id: 's2', header: { cwd: 'C:\\work\\proj' } }), 'proj');
});

test('resolveSessionLabel uses sessionTitle then session/title then id', () => {
  assert.equal(resolveSessionLabel({ sessionTitle: { get: () => ({ title: 'Title A' }) } }, { id: 's1' }), 'Title A');
  const session = { id: 'abcdef123', events: [{ type: 'session/title', data: { title: 'Event Title' } }] };
  assert.equal(resolveSessionLabel({ sessionTitle: { get: () => undefined } }, session), 'Event Title');
  assert.equal(resolveSessionLabel({}, { id: 'abcdef123' }), '#abcdef12');
});

test('composeLocation joins workspace and session', () => {
  assert.equal(composeLocation('P', 'S'), '\u5de5\u4f5c\u533a\u300cP\u300d \u00b7 \u4f1a\u8bdd\u300cS\u300d');
  assert.equal(composeLocation('', 'S'), '\u4f1a\u8bdd\u300cS\u300d');
  assert.equal(composeLocation('P', ''), '\u5de5\u4f5c\u533a\u300cP\u300d');
});

test('summarizePrompt takes the first text block and collapses whitespace', () => {
  assert.equal(summarizePrompt({ content: [{ type: 'text', text: '  hello\n\n world  ' }] }, 48), 'hello world');
  assert.equal(summarizePrompt({ content: [] }, 48), '');
  assert.equal(summarizePrompt({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 10).length, 11);
});

test('extractQuestion pulls the first question from tool arguments', () => {
  assert.equal(extractQuestion(JSON.stringify({ questions: [{ question: 'Pick one?' }] })), 'Pick one?');
  assert.equal(extractQuestion('not json'), '');
});

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

test('handler serves radar with the current config', async () => {
  const cfg = { enabled: true, system: { enabled: true } };
  const handler = createHandler(() => cfg, () => {}, [], 'C:/tmp/cfg.json');
  const res = fakeRes();
  await handler({ method: 'GET', url: '/task-radar/radar' }, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.config.enabled, true);
  assert.deepEqual(payload.journal, []);
});

test('handler persists a valid config', async () => {
  let saved = null;
  const handler = createHandler(() => ({}), (v) => { saved = v; }, [], 'C:/tmp/cfg.json');
  const req = {
    method: 'POST',
    url: '/task-radar/config',
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ config: { events: { finished: false }, system: { enabled: false } } })));
      if (event === 'end') cb();
    },
  };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.equal(saved.events.finished, false);
  assert.equal(saved.system.enabled, false);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('test endpoint submits only the injected Windows channel and leaves journal untouched', async () => {
  const cfg = { titlePrefix: 'Fixture', toast: { enabled: true } };
  const journal = [{ kind: 'finished', at: 1 }];
  const sends = [];
  const handler = createHandler(() => cfg, () => {}, journal, '/fixture/cfg.json', (_ctx, actual, payload) => {
    sends.push({ actual, payload });
    return true;
  });
  const res = fakeRes();
  await handler({ method: 'POST', url: '/task-radar/test' }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, submitted: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].actual, cfg);
  assert.match(sends[0].payload.body, /Windows/);
  assert.match(sends[0].payload.body, /\u8bf7\u6c42\u5df2\u63d0\u4ea4/);
  assert.equal(journal.length, 1, 'test request does not fan out to browser journal');
});

test('test endpoint reports no submission when Toast is disabled or sender declines', async () => {
  const disabled = createHandler(() => ({ toast: { enabled: false } }), () => {}, [], '/fixture/cfg.json', () => {
    throw new Error('disabled Toast must not dispatch');
  });
  const first = fakeRes();
  await disabled({ method: 'POST', url: '/task-radar/test' }, first);
  assert.deepEqual(JSON.parse(first.body), { ok: true, submitted: false });
  const unsupported = createHandler(() => ({ toast: { enabled: true } }), () => {}, [], '/fixture/cfg.json', () => false);
  const second = fakeRes();
  await unsupported({ method: 'POST', url: '/task-radar/test' }, second);
  assert.deepEqual(JSON.parse(second.body), { ok: true, submitted: false });
});

test('handler returns 404 for an unknown path', async () => {
  const handler = createHandler(() => ({}), () => {}, [], 'C:/tmp/cfg.json');
  const res = fakeRes();
  await handler({ method: 'GET', url: '/task-radar/nope' }, res);
  assert.equal(res.status, 404);
});
