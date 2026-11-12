/**
 * Unit tests for the Host-side price catalog (lib/prices.js).
 *
 * These cover the pure conversion and lookup only: fetching, caching and the
 * HTTP route live in lib/index.js and are exercised end-to-end by the running
 * plugin, not here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalog, classifyNames, cnyEntry, nameCandidates, selectModels, usdToCnyOf } from '../lib/prices.js';

const FX = 7.2;

test('one catalog entry converts USD per million into CNY per million', () => {
	const rate = cnyEntry({ input: 1.25, output: 10, cache_read: 0.125, cache_write: 2.5 }, FX);
	assert.deepEqual(rate, { input: 9, output: 72, cacheRead: 0.9, cacheWrite: 18 });
});

test('a missing cache price falls back to the input rate', () => {
	const rate = cnyEntry({ input: 2, output: 8 }, FX);
	assert.deepEqual(rate, { input: 14.4, output: 57.6, cacheRead: 14.4, cacheWrite: 14.4 });
	assert.equal(cnyEntry(undefined, FX), undefined);
	assert.equal(cnyEntry({ input: 1 }, FX), undefined, 'output is required');
	assert.equal(cnyEntry({ input: 1, output: 1 }, 0), undefined, 'a zero rate is not usable');
});

test('the catalog indexes provider-qualified and bare model ids', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
	}, FX);
	assert.deepEqual(catalog['openai/gpt-6-sol'], { input: 14.4, output: 72, cacheRead: 1.44, cacheWrite: 14.4 });
	assert.deepEqual(catalog['gpt-6-sol'], catalog['openai/gpt-6-sol'], 'bare id mirrors the first provider');
});

test('DeepSeek entries are left to the built-in peak/off-peak table', () => {
	const catalog = buildCatalog({
		deepseek: { models: { 'deepseek-flash': { cost: { input: 0.15, output: 0.6 } } },
			models2: {} },
		relay: { models: { 'deepseek-v4-pro': { cost: { input: 1, output: 2 } } } },
	}, FX);
	assert.deepEqual(Object.keys(catalog), [], 'no DeepSeek id may be priced from the catalog');
});

test('the first provider that prices an id wins the bare key', () => {
	const catalog = buildCatalog({
		alpha: { models: { shared: { cost: { input: 1, output: 2 } } } },
		beta: { models: { shared: { cost: { input: 9, output: 9 } } } },
	}, FX);
	assert.equal(catalog.shared.input, 7.2);
	assert.equal(catalog['beta/shared'].input, 64.8, 'provider-qualified keys stay exact');
});

test('model names expand to the spellings a relay might use', () => {
	const candidates = nameCandidates('codex/gpt-6.1-sol');
	assert.equal(candidates[0], 'codex/gpt-6.1-sol', 'the routed name is tried first');
	assert.equal(candidates.includes('gpt-6.1-sol'), true);
	assert.equal(candidates.includes('gpt-6-sol'), true, 'minor-version collapse');
	assert.equal(nameCandidates('relay/model-free').includes('model'), true, 'release suffix stripped');
	assert.deepEqual(nameCandidates(''), []);
	assert.deepEqual(nameCandidates(undefined), []);
});

test('selectModels answers only the names that resolved', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10 } } } },
	}, FX);
	const hits = selectModels(catalog, ['codex/gpt-6.1-sol', 'codex/unknown-model']);
	assert.deepEqual(Object.keys(hits), ['codex/gpt-6.1-sol'], 'unknown names are simply absent');
	assert.equal(hits['codex/gpt-6.1-sol'].input, 14.4);
	assert.deepEqual(Object.keys(selectModels(undefined, ['x'])), [], 'no catalog, no hits');
	assert.deepEqual(Object.keys(selectModels(catalog, 'not-an-array')), [], 'a malformed request list is ignored');
});

test('the exchange rate is read defensively', () => {
	assert.equal(usdToCnyOf({ rates: { CNY: 7.15 } }), 7.15);
	assert.equal(usdToCnyOf({ rates: { CNY: 0 } }), undefined);
	assert.equal(usdToCnyOf({ rates: {} }), undefined);
	assert.equal(usdToCnyOf(undefined), undefined);
});

/* ------------------------------------------------------------------ diagnostics */

// These pin the DIAGNOSTIC contract, not the pricing one. On 2026-10-26 the live
// status file showed `priced_models: 10995` next to `last_request_hits: []` for the
// routed id `workbuddy/deepseek-v4.1-flash`. That reads like "pricing is broken",
// and the obvious next move -- fix the lookup -- would have been wrong: DeepSeek
// ids are excluded from the catalog on purpose because the client's built-in table
// prices them, peak/off-peak included. The empty array was the DESIGNED outcome.
//
// So `classifyNames` splits the answer into "catalog", "built-in" and "genuinely
// unpriced", and only the last group means a price is actually missing.

test('a DeepSeek id that the catalog skips is reported as built-in, not missing', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10 } } } },
	}, FX);
	const names = ['workbuddy/deepseek-v4.1-flash'];
	const hits = selectModels(catalog, names);
	assert.deepEqual(Object.keys(hits), [], 'the catalog genuinely has nothing for it');

	const split = classifyNames(names, hits);
	assert.deepEqual(split.catalog, []);
	assert.deepEqual(split.builtin, ['workbuddy/deepseek-v4.1-flash'], 'this is the group that is fine');
	assert.deepEqual(split.unpriced, [], 'nothing is actually missing a price');
});

test('a catalog hit is reported as catalog, never as built-in', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10 } } } },
	}, FX);
	const names = ['codex/gpt-6.1-sol'];
	const split = classifyNames(names, selectModels(catalog, names));
	assert.deepEqual(split.catalog, ['codex/gpt-6.1-sol']);
	assert.deepEqual(split.builtin, []);
	assert.deepEqual(split.unpriced, []);
});

test('only a non-DeepSeek name absent from the catalog counts as unpriced', () => {
	const split = classifyNames(['relay/mystery-model'], {});
	assert.deepEqual(split.catalog, []);
	assert.deepEqual(split.builtin, []);
	assert.deepEqual(split.unpriced, ['relay/mystery-model'], 'this is the only group worth alerting on');
});

test('the three groups partition the request exactly once each', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10 } } } },
	}, FX);
	const names = ['codex/gpt-6.1-sol', 'apikeyfan/deepseek-flash', 'relay/mystery-model'];
	const split = classifyNames(names, selectModels(catalog, names));
	assert.deepEqual(split.catalog, ['codex/gpt-6.1-sol']);
	assert.deepEqual(split.builtin, ['apikeyfan/deepseek-flash']);
	assert.deepEqual(split.unpriced, ['relay/mystery-model']);
	const all = [...split.catalog, ...split.builtin, ...split.unpriced].sort();
	assert.deepEqual(all, [...names].sort(), 'no name is dropped or double-counted');
});

test('the classifier tolerates a missing or malformed request list', () => {
	assert.deepEqual(classifyNames(undefined, {}), { catalog: [], builtin: [], unpriced: [] });
	assert.deepEqual(classifyNames('not-an-array', {}), { catalog: [], builtin: [], unpriced: [] });
	// Empty strings are skipped rather than reported as unpriced.
	assert.deepEqual(classifyNames(['', 'a/deepseek-b'], {}), {
		catalog: [],
		builtin: ['a/deepseek-b'],
		unpriced: [],
	});
});

