/**
 * Tests for the prediction surface: budget, language, cleanup, dedupe.
 *
 * The interesting cases are the ones that used to fail SILENTLY in the plugins
 * this one borrows from: an empty string that looks like success, a numeric
 * setting that disables the feature, a duplicated suggestion that burns a second
 * call to fix nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestText,
  buildSystemPrompt,
  charsToTokens,
  createSuggestionMemory,
  dedupeKey,
  detectConversationLanguage,
  detectScript,
  editDistance,
  isCharacterCounted,
  isNearDuplicate,
  isUserAuthored,
  messageText,
  normalizeSuggestion,
  proseOf,
  recentMessages,
  resolveRoute,
} from '../lib/predict.js';

/* ------------------------------------------------------------- language */

test('detectScript picks the dominant script', () => {
  assert.equal(detectScript('hello there'), 'Latin');
  assert.equal(detectScript('\u5e2e\u6211\u770b\u770b\u8fd9\u4e2a bug'), 'Chinese');
  assert.equal(detectScript('\u3053\u308c\u3092\u76f4\u3057\u3066\u304f\u3060\u3055\u3044'), 'Japanese');
  assert.equal(detectScript('\u043f\u0440\u0438\u0432\u0435\u0442'), 'Russian');
  assert.equal(detectScript(''), 'Latin');
});

test('kana beats the Han characters it borrows', () => {
  // Japanese text is mostly Han; the kana probe must win or everything Japanese
  // is labelled Chinese.
  assert.equal(detectScript('\u5b9f\u88c5\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044'), 'Japanese');
});

test('votes per message, so one pasted log does not flip the language', () => {
  const history = [
    { role: 'user', text: '\u5e2e\u6211\u628a\u8fd9\u4e2a\u63a5\u53e3\u6539\u4e00\u4e0b' },
    { role: 'assistant', text: 'a very long english explanation with lots of words ' .repeat(20) },
    { role: 'user', text: '\u597d\u7684\uff0c\u7ee7\u7eed' },
  ];
  assert.equal(detectConversationLanguage(history), 'Simplified Chinese');
});

test('detects Traditional Chinese and names the script', () => {
  const history = [{ role: 'user', text: '\u9019\u500b\u554f\u984c\u5011\u4f86\u8aaa\uff0c\u9084\u662f\u8981\u958b\u95dc\u5be6\u9ede\u70ba\u8207\u5b78\u570b\u8a9e\u8eca\u6771\u9577\u9580\u554f\u9593\u6a23\u9032\u9084\u904b' }];
  assert.equal(detectConversationLanguage(history), 'Traditional Chinese');
});

test('falls back to English with no usable history', () => {
  assert.equal(detectConversationLanguage([]), 'English');
  assert.equal(detectConversationLanguage(undefined), 'English');
  assert.equal(detectConversationLanguage([{ role: 'user', text: '   ' }]), 'English');
});

/**
 * The suggestion for a Chinese conversation came back in English because the
 * only user message of the turn was read as Latin: its URL and two package names
 * outnumbered its Han characters. These are the cases that produced it.
 */
test('a link glued to Chinese prose does not make the message English', () => {
  const message = 'https://github.com/ninetyhe-90/de-armor'
    + '\u770b\u770b\u8fd9\u4e2a\u9879\u76ee\u5bf9\u6211\u4eec\u7684'
    + 'dsh-plugin-purge-kit'
    + '\u63d2\u4ef6\u6709\u6ca1\u6709\u53ef\u4ee5\u501f\u9274\u7684';
  assert.equal(detectScript(message), 'Chinese');
  assert.equal(detectConversationLanguage([{ role: 'user', text: message }]), 'Simplified Chinese');
});

test('proseOf drops quoted material and keeps the prose beside it', () => {
  // No space between the link and the sentence: a `\\S+` URL match swallowed the
  // whole request, which then had no prose to vote with.
  const url = 'https://example.com/a/b';
  assert.equal(proseOf(`${url}\u770b\u4e00\u4e0b`).trim(), '\u770b\u4e00\u4e0b');
  assert.equal(proseOf('see https://example.com/a/b now').trim(), 'see   now');
  // A fenced block and an inline span are quotes as well.
  assert.equal(proseOf('```\nconst x = 1;\n```\n\u597d').trim(), '\u597d');
  assert.equal(proseOf('`client.js` \u91cc').trim(), '\u91cc');
});

