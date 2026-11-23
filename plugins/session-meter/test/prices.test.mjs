/**
 * Unit tests for the Host-side price catalog (lib/prices.js).
 *
 * These cover the pure conversion and lookup only: fetching, caching and the
 * HTTP route live in lib/index.js and are exercised end-to-end by the running
 * plugin, not here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalog, classifyNames, cnyEntry, nameCandidates, normalizeModelKey, scaleRates, selectModels, usdToCnyOf } from '../lib/prices.js';

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

test('a context-window tag is stripped, a snapshot date is not', () => {
	const candidates = nameCandidates('cursor/grok-4.7@500k');
	assert.equal(candidates[0], 'cursor/grok-4.7@500k', 'the routed name is still tried first');
	assert.equal(candidates.includes('grok-4.7'), true, 'catalog id without the window tag');
	assert.equal(candidates.includes('grok-4'), false, 'must not collapse onto a different model');
	assert.equal(nameCandidates('cursor/grok-4.7@1m').includes('grok-4.7'), true);
	const catalog = buildCatalog({
		xai: { models: {
			'grok-4.7': { cost: { input: 2, output: 6, cache_read: 0.5 } },
			'grok-4': { cost: { input: 9, output: 9 } },
			'claude-opus-4-5@20251101': { cost: { input: 5, output: 25 } },
			'claude-opus-4-5': { cost: { input: 1, output: 1 } },
		} },
	}, FX);
	const hits = selectModels(catalog, ['cursor/grok-4.7@500k', 'anthropic/claude-opus-4-5@20251101']);
	assert.equal(hits['cursor/grok-4.7@500k'].input, 14.4);
	assert.equal(hits['cursor/grok-4.7@500k'].output, 43.2);
	assert.equal(hits['anthropic/claude-opus-4-5@20251101'].input, 36, 'the dated key wins over the bare sibling');
});

test('a contributor variant resolves to the canonical catalog model', () => {
	const catalog = buildCatalog({
		meta: { models: { 'muse-wonder-1.0': { cost: { input: 4, output: 20, cache_read: 0.2 } } } },
	}, FX);
	const hits = selectModels(catalog, ['apikeyfan/muse-wonder-1.0-contributor']);
	assert.equal(hits['apikeyfan/muse-wonder-1.0-contributor'].input, 28.8);
	assert.equal(nameCandidates('apikeyfan/muse-wonder-1.0-contributor').includes('muse-wonder-1.0'), true);
});

test('a dash-written version resolves to the dotted catalog id', () => {
	const catalog = buildCatalog({
		kenari: { models: { 'muse-wonder-1-0': { cost: { input: 4, output: 20 } } } },
	}, FX);
	assert.equal(normalizeModelKey('relay/muse-wonder-1-0'), 'relay/muse-wonder-1.0');
	const hits = selectModels(catalog, ['relay/muse-wonder-1-0-contributor']);
	assert.equal(hits['relay/muse-wonder-1-0-contributor'].input, 28.8);
});

test('the canonical model id is indexed for relay routes', () => {
	const catalog = buildCatalog({
		opencode: { models: { 'muse-wonder-1.0': { cost: { input: 4, output: 20 }, canonical_model_id: 'meta/muse-wonder-1.0' } } },
	}, FX);
	assert.equal(catalog['meta/muse-wonder-1.0'].input, 28.8);
});

test('the verified fallback never strips a meaningful tier word', () => {
	const catalog = buildCatalog({
		vendor: { models: { 'qwen3-coder': { cost: { input: 1, output: 2 } }, llama: { cost: { input: 1, output: 2 } } } },
	}, FX);
	const hits = selectModels(catalog, ['relay/qwen3-coder-flash', 'relay/llama-pro']);
	assert.deepEqual(Object.keys(hits), [], 'flash/pro carry identity and stay unpriced');
});

test('the verified fallback refuses an ambiguous strip', () => {
	const catalog = buildCatalog({
		kenari: { models: { 'muse-wonder-1-0': { cost: { input: 1, output: 2 } } } },
		meta: { models: { 'muse-wonder-1.0': { cost: { input: 9, output: 9 } } } },
	}, FX);
	const hits = selectModels(catalog, ['relay/muse-wonder-x']);
	assert.deepEqual(Object.keys(hits), [], 'dash and dotted spellings both match, so it stays unpriced');
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

test('rescaling a catalog applies a new exchange rate without rebuilding it', () => {
	const catalog = buildCatalog({
		openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
	}, FX);
	const scaled = scaleRates(catalog, 2);
	assert.equal(scaled['gpt-6-sol'].input, 28.8);
	assert.equal(scaled['openai/gpt-6-sol'].output, 144);
	assert.notEqual(scaled, catalog, 'a real factor allocates a new table');
	assert.equal(scaleRates(catalog, 1), catalog, 'an unchanged rate reuses the table');
	assert.equal(scaleRates(catalog, 0), catalog, 'a bad factor is ignored');
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

test('verifiedFallback stays O(1) on a 12,000-model catalog', () => {
	const providers = {};
	for (let p = 0; p < 12; p += 1) {
		const models = {};
		for (let i = 0; i < 1000; i += 1) {
			models[`vendor${p}-model-${i}-1.0`] = { cost: { input: 1, output: 2 } };
		}
		providers[`prov${p}`] = { models };
	}
	providers.meta = { models: { 'muse-wonder-1-0': { cost: { input: 3, output: 9 } } } };
	const catalog = buildCatalog(providers, FX);
	const queries = Array.from({ length: 100 }, (_, i) => `relay/unknown-family-${i}-variant`);
	queries.push('relay/muse-wonder-1-0-contributor');
	const started = performance.now();
	const hits = selectModels(catalog, queries);
	const elapsedMs = performance.now() - started;
	assert.equal(hits['relay/muse-wonder-1-0-contributor'].input, 21.6);
	assert.ok(elapsedMs < 200, `100 fallback misses + 1 hit must stay fast via O(1) index (took ${elapsedMs.toFixed(1)}ms)`);
});

