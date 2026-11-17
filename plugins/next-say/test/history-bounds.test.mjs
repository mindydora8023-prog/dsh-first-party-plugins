import assert from 'node:assert/strict';
import test from 'node:test';
import { recentMessages, recentUserHistory } from '../lib/predict.js';
import { __internals } from '../lib/index.js';
import { DEFAULTS } from '../lib/config.js';

const message = (text, role = 'user', source) => ({ role, content: [{ type: 'text', text }], ...(source ? { source } : {}) });
const unread = () => { throw new Error('old history must not be read'); };

test('prediction context stops before reading messages outside its count budget', () => {
  const messages = [null, message('one'), message('two'), message('three')];
  Object.defineProperty(messages, 0, { get: unread });
  assert.deepEqual(recentMessages(messages, { maxMessages: 2 }), [
    { role: 'user', text: 'two' }, { role: 'user', text: 'three' },
  ]);
});

test('prediction context stops on the first message exceeding the character budget', () => {
  const messages = [null, message('old'), message('new')];
  Object.defineProperty(messages, 0, { get: unread });
  assert.deepEqual(recentMessages(messages, { maxChars: 35 }), [{ role: 'user', text: 'new' }]);
});

test('prediction context retains chronological order while skipping non-conversation material', () => {
  assert.deepEqual(recentMessages([
    message('first'), message('answer', 'assistant'), message('tool', 'tool'),
    message('injected', 'user', { kind: 'runtime-context' }), null, message('last'),
  ]), [
    { role: 'user', text: 'first' }, { role: 'assistant', text: 'answer' }, { role: 'user', text: 'last' },
  ]);
});

test('local history retains the newest 500 entries without traversing their predecessors', () => {
  const messages = Array.from({ length: 1001 }, (_, index) => message(`question ${index}`));
  Object.defineProperty(messages, 500, { get: unread });
  const result = recentUserHistory(messages);
  assert.equal(result.length, 500);
  assert.equal(result[0].text, 'question 501');
  assert.equal(result.at(-1).text, 'question 1000');
});

test('local history stops collecting blocks once the displayed head is full', () => {
  const content = [{ type: 'text', text: 'x'.repeat(100000) }, null];
  Object.defineProperty(content, 1, { get: unread });
  assert.deepEqual(recentUserHistory([{ role: 'user', content }]), [{ role: 'user', text: 'x'.repeat(2000) }]);
});

test('local history preserves human filtering, block spacing and truncation', () => {
  const first = message('  first  ');
  const second = { role: 'user', content: [
    { type: 'image' }, { type: 'text', text: '  ' }, { type: 'text', text: ' alpha ' },
    { type: 'text', text: ' beta gamma ' },
  ] };
  const messages = [first, message('answer', 'assistant'), message('injected', 'user', { kind: 'skill-catalog' }), second];
  assert.deepEqual(recentUserHistory(messages, { maxChars: 8 }), [
    { role: 'user', text: 'first' }, { role: 'user', text: 'alpha be' },
  ]);
  assert.deepEqual(recentUserHistory(messages, { maxEntries: 1 }), [{ role: 'user', text: 'alpha beta gamma' }]);
  for (const bad of [null, undefined, {}, [null, 42, { role: 'user' }]]) assert.deepEqual(recentUserHistory(bad), []);
});

test('history HTTP response uses the bounded collector and retains its original shape', async () => {
  const messages = Array.from({ length: 501 }, (_, index) => message(`question ${index}`));
  Object.defineProperty(messages, 0, { get: unread });
  const services = {
    connection: { requestRejection() {} },
    sessions: { get: () => ({ deriveMessages: () => messages }) },
  };
  const handler = __internals.createHandler({ get: (name) => services[name] }, { settings: { ...DEFAULTS } });
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handler({ method: 'GET', url: '/next-say/history?sessionId=s1' }, response);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.paused, false);
  assert.equal(response.body.items.length, 500);
  assert.equal(response.body.items[0].text, 'question 1');
});