test('pasted code does not outvote the question asked about it', () => {
  const message = '```\nconst retry = await fetch(url);\nconsole.log(retry.status);\n```\n'
    + '\u8fd9\u6bb5\u4ee3\u7801\u719f\u6089\u5417';
  assert.equal(detectScript(message), 'Chinese');
  assert.equal(detectConversationLanguage([{ role: 'user', text: message }]), 'Simplified Chinese');
});

test('a Latin word is one unit, not one per letter', () => {
  // Han: 4 characters. Latin letters: 6. Counting characters called this Latin.
  assert.equal(detectScript('\u5b89\u88c5wemod\u5230E\u76d8'), 'Chinese');
  assert.equal(detectScript('\u4e3a\u4ec0\u4e48\u6709\u8fd9\u4e48\u591adeepseek'), 'Chinese');
  // Real English still wins on its own ground.
  assert.equal(detectScript('please refactor the loader and rerun the tests'), 'Latin');
});

test('a message with no prose casts no vote at all', () => {
  // A bare link votes nothing; the Chinese it sits next to decides.
  const history = [
    { role: 'user', text: 'https://github.com/T-Auto/dsh-ops' },
    { role: 'user', text: '\u7ee7\u7eed' },
  ];
  assert.equal(detectConversationLanguage(history), 'Simplified Chinese');
  // And an all-links history has nothing to say, so it stays on the default.
  assert.equal(
    detectConversationLanguage([{ role: 'user', text: 'https://example.com/x' }]),
    'English',
  );
});

test('isCharacterCounted separates CJK from alphabetic languages', () => {
  assert.equal(isCharacterCounted('Simplified Chinese'), true);
  assert.equal(isCharacterCounted('Japanese'), true);
  assert.equal(isCharacterCounted('English'), false);
  assert.equal(isCharacterCounted('Russian'), false);
});

/* --------------------------------------------------------------- budget */

test('charsToTokens stays inside its bounds', () => {
  assert.ok(charsToTokens(120, 'English') >= 256);
  assert.ok(charsToTokens(400, 'Simplified Chinese') <= 2048);
  // CJK needs more tokens for the same character count than Latin does.
  assert.ok(charsToTokens(120, 'Simplified Chinese') > charsToTokens(120, 'English'));
});

test('the token budget leaves room for a reasoning model to think first', () => {
  // A reasoning provider spends maxTokens on its thinking before it emits any
  // text. With 256 tokens of headroom the whole budget could go to reasoning, the
  // stream ended with max-tokens and no text, and the plugin reported a silent
  // 'truncated' -- which made non-reasoning providers look supported and reasoning
  // ones look unsupported.
  for (const chars of [20, 120, 400]) {
    for (const language of ['English', 'Simplified Chinese']) {
      const cap = charsToTokens(chars, language);
      const visible = Math.ceil(chars / (language === 'English' ? 2.5 : 0.6));
      assert.ok(
        cap - visible >= 600,
        `${language}/${chars}: only ${cap - visible} tokens of headroom (cap ${cap}, text ${visible})`,
      );
    }
  }
});

test('charsToTokens never returns zero, which would empty every reply', () => {
  for (const value of [0, -1, Number.NaN, undefined, null, 'abc']) {
    assert.ok(charsToTokens(value, 'English') >= 64, `bad value ${String(value)}`);
  }
});

test('the system prompt names the language and the character budget', () => {
  const prompt = buildSystemPrompt('Traditional Chinese', 120);
  assert.match(prompt, /Traditional Chinese/);
  assert.match(prompt, /120 characters/);
  // The script instruction is what stops a mixed-glyph Chinese reply.
  assert.match(prompt, /Traditional characters/);
});

/* ---------------------------------------------------------- transcript */

test('messageText keeps text blocks and drops everything else', () => {
  const message = {
    content: [
      { type: 'text', text: '  first  ' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'image', attachment: { attachmentId: 'x' } },
      { type: 'tool-call', id: 't', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'second' },
    ],
  };
  assert.equal(messageText(message), 'first\nsecond');
});

