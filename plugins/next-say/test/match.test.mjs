/**
 * Tests for the local history prefix completion.
 *
 * These run against `lib/match.js`, which is the EXACT source inlined into
 * `lib/client.js` by tools/build-client.py -- so a green run here covers the code
 * that actually executes in the browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { historyCompletion, normalizeForMatch } from '../lib/match.js';

/** Message helper: keeps the test cases about content, not shape. */
const user = (text) => ({ role: 'user', text });

test('normalizeForMatch unifies width, case and spacing', () => {
  assert.equal(normalizeForMatch('Hello World'), 'helloworld');
  assert.equal(normalizeForMatch('\uff28\uff45\uff4c\uff4c\uff4f'), 'hello');
  assert.equal(normalizeForMatch('a\uff0cb'), 'a,b');
  assert.equal(normalizeForMatch('a\u3000b'), 'ab');
  assert.equal(normalizeForMatch('what?'), 'what?');
  assert.equal(normalizeForMatch('\u597d\u7684\u3002'), '\u597d\u7684.');
});

test('completes from an earlier user message', () => {
  const result = historyCompletion([user('now run the full test suite please')], 'now run', { minChars: 2 });
  assert.notEqual(result, null);
  assert.equal(result.full, 'now run the full test suite please');
  assert.equal(result.suffix, ' the full test suite please');
  assert.equal(result.source, 'history');
});

test('returns null below the minimum draft length', () => {
  const history = [user('run the tests')];
  assert.equal(historyCompletion(history, 'r', { minChars: 2 }), null);
  assert.notEqual(historyCompletion(history, 'ru', { minChars: 2 }), null);
});

test('returns null when nothing matches', () => {
  assert.equal(historyCompletion([user('run the tests')], 'deploy', { minChars: 2 }), null);
});

test('returns null when the draft already equals the candidate', () => {
  // Nothing would be left to ghost, and an empty suffix is not a suggestion.
  assert.equal(historyCompletion([user('run the tests')], 'run the tests', { minChars: 2 }), null);
});

test('ignores assistant messages by default', () => {
  const history = [{ role: 'assistant', text: 'run the tests' }];
  assert.equal(historyCompletion(history, 'run', { minChars: 2 }), null);
  const withAssistant = historyCompletion(history, 'run', { minChars: 2, includeAssistant: true });
  assert.notEqual(withAssistant, null);
  assert.equal(withAssistant.suffix, ' the tests');
});

test('prefers the more recent candidate', () => {
  const history = [user('check the build output'), user('check the failing case')];
  const result = historyCompletion(history, 'check', { minChars: 2 });
  assert.equal(result.full, 'check the failing case');
});

test('within one recency bucket the shorter remainder wins', () => {
  // Bucket = floor(index / (total - 1) * 4). With 9 entries, indices 6 and 7
  // both land in bucket 3, so length alone decides between them.
  const history = [
    user('unrelated step 0'),
    user('unrelated step 1'),
    user('unrelated step 2'),
    user('unrelated step 3'),
    user('unrelated step 4'),
    user('unrelated step 5'),
    user('add a test'),
    user('add a test with a very long tail of extra words'),
    user('unrelated step 8'),
  ];
  const result = historyCompletion(history, 'add a', { minChars: 2 });
  assert.notEqual(result, null);
  assert.equal(result.full, 'add a test');
});

test('a candidate in a newer bucket always wins', () => {
  // Many entries separate the two, so they land in different buckets and the
  // newer one is chosen even though its remainder is longer.
  const history = [user('check the build')];
  for (let index = 0; index < 20; index += 1) history.push(user(`unrelated step ${index}`));
  history.push(user('check the build output and rerun'));
  const result = historyCompletion(history, 'check', { minChars: 2 });
  assert.equal(result.full, 'check the build output and rerun');
});

test('matches across width and case differences', () => {
  const history = [user('Update the README')];
  const result = historyCompletion(history, 'update the', { minChars: 2 });
  assert.notEqual(result, null);
  // The suffix is measured in the CANDIDATE's original characters.
  assert.equal(result.suffix, ' README');
});

test('suffix is measured in original characters, not normalized ones', () => {
  const history = [user('run   the    tests')];
  const result = historyCompletion(history, 'run the', { minChars: 2 });
  assert.notEqual(result, null);
  // 'run the' normalizes to 'runthe'; the candidate's own prefix 'run   the'
  // consumes it, and everything after that is the ghost.
  assert.equal(result.suffix, '    tests');
});

test('respects maxEntries', () => {
  const history = [user('alpha one'), user('beta two'), user('gamma three')];
  assert.equal(historyCompletion(history, 'gamma', { minChars: 2, maxEntries: 3 }).full, 'gamma three');
  // Only the newest two are considered, so the oldest candidate is invisible.
  assert.equal(historyCompletion(history, 'alpha', { minChars: 2, maxEntries: 2 }), null);
});

test('refuses a remainder longer than maxExtraChars', () => {
  const history = [user('go ' + 'x'.repeat(500))];
  assert.equal(historyCompletion(history, 'go', { minChars: 2, maxExtraChars: 400 }), null);
  assert.notEqual(historyCompletion(history, 'go', { minChars: 2, maxExtraChars: 600 }), null);
});

test('skips one-character history entries', () => {
  assert.equal(historyCompletion([user('x')], 'x', { minChars: 1 }), null);
});

test('tolerates malformed history without throwing', () => {
  const cases = [
    undefined,
    null,
    [],
    [null, undefined, 42],
    [{ role: 'user' }, { role: 'user', text: 7 }],
    [user('')],
  ];
  for (const value of cases) {
    assert.doesNotThrow(() => historyCompletion(value, 'run', { minChars: 2 }));
    assert.equal(historyCompletion(value, 'run', { minChars: 2 }), null);
  }
});

test('a candidate equal to the draft after normalization is not offered', () => {
  const history = [user('run the tests')];
  // Same text with different spacing: nothing new to insert.
  assert.equal(historyCompletion(history, 'run  the   tests', { minChars: 2 }), null);
});