test('recentMessages skips injected user-role messages', () => {
  // Verified against a real session log: the harness files runtime context, the
  // skill catalogue, AGENTS.md instructions and time snapshots as `role: 'user'`
  // with a `source.kind` naming their origin. Sending those to the suggestion
  // model would bury the actual conversation in boilerplate.
  const messages = [
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current working directory: E:/x' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'office: Create documents' }] },
    { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md body' }] },
    { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled 22:02' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'fix the build' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const kept = recentMessages(messages, { maxMessages: 8, maxChars: 6000 });
  assert.deepEqual(kept.map((item) => item.text), ['fix the build', 'done']);
});

test('isUserAuthored treats a message without a source as authored', () => {
  assert.equal(isUserAuthored({ role: 'user' }), true);
  assert.equal(isUserAuthored({ role: 'user', source: { kind: 'user' } }), true);
  assert.equal(isUserAuthored({ role: 'user', source: { kind: 'runtime-context' } }), false);
  assert.equal(isUserAuthored({ role: 'user', source: 'weird' }), true);
  assert.equal(isUserAuthored(null), true);
});

test('recentMessages keeps a sourced assistant message', () => {
  // The filter applies to user messages only; assistant text is always fair game.
  const messages = [
    { role: 'assistant', source: { kind: 'anything' }, content: [{ type: 'text', text: 'the answer' }] },
  ];
  assert.deepEqual(recentMessages(messages).map((item) => item.text), ['the answer']);
});

test('recentMessages keeps user and assistant text only, newest first', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'tool', content: [{ type: 'text', text: 'SECRET TOOL OUTPUT' }] },
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
    { role: 'user', content: [{ type: 'text', text: 'three' }] },
  ];
  const kept = recentMessages(messages, { maxMessages: 8, maxChars: 6000 });
  assert.deepEqual(kept.map((item) => item.text), ['one', 'two', 'three']);
  const joined = kept.map((item) => item.text).join('\n');
  assert.ok(!joined.includes('SECRET TOOL OUTPUT'));
  assert.ok(!joined.includes('SYSTEM PROMPT'));
});

test('recentMessages respects maxMessages from the tail', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `message ${index}` }],
  }));
  const kept = recentMessages(messages, { maxMessages: 3, maxChars: 6000 });
  assert.deepEqual(kept.map((item) => item.text), ['message 7', 'message 8', 'message 9']);
});

test('recentMessages always keeps the newest message even past the budget', () => {
  // A single huge message must not empty the transcript: that would turn into
  // "no history" and silently disable prediction.
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }];
  const kept = recentMessages(messages, { maxMessages: 4, maxChars: 100 });
  assert.equal(kept.length, 1);
});

test('recentMessages honours the character budget', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `m${index} `.repeat(60) }],
  }));
  const kept = recentMessages(messages, { maxMessages: 20, maxChars: 1000, perMessageChars: 2000 });
  const used = kept.reduce((total, item) => total + item.text.length + 32, 0);
  assert.ok(used <= 1000, `used ${used}`);
  assert.ok(kept.length >= 1);
});

test('recentMessages tolerates junk without throwing', () => {
  for (const value of [undefined, null, [], [null], [{ role: 'user' }], [{ role: 'user', content: 'nope' }]]) {
    assert.doesNotThrow(() => recentMessages(value));
    assert.deepEqual(recentMessages(value), []);
  }
});

/* ------------------------------------------------------------ normalize */

test('normalizeSuggestion strips fences, labels and quotes', () => {
  assert.equal(normalizeSuggestion('```\nrun the tests\n```'), 'run the tests');
  assert.equal(normalizeSuggestion('Suggestion: run the tests'), 'run the tests');
  assert.equal(normalizeSuggestion('"run the tests"'), 'run the tests');
  assert.equal(normalizeSuggestion('\u5efa\u8bae\uff1a\u8dd1\u4e00\u4e0b\u6d4b\u8bd5'), '\u8dd1\u4e00\u4e0b\u6d4b\u8bd5');
  assert.equal(normalizeSuggestion('  run   the   tests  '), 'run the tests');
});

test('normalizeSuggestion collapses a multi-line reply to one line', () => {
  assert.equal(normalizeSuggestion('run the tests\nthen fix the build'), 'run the tests then fix the build');
});

test('normalizeSuggestion truncates at a word boundary near the limit', () => {
  const long = 'word '.repeat(100);
  const result = normalizeSuggestion(long, 40);
  assert.ok(result.length <= 40);
  assert.ok(!result.endsWith('wor'));
});

test('normalizeSuggestion returns an empty string rather than junk', () => {
  // Empty is the documented "no suggestion" signal; the caller must not treat it
  // as an error, and it must never be shown as a blank row.
  for (const value of ['', '   ', null, undefined, '```\n\n```', '""']) {
    assert.equal(normalizeSuggestion(value), '');
  }
});

/* --------------------------------------------------------------- dedupe */

test('dedupeKey ignores case, spacing, quotes and trailing punctuation', () => {
  assert.equal(dedupeKey('Run the tests.'), dedupeKey('run the tests'));
  assert.equal(dedupeKey('"run the tests"'), dedupeKey('run the tests'));
  assert.equal(dedupeKey('run  the tests?'), dedupeKey('run the tests'));
});

test('editDistance is capped and symmetric', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('abc', 'abd'), editDistance('abd', 'abc'));
  // Beyond the cap the exact value does not matter, only that it is over it.
  assert.ok(editDistance('abcdef', 'zzzzzz', 2) > 2);
});

test('isNearDuplicate catches a reworded repeat but not a new idea', () => {
  assert.equal(isNearDuplicate('Run the tests.', 'run the tests'), true);
  assert.equal(isNearDuplicate('Run all the tests now', 'run all the test now'), true);
  assert.equal(isNearDuplicate('Deploy to staging', 'run the tests'), false);
  // Short strings need an exact key: two short different ideas are not dupes.
  assert.equal(isNearDuplicate('ok go', 'ok do'), false);
  assert.equal(isNearDuplicate('', 'anything'), false);
});

/* -------------------------------------------------------------- framing */

test('buildRequestText frames both roles and names the language', () => {
  const text = buildRequestText(
    [{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'done' }],
    'English',
  );
  assert.match(text, /\[User\]\nfix it/);
  assert.match(text, /\[Assistant\]\ndone/);
  assert.match(text, /in English/);
});

test('buildRequestText adds a force-different hint when rerolling', () => {
  const text = buildRequestText([{ role: 'user', text: 'a' }], 'English', {
    avoid: 'run the tests',
    forceDifferent: true,
  });
  assert.match(text, /run the tests/);
  assert.match(text, /DIFFERENT/);
});

test('buildRequestText omits the hint when there is nothing to avoid', () => {
  const text = buildRequestText([{ role: 'user', text: 'a' }], 'English', { avoid: '   ' });
  assert.ok(!/already saw/.test(text));
});

/* ---------------------------------------------------------------- route */

test('resolveRoute prefers the session model and falls back to the default', () => {
  const session = { requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) };
  assert.deepEqual(resolveRoute(session, { provider: 'p0', model: 'm0' }), { provider: 'p1', model: 'm1' });

  const bare = { requestHeader: () => undefined };
  assert.deepEqual(resolveRoute(bare, { provider: 'p0', model: 'm0' }), { provider: 'p0', model: 'm0' });

  const throwing = { requestHeader: () => { throw new Error('no header'); } };
  assert.deepEqual(resolveRoute(throwing, { provider: 'p0', model: 'm0' }), { provider: 'p0', model: 'm0' });

  assert.equal(resolveRoute({}, undefined), undefined);
});

/* --------------------------------------------------------------- memory */

test('suggestion memory is bounded and keeps the newest', () => {
  const memory = createSuggestionMemory(3);
  for (let index = 0; index < 10; index += 1) memory.set(`s${index}`, `value ${index}`);
  assert.equal(memory.size(), 3);
  assert.equal(memory.get('s9'), 'value 9');
  assert.equal(memory.get('s0'), undefined);
});

test('suggestion memory forgets an emptied value', () => {
  const memory = createSuggestionMemory(3);
  memory.set('a', 'text');
  memory.set('a', '');
  assert.equal(memory.get('a'), undefined);
  assert.equal(memory.size(), 0);
});
