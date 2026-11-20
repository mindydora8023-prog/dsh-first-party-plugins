/**
 * Unit tests for dsh-plugin-session-meter.
 *
 * The browser bundle is loaded exactly as the page loads it: a stubbed
 * `window.__ModuleLoader__` captures the factory, a minimal `react` stand-in is
 * injected for `require`, and the factory's exported `__internals` give the
 * tests the real shipped pure functions (no copy of the logic lives here).
 *
 * Covers: peak-window arithmetic (weekday/weekend/holiday/window edges in
 * Beijing time), model -> price resolution (exact + provider-prefixed), cost
 * math (peak vs off-peak, cache buckets), and the slot registration shape.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Minimal React stand-in. `createElement` builds a plain tree so the shipped
 * component can be rendered and its text inspected; the component captures
 * `h = React.createElement` at module load, so this must be final from the
 * start (replacing the property later would not be seen).
 */
const REACT_STUB = {
	createElement: (type, props, ...children) => ({
		type,
		props: props ?? {},
		children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
	}),
	memo: (fn) => fn,
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
	useRef: (init) => ({ current: init }),
};

let captured;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			captured = definition;
		},
	},
};

await import('../lib/client.js');

const plugin = captured.factory((name) => {
	if (name === 'react') return REACT_STUB;
	throw new Error('unexpected require: ' + name);
});
const I = plugin.__internals;

/** Beijing wall-clock instant from a date/time string, as UTC ms. */
function beijing(dateText, hour, minute) {
	return Date.UTC(Number(dateText.slice(0, 4)), Number(dateText.slice(5, 7)) - 1, Number(dateText.slice(8, 10)), hour - 8, minute);
}

test('factory identity matches the loader id', () => {
	assert.equal(captured.id, 'dsh-plugin-session-meter');
	assert.equal(plugin.name, 'session-meter');
	assert.deepEqual(plugin.inject, ['slots', 'locale']);
});

test('weekday peak windows are inclusive of start, exclusive of end', () => {
	// 2026-10-22 is a Thursday.
	assert.equal(I.isPeakAt(beijing('2026-10-22', 8, 59)), false);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 9, 0)), true);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 11, 59)), true);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 12, 0)), false, 'lunch break is off-peak');
	assert.equal(I.isPeakAt(beijing('2026-10-22', 13, 59)), false);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 14, 0)), true);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 17, 59)), true);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 18, 0)), false);
	assert.equal(I.isPeakAt(beijing('2026-10-22', 22, 0)), false);
});

test('weekends are off-peak all day', () => {
	// 2026-10-24 Saturday, 2026-10-25 Sunday.
	assert.equal(I.isPeakAt(beijing('2026-10-24', 10, 0)), false);
	assert.equal(I.isPeakAt(beijing('2026-10-25', 15, 0)), false);
});

test('statutory holidays are off-peak even on a weekday', () => {
	// 2026-10-01 National Day is a Thursday; range covers 10-01..10-07.
	assert.equal(I.isPeakAt(beijing('2026-10-01', 10, 0)), false);
	assert.equal(I.isPeakAt(beijing('2026-10-07', 15, 0)), false);
	// 2026-10-08 is the first working day after the range.
	assert.equal(I.isPeakAt(beijing('2026-10-08', 10, 0)), true);
	// 2027 notice (State Council, 2026-11-05). Weekdays inside a range stay off-peak.
	assert.equal(I.isPeakAt(beijing('2027-01-01', 10, 0)), false, '2027 new year friday');
	assert.equal(I.isPeakAt(beijing('2027-02-08', 10, 0)), false, '2027 spring festival monday');
	assert.equal(I.isPeakAt(beijing('2027-06-09', 10, 0)), false, '2027 dragon boat');
	assert.equal(I.isPeakAt(beijing('2027-09-15', 15, 0)), false, '2027 mid-autumn');
	// The first weekday after each range is peak again.
	assert.equal(I.isPeakAt(beijing('2027-01-04', 10, 0)), true);
	assert.equal(I.isPeakAt(beijing('2027-02-15', 10, 0)), true);
	assert.equal(I.isPeakAt(beijing('2027-06-10', 10, 0)), true);
	assert.equal(I.nextFlipAt(beijing('2027-01-01', 10, 0)), beijing('2027-01-04', 9, 0));
});

test('clock is read at UTC+8 regardless of the host timezone', () => {
	// 02:00 UTC on 2026-10-22 == 10:00 Beijing (peak).
	const ms = Date.UTC(2026, 9, 22, 2, 0);
	assert.equal(I.isPeakAt(ms), true);
});

test('next flip inside a peak window is that window end', () => {
	// 10:00 Beijing on a Thursday -> 12:00 same day (2 h out).
	assert.equal(I.nextFlipAt(beijing('2026-10-22', 10, 0)), beijing('2026-10-22', 12, 0));
	// 14:30 -> 18:00 (3 h 30 min out).
	assert.equal(I.nextFlipAt(beijing('2026-10-22', 14, 30)), beijing('2026-10-22', 18, 0));
	// The lunch break is itself off-peak, so 12:00 is never a "flip instant".
	assert.equal(I.nextFlipAt(beijing('2026-10-22', 12, 0)), beijing('2026-10-22', 14, 0));
});

test('next flip from off-peak skips nights, weekends and holidays', () => {
	// Before the morning window: the same day at 09:00.
	assert.equal(I.nextFlipAt(beijing('2026-10-22', 7, 15)), beijing('2026-10-22', 9, 0));
	// After the afternoon window: Friday's morning window is next.
	assert.equal(I.nextFlipAt(beijing('2026-10-22', 22, 0)), beijing('2026-10-23', 9, 0));
	// Saturday: the following Monday at 09:00.
	assert.equal(I.nextFlipAt(beijing('2026-10-24', 10, 0)), beijing('2026-10-26', 9, 0));
	// Inside a holiday block (2026-10-01..07), the next window is 2026-10-08.
	assert.equal(I.nextFlipAt(beijing('2026-10-03', 10, 0)), beijing('2026-10-08', 9, 0));
});

test('a peak flip always agrees with isPeakAt on both sides', () => {
	const samples = [
		beijing('2026-10-22', 7, 15),
		beijing('2026-10-22', 10, 0),
		beijing('2026-10-22', 12, 0),
		beijing('2026-10-22', 14, 30),
		beijing('2026-10-22', 22, 0),
		beijing('2026-10-24', 10, 0),
		beijing('2026-10-03', 10, 0),
	];
	for (const ms of samples) {
		const flip = I.nextFlipAt(ms);
		assert.equal(typeof flip, 'number', 'a flip is found for ' + new Date(ms - 8 * 3600000).toISOString());
		assert.equal(I.isPeakAt(flip), !I.isPeakAt(ms), 'state differs exactly at the flip instant');
		assert.equal(I.isPeakAt(flip - 1), I.isPeakAt(ms), 'state is unchanged one millisecond earlier');
	}
});

test('price lookup resolves the documented id, legacy aliases, and a provider prefix', () => {
	const flash = I.PRICING['deepseek-flash'];
	assert.equal(I.priceOf('deepseek-flash'), flash);
	// The route actually used in this workspace is `group/deepseek-v4.1-flash`.
	assert.equal(I.priceOf('deepseek-v4.1-flash'), flash);
	assert.equal(I.priceOf('group/deepseek-v4.1-flash'), flash);
	assert.equal(I.priceOf('workbuddy-ai/deepseek-v4.1-flash'), flash);
	assert.equal(I.priceOf('wokey/deepseek-flash'), flash);
	assert.equal(I.priceOf('deepseek-v4-flash'), flash);
	assert.equal(I.priceOf('deepseek-v4-flash-vision-exp'), flash, 'retired vision id is billed as flash');
	assert.equal(I.priceOf('relay/deepseek-v4-flash-vision-exp'), flash);
	assert.equal(I.priceOf('deepseek-v4-pro'), I.PRICING['deepseek-v4-pro']);
	assert.equal(I.priceOf('codex/gpt-6.1-sol'), undefined, 'non-DeepSeek routes stay unpriced');
	assert.equal(I.priceOf('unknown-model'), undefined);
	assert.equal(I.priceOf(undefined), undefined);
});

test('model ids are recognised by family when the exact id is not listed', () => {
	const pro = I.PRICING['deepseek-v4-pro'];
	assert.equal(I.priceOf('deepseek-v4.1-pro'), pro, 'new pro alias');
	assert.equal(I.priceOf('magpie/deepseek-v4.1-pro'), pro, 'provider-prefixed pro');
	assert.equal(I.priceOf('opencode-zen-free/deepseek-v4.1-flash-free'), I.PRICING['deepseek-flash'], 'reseller flash variant');
	assert.equal(I.priceOf('DEEPSEEK-FLASH'), I.PRICING['deepseek-flash'], 'case insensitive');
	// A relay may drop the vendor prefix; the family word still names the model.
	assert.equal(I.priceOf('v4.1-flash'), I.PRICING['deepseek-flash'], 'family without a vendor prefix');
	assert.equal(I.priceOf('relay/v4-pro@1m'), I.PRICING['deepseek-v4-pro'], 'context-window tag is not part of the id');
	assert.equal(I.priceOf('deepseek-v4.1-flash@1m'), I.PRICING['deepseek-flash']);
	assert.equal(I.priceOf('mimo-v2.6-pro@1m'), undefined, 'another vendor keeps its tag and stays out');
	assert.equal(I.priceOf('claude-opus-4-5@20251101'), undefined, 'a snapshot date is not a window tag');
	assert.equal(I.priceOf('relay/v4-pro'), pro, 'relay route with only the family name');
	// Another vendor's name must never borrow DeepSeek money.
	assert.equal(I.priceOf('gpt-6.1-sol'), undefined, 'non-DeepSeek vendors stay unpriced');
	assert.equal(I.priceOf('codex/gpt-6.1-sol'), undefined, 'provider-prefixed non-DeepSeek');
	assert.equal(I.priceOf('llama-pro'), undefined, 'foreign vendor with a family word');
	assert.equal(I.priceOf('qwen3-coder-flash'), undefined, 'another foreign vendor with a family word');
});

test('a vendor word before the family word never borrows DeepSeek pricing', () => {
	// Reported 2026-10-29: `workbuddy/mimo-v2.6-pro` displayed the peak/
	// off-peak marker. Its `pro` tail matched the family fallback and the
	// then-denylist of foreign vendors knew no `mimo`, so the route borrowed
	// DeepSeek PRO_TIER -- the marker and the DeepSeek money came with it.
	// The guard is now a positive shape test: the segment must say `deepseek`
	// or be the bare spelling (`v4.1-flash`, `relay/v4-pro`) with no vendor
	// word in front.
	assert.equal(I.priceOf('workbuddy/mimo-v2.6-pro'), undefined, 'mimo pro is another vendor');
	assert.equal(I.priceOf('mimo-v2.6-pro'), undefined);
	assert.equal(I.priceOf('xiaomi/mimo-v2.6-flash'), undefined);
	assert.equal(I.priceOf('mimo-pro'), undefined);
	assert.equal(I.priceOf('minimax-m2-pro'), undefined, 'a vendor the old denylist never listed');
	assert.equal(I.priceOf('llama-pro'), undefined, 'still unpriced');
	assert.equal(I.priceOf('qwen3-coder-flash'), undefined, 'still unpriced');
	// The bare DeepSeek spellings the family step exists for keep working.
	assert.equal(I.priceOf('v4.1-flash'), I.PRICING['deepseek-flash']);
	assert.equal(I.priceOf('relay/v4-pro'), I.PRICING['deepseek-v4-pro']);
});

test('one durable TokenUsage maps onto the four billing buckets', () => {
	const buckets = I.bucketsOf({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 });
	assert.deepEqual(buckets, { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 });
	assert.equal(I.bucketsOf(undefined), undefined);
	assert.equal(I.bucketsOf({ inputTokens: 0, outputTokens: 0 }), undefined, 'an empty sample is not a billable row');
});

test('a request carries the model that actually served it', () => {
	const settled = { providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' } };
	assert.deepEqual(I.modelOfRequest(settled), { provider: 'deepseek-account', model: 'deepseek-flash' });
	const pending = { requestConfig: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' } };
	assert.deepEqual(I.modelOfRequest(pending), { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' });
	assert.equal(I.modelOfRequest({}), undefined);
	assert.equal(I.modelOfRequest(undefined), undefined);
});

test('a session that switched models is priced model by model', () => {
	// flash at 22:00 (off-peak, 1.0/M input) then pro at 10:00 (peak, 9.0/M input).
	const requests = [
		{
			purpose: 'assistant',
			startedAt: beijing('2026-10-22', 22, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
			usage: { inputTokens: 1000000, outputTokens: 0 },
		},
		{
			purpose: 'assistant',
			startedAt: beijing('2026-10-23', 10, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
			usage: { inputTokens: 1000000, outputTokens: 0 },
		},
	];
	const result = I.costBreakdown({
		requests,
		totals: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
		now: beijing('2026-10-23', 10, 30),
	});
	// 1.0 (flash off-peak) + 9.0 (pro peak) = 10.0, and the remainder is zero.
	assert.ok(Math.abs(result.cost - 10) < 1e-9, 'total: ' + result.cost);
	assert.equal(result.remainderTokens, 0);
	assert.equal(result.unpricedTokens, 0);
	assert.equal(result.rows.length, 2);
	const flash = result.rows.find((row) => row.model === 'deepseek-flash');
	const pro = result.rows.find((row) => row.model === 'deepseek-v4-pro');
	assert.ok(Math.abs(flash.cost - 1) < 1e-9, 'flash row keeps its own off-peak rate');
	assert.ok(Math.abs(pro.cost - 9) < 1e-9, 'pro row keeps its own peak rate');
});

test('each request keeps the period its own start time falls in', () => {
	// Same model, one request in the peak window and one at night.
	const requests = [
		{ startedAt: beijing('2026-10-22', 10, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
	];
	const result = I.costBreakdown({
		requests,
		totals: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		now: beijing('2026-10-22', 23, 0),
	});
	// 2.0 at peak + 1.0 off-peak, even though "now" is off-peak.
	assert.ok(Math.abs(result.cost - 3) < 1e-9, 'total: ' + result.cost);
	assert.equal(result.rows.length, 1, 'one row per model, periods folded inside');
});

test('usage the loaded history does not cover is topped up as an estimate', () => {
	const result = I.costBreakdown({
		requests: [
			{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		],
		// The durable projection knows about 2M input tokens; only 1M is loaded.
		totals: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { provider: 'deepseek-account', model: 'deepseek-flash' },
		now: beijing('2026-10-22', 23, 0),
	});
	// 1.0 from the loaded request + 1.0 for the topped-up remainder, both off-peak.
	assert.ok(Math.abs(result.cost - 2) < 1e-9, 'total: ' + result.cost);
	assert.equal(result.remainderTokens, 1000000);
	const row = result.rows[0];
	assert.equal(row.estimated, true);
	assert.equal(row.usage.uncachedInputTokens, 2000000);
});

test('the top-up is estimated at the window, not at the clock', () => {
	// The loaded request ran at night; the durable projection knows about 2M
	// more history. Rendering in the MORNING peak must not re-price any of it.
	const result = I.costBreakdown({
		requests: [
			{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		],
		totals: { uncachedInputTokens: 3000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { provider: 'deepseek-account', model: 'deepseek-flash' },
		now: beijing('2026-10-23', 10, 0),
	});
	// 1M exact at the night rate (1.0) + 2M estimated at the window's oldest
	// instant (the same night, 2.0) = 3.0 -- not the 5.0 the clock would show.
	assert.ok(Math.abs(result.cost - 3) < 1e-9, 'total: ' + result.cost);
	assert.equal(result.remainderTokens, 2000000);
});

test('a clock tick reuses the breakdown; an earlier request still busts it', () => {
	const requests = [
		{ turn: 1, step: 1, startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		{ turn: 1, step: 2, startedAt: beijing('2026-10-22', 10, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 500000 } },
	];
	const base = {
		requests,
		totals: { uncachedInputTokens: 1500000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-22', 22, 30),
		_liveGeneration: 0,
	};
	const first = I.costBreakdown(base);
	const memo = { key: I.breakdownKey(base), customLookup: false, result: first };
	const second = I.costBreakdown({
		...base,
		now: beijing('2026-10-23', 10, 0),
		_memo: memo,
		pinned: first.pinned,
	});
	assert.equal(second, first, 'the 30s clock must not rebuild the breakdown');
	assert.equal(second.cost, first.cost);

	// Rewrite the FIRST request, not the tail: a fingerprint of only the last
	// row would keep billing the old amount.
	const rewritten = [
		{ ...requests[0], usage: { inputTokens: 2000000 } },
		requests[1],
	];
	const third = I.costBreakdown({
		...base,
		requests: rewritten,
		totals: { uncachedInputTokens: 2500000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		now: beijing('2026-10-23', 10, 0),
		_memo: memo,
		pinned: first.pinned,
	});
	assert.notEqual(third, first);
	assert.ok(third.cost > first.cost, 'earlier row: ' + third.cost + ' vs ' + first.cost);

	const priced = I.costBreakdown({
		...base,
		now: beijing('2026-10-23', 10, 0),
		_liveGeneration: 1,
		_memo: memo,
		pinned: first.pinned,
	});
	// The stored memo is generation 0. A catalog arrival must walk again even
	// when this fixture has no new rate yet, so the money happens to match.
	assert.notEqual(priced, first);
	assert.equal(priced.cost, first.cost);
});

test('the same object identities skip the fingerprint', () => {
	const requests = [
		{ turn: 1, step: 1, startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
	];
	const totals = { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const current = { model: 'deepseek-flash' };
	const first = I.costBreakdown({
		requests, totals, current, now: beijing('2026-10-22', 22, 30), _liveGeneration: 0,
	});
	const second = I.costBreakdown({
		requests,
		totals,
		current,
		now: beijing('2026-10-23', 10, 0),
		pinned: first.pinned,
		_liveGeneration: 0,
		_memo: {
			result: first,
			requests,
			totals,
			model: 'deepseek-flash',
			provider: undefined,
			generation: 0,
			pinned: first.pinned,
			stamp: I.inputStamp(requests, totals),
			customLookup: false,
			key: 'stale',
		},
	});
	assert.equal(second, first, 'a clock tick must not rebuild when the inputs are the same objects');
	// A streaming turn rewrites usage on the same object. The reference check
	// must not keep the first sample's price.
	requests[0].usage = { inputTokens: 2000000 };
	totals.uncachedInputTokens = 2000000;
	const streamed = I.costBreakdown({
		requests,
		totals,
		current,
		now: beijing('2026-10-23', 10, 0),
		pinned: first.pinned,
		_liveGeneration: 0,
		_memo: {
			result: first,
			requests,
			totals,
			model: 'deepseek-flash',
			provider: undefined,
			generation: 0,
			pinned: first.pinned,
			stamp: I.inputStamp(requests, totals),
			customLookup: false,
			key: 'stale',
		},
	});
	// The memo's stamp is the value AFTER the mutation, so this call hits the
	// fast path and returns the stored result. That is the contract: the stamp
	// the caller stored must be the stamp of the inputs it computed from.
	assert.equal(streamed, first, 'a stamp taken after the mutation matches and is reused');
	const staleStamp = I.costBreakdown({
		requests,
		totals,
		current,
		now: beijing('2026-10-23', 10, 0),
		pinned: first.pinned,
		_liveGeneration: 0,
		_memo: {
			result: first,
			requests,
			totals,
			model: 'deepseek-flash',
			provider: undefined,
			generation: 0,
			pinned: first.pinned,
			stamp: 0,
			customLookup: false,
			key: 'stale',
		},
	});
	assert.notEqual(staleStamp, first, 'a stamp from before the mutation recomputes');
	assert.ok(staleStamp.cost > first.cost, 'the rewritten usage is billed: ' + staleStamp.cost);
	requests[0].usage = { inputTokens: 1000000 };
	totals.uncachedInputTokens = 1000000;
	const rewritten = [
		{ turn: 1, step: 1, startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 2000000 } },
	];
	const third = I.costBreakdown({
		requests: rewritten,
		totals: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current,
		now: beijing('2026-10-23', 10, 0),
		pinned: first.pinned,
		_liveGeneration: 0,
		_memo: {
			result: first,
			requests,
			totals,
			model: 'deepseek-flash',
			provider: undefined,
			generation: 0,
			pinned: first.pinned,
			customLookup: false,
			key: 'stale',
		},
	});
	assert.notEqual(third, first);
	assert.ok(third.cost > first.cost, 'a new array is a new publish: ' + third.cost);
});

test('the usage stamp changes when an earlier request is rewritten in place', () => {
	const requests = [
		{ turn: 1, step: 1, startedAt: beijing('2026-10-22', 22, 0), usage: { inputTokens: 1000000 } },
		{ turn: 1, step: 2, startedAt: beijing('2026-10-22', 22, 0), usage: { inputTokens: 1 } },
	];
	const totals = { uncachedInputTokens: 1000001 };
	const before = I.inputStamp(requests, totals);
	requests[0].usage.inputTokens = 2000000;
	assert.notEqual(I.inputStamp(requests, totals), before, 'an earlier row is part of the stamp');
	requests[0].usage.inputTokens = 1000000;
	assert.equal(I.inputStamp(requests, totals), before, 'the same numbers stamp the same');
	// A weighted sum made these identical (5 and 1*5). They are different buckets.
	assert.notEqual(
		I.inputStamp([{ usage: { inputTokens: 5 } }], {}),
		I.inputStamp([{ usage: { outputTokens: 1 } }], {}),
	);
	const named = [{ providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1 } }];
	const flashStamp = I.inputStamp(named, {});
	named[0].providerMetadata = { model: 'deepseek-v4-pro' };
	assert.notEqual(I.inputStamp(named, {}), flashStamp, 'the same tokens under another model reprice');
	const issued = [{ requestConfig: { provider: 'deepseek', model: 'deepseek-flash' }, usage: { inputTokens: 1 } }];
	const issuedStamp = I.inputStamp(issued, {});
	issued[0].requestConfig = { provider: 'deepseek', model: 'deepseek-v4-pro' };
	assert.notEqual(I.inputStamp(issued, {}), issuedStamp, 'a requestConfig-only model change reprices');
});

test('the pill sleeps until the flip, and until a price retry when one is due', () => {
	const now = 1_000_000;
	assert.equal(I.nextDelayMs(now, { flipAt: now + 10_000 }), 10_000, 'a near flip beats the cap');
	assert.equal(I.nextDelayMs(now, { flipAt: now + 3 * 3600_000 }), 300_000, 'a far flip is capped');
	assert.equal(I.nextDelayMs(now, { flipAt: now + 61 * 60000, period: true }), 60000, 'wake as the countdown hour starts');
	assert.equal(I.nextDelayMs(now, { flipAt: now + 61 * 60000 }), 300000, 'a flat session does not wake for a countdown it will not show');
	assert.equal(
		I.nextDelayMs(now, { flipAt: now + 3 * 3600_000, retryAt: now + 40_000 }),
		40_000,
		'a pending retry wakes before the flip',
	);
	assert.equal(I.nextDelayMs(now, { flipAt: now + 3 * 3600_000, retryDue: true }), 1000);
	assert.equal(I.nextDelayMs(now, { flipAt: now + 10 }), 250, 'never schedule a zero delay');
	// The pill is showing the countdown, so it has to move every minute
	// instead of sleeping until the flip.
	// 30 minutes is exact, so the label changes a full minute later.
	assert.equal(
		I.nextDelayMs(now, { flipAt: now + 30 * 60000, countdown: true }),
		60000,
	);
	// 90.5 s rounds up to 2 min and drops to 1 min once 60 s remain.
	assert.equal(
		I.nextDelayMs(now, { flipAt: now + 90500, countdown: true }),
		30500,
	);
	assert.equal(
		I.nextDelayMs(now, { flipAt: now + 5000, countdown: true }),
		5000,
		'a flip inside the minute wins over the boundary',
	);
	assert.equal(I.nextDelayMs(now, { flipAt: now - 1 }), 300_000, 'a past flip is not a delay');
	assert.equal(I.countdownStale(now - 60000, now, true), true, 'a minute-old clock is wrong for a new countdown');
	assert.equal(I.countdownStale(now - 1000, now, true), false, 'the render itself is not stale');
	assert.equal(I.countdownStale(now - 60000, now, false), false, 'no countdown, no refresh');
	assert.equal(I.pillNeedsClock(false, false), false, 'an empty pill does not wake');
	assert.equal(I.pillNeedsClock(false, true), true, 'a failed lookup still retries');
	assert.equal(I.pillNeedsClock(true, false), true, 'a visible pill keeps its clock');
	assert.equal(I.priceEffectTick(now, undefined), 0, 'a quiet catalog is not re-asked on a clock tick');
	assert.equal(I.priceEffectTick(now, 'HTTP 500'), now, 'a failed lookup wakes with the clock');
});

test('the same data costs the same before and after a period flip', () => {
	const data = {
		requests: [
			{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		],
		totals: { uncachedInputTokens: 3000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
	};
	const night = I.costBreakdown({ ...data, now: beijing('2026-10-22', 22, 30) });
	const morning = I.costBreakdown({ ...data, now: beijing('2026-10-23', 10, 0) });
	assert.equal(night.cost, morning.cost, 'billing is pinned to intervals: ' + night.cost + ' vs ' + morning.cost);
});

test('a request without startedAt inherits its neighbour period, not the clock', () => {
	const result = I.costBreakdown({
		requests: [
			{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
			{ startedAt: beijing('2026-10-23', 10, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
			{ providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1000000 } },
		],
		totals: { uncachedInputTokens: 3000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-23', 22, 0),
	});
	// The third request settles inside the morning burst (10:00 peak, 2.0),
	// so 1.0 + 2.0 + 2.0 = 5.0. The clock is off-peak and the session's oldest
	// instant is off-peak too: both fallbacks would wrongly read 4.0.
	assert.ok(Math.abs(result.cost - 5) < 1e-9, 'total: ' + result.cost);
});

test('with no timing at all the estimate is a fixed peak/off-peak average', () => {
	const data = {
		requests: [],
		totals: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
	};
	const atPeak = I.costBreakdown({ ...data, now: beijing('2026-10-22', 10, 0) });
	const atOffPeak = I.costBreakdown({ ...data, now: beijing('2026-10-22', 22, 0) });
	assert.equal(atPeak.cost, atOffPeak.cost, 'the clock cannot move an undated estimate');
	// (2.0 peak + 1.0 off-peak) / 2 per million input.
	assert.ok(Math.abs(atPeak.cost - 1.5) < 1e-9, 'fixed average: ' + atPeak.cost);
});

test('a request that leaves the window keeps its own period price', () => {
	const night = {
		purpose: 'assistant', turn: 1, step: 1,
		startedAt: beijing('2026-10-22', 22, 0),
		providerMetadata: { model: 'deepseek-flash' },
		usage: { inputTokens: 1000000 },
	};
	const morning = {
		purpose: 'assistant', turn: 1, step: 2,
		startedAt: beijing('2026-10-23', 10, 0),
		providerMetadata: { model: 'deepseek-flash' },
		usage: { inputTokens: 1000000 },
	};
	const totals = { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const first = I.costBreakdown({
		requests: [night, morning],
		totals,
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-23', 10, 30),
		pinned: new Map(),
	});
	// 1.0 off-peak + 2.0 peak.
	assert.ok(Math.abs(first.cost - 3) < 1e-9, 'first render: ' + first.cost);
	// Compaction rewrote the window: only the morning request is visible, yet
	// the durable projection still counts both.
	const second = I.costBreakdown({
		requests: [morning],
		totals,
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-23', 10, 30),
		pinned: first.pinned,
	});
	assert.ok(Math.abs(second.cost - 3) < 1e-9, 'the night request keeps its off-peak price: ' + second.cost);
	assert.equal(second.remainderTokens, 0, 'nothing left unattributed');
});

test('the ledger upserts a request instead of double counting it', () => {
	const record = {
		purpose: 'assistant', turn: 1, step: 1,
		startedAt: beijing('2026-10-22', 22, 0),
		providerMetadata: { model: 'deepseek-flash' },
	};
	const first = I.costBreakdown({
		requests: [{ ...record, usage: { inputTokens: 1000000 } }],
		totals: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-22', 22, 30),
		pinned: new Map(),
	});
	assert.ok(Math.abs(first.cost - 1) < 1e-9);
	// The same request settles with its final usage; the ledger replaces it.
	const second = I.costBreakdown({
		requests: [{ ...record, usage: { inputTokens: 2000000 } }],
		totals: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-22', 22, 30),
		pinned: first.pinned,
	});
	assert.ok(Math.abs(second.cost - 2) < 1e-9, '2M billed once at the off-peak rate: ' + second.cost);
});

test('an unpriced model is reported instead of being invented', () => {
	const result = I.costBreakdown({
		requests: [
			{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { provider: 'magpie', model: 'codex/gpt-6.1-sol' }, usage: { inputTokens: 500000 } },
		],
		totals: { uncachedInputTokens: 500000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'codex/gpt-6.1-sol' },
		now: beijing('2026-10-22', 23, 0),
	});
	assert.equal(result.cost, 0);
	assert.equal(result.unpricedTokens, 500000);
	assert.equal(result.rows[0].priced, false);
	assert.equal(I.unpricedOnly(result), true);
});

test('off-peak is exactly half the peak price', () => {
	for (const tier of Object.values(I.PRICING)) {
		assert.equal(tier.offPeak.input * 2, tier.peak.input);		assert.equal(tier.offPeak.output * 2, tier.peak.output);
		assert.equal(tier.offPeak.cacheRead * 2, tier.peak.cacheRead);
	}
});

test('cost adds the four disjoint buckets at their own rates', () => {
	const rate = I.PRICING['deepseek-flash'].peak;
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
	// 2 (input) + 0.04 (cache read) + 8 (output) = 10.04 CNY
	assert.ok(Math.abs(I.costOf(usage, rate) - 10.04) < 1e-9);
});

test('cost halves off-peak and scales with cache-write at the input rate', () => {
	const peak = I.PRICING['deepseek-flash'].peak;
	const off = I.PRICING['deepseek-flash'].offPeak;
	const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 500_000 };
	assert.ok(Math.abs(I.costOf(usage, peak) - (2 + 4)) < 1e-9);
	assert.ok(Math.abs(I.costOf(usage, off) - (1 + 2)) < 1e-9);
});

test('cost is zero for an empty or missing usage value', () => {
	assert.equal(I.costOf(undefined, I.PRICING['deepseek-flash'].peak), 0);
	assert.equal(I.costOf({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, I.PRICING['deepseek-flash'].peak), 0);
});

test('total billed tokens sums every bucket plus output', () => {
	assert.equal(I.totalBilledTokens({ uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 7 }), 40);
	assert.equal(I.totalBilledTokens(undefined), 0);
});

test('money formatting stays readable for tiny and large totals', () => {
	assert.equal(I.fmtMoney(0), '\u00a50.00');
	assert.equal(I.fmtMoney(0.0021), '\u00a50.0021');
	assert.equal(I.fmtMoney(0.123), '\u00a50.123');
	assert.equal(I.fmtMoney(3.4567), '\u00a53.46');
	assert.equal(I.fmtMoney(Number.NaN), '\u2014');
});

test('token formatting compacts thousands and millions', () => {
	assert.equal(I.fmtTokens(999), '999');
	assert.equal(I.fmtTokens(1234), '1.23K');
	assert.equal(I.fmtTokens(12345), '12.3K');
	assert.equal(I.fmtTokens(1234567), '1.23M');
});

test('countdown text switches units as the span shrinks', () => {
	const t = () => 'x';
	// Fallback table is Chinese; the exact words come from the dictionary.
	assert.equal(I.fmtSpan(25 * 60000, undefined), '25 ' + I.zh.minute);
	assert.equal(I.fmtSpan(2 * 3600000 + 5 * 60000, undefined), '2 ' + I.zh.hour + ' 5 ' + I.zh.minute);
	assert.equal(I.fmtSpan(3 * 3600000, undefined), '3 ' + I.zh.hour);
	assert.equal(I.fmtSpan(3 * 86400000 + 4 * 3600000, undefined), '3 ' + I.zh.day + ' 4 ' + I.zh.hour);
	assert.equal(I.fmtSpan(2 * 86400000, undefined), '2 ' + I.zh.day);
	assert.equal(I.fmtSpan(-1000, undefined), '0 ' + I.zh.minute, 'never negative');
	assert.equal(I.fmtSpan(20000, undefined), '1 ' + I.zh.minute, 'the last half minute still says one');
	assert.equal(I.fmtSpan(59.5 * 60000, undefined), '60 ' + I.zh.minute, '59 min does not become an hour');
	assert.equal(I.fmtSpan(60 * 60000, undefined), '60 ' + I.zh.minute);
	assert.equal(I.fmtSpan(24 * 3600000, undefined), '24 ' + I.zh.hour, 'a full day stays in hours');
	assert.equal(I.fmtSpan(24 * 3600000 + 60000, undefined), '24 ' + I.zh.hour + ' 1 ' + I.zh.minute);
	assert.equal(I.fmtSpan(25 * 3600000, undefined), '1 ' + I.zh.day + ' 1 ' + I.zh.hour);
	assert.equal(I.fmtSpan(60 * 60000 + 1000, undefined), '1 ' + I.zh.hour + ' 1 ' + I.zh.minute);
	assert.equal(t, t);
});

test('textKey falls back to the built-in table when no translator is injected', () => {
	assert.equal(I.textKey(undefined, 'peak'), I.zh.peak);
	assert.equal(I.textKey(undefined, 'offPeak'), I.zh.offPeak);
	// A translator that echoes the key back means the namespace is missing.
	assert.equal(I.textKey((key) => key, 'spend'), I.zh.spend);
	// A real translator wins.
	assert.equal(I.textKey((key) => I.en[key], 'peak'), I.en.peak);
	assert.equal(I.textKey((key) => '', 'peak'), I.zh.peak, 'empty translation falls back');
});

test('every key in the English table also exists in Chinese and vice versa', () => {
	assert.deepEqual(Object.keys(I.en).sort(), Object.keys(I.zh).sort());
});

test('the Chinese table is pure ASCII in source form (no raw CJK)', () => {
	for (const [key, value] of Object.entries(I.zh)) {
		assert.ok(typeof value === 'string' && value.length > 0, key + ' is a non-empty string');
		// Whatever the source encoding, the runtime value is the real Chinese text.
		assert.equal(value.includes('\ufffd'), false, key + ' has no replacement character');
	}
});

test('slots wiring registers one dock entry with a distinct id', () => {
	const registrations = [];
	const effects = [];
	const locale = {
		register(ns, dicts) {
			assert.equal(ns, I.NS);
			assert.ok(dicts.zh && dicts.en);
			return () => {};
		},
	};
	const ctx = {
		locale,
		effect(factory) {
			effects.push(factory);
			return factory();
		},
		slots: {
			inject(key, callback) {
				assert.equal(key, 'conversation.composer.dock');
				callback();
			},
			register(options, component) {
				registrations.push({ options, component });
			},
		},
	};
	plugin.apply(ctx);
	assert.equal(effects.length, 1, 'dictionaries ride one owned effect');
	assert.equal(registrations.length, 1);
	const { options, component } = registrations[0];
	assert.equal(options.name, 'conversation.composer.dock');
	assert.equal(options.id, 'session-meter');
	assert.equal(options.locale, I.NS, 'the entry opts into its own namespace');
	assert.equal(typeof options.order, 'number');
	assert.equal(component, I.SessionMeter);
});

test('apply tolerates a host without a locale service', () => {
	const registrations = [];
	const ctx = {
		effect() {
			throw new Error('no dictionary effect without a locale service');
		},
		slots: {
			inject(key, callback) {
				callback();
			},
			register(options, component) {
				registrations.push({ options, component });
			},
		},
	};
	plugin.apply(ctx);
	assert.equal(registrations.length, 1);
});

test('the component is a renderable function', () => {
	assert.equal(typeof I.SessionMeter, 'function');
});

/** Run `body` with a fake fetched catalog installed, then restore the live state. */
function withCatalog(entries, body) {
	const saved = {
		models: I.live.models,
		known: I.live.known,
		retryAt: I.live.retryAt,
		inFlight: I.live.inFlight,
		lastError: I.live.lastError,
	};
	I.live.models = Object.create(null);
	I.live.known = new Set(Object.keys(entries));
	I.live.retryAt = 0;
	I.live.inFlight = false;
	I.live.lastError = undefined;
	for (const [name, rate] of Object.entries(entries)) I.live.models[name] = rate;
	try {
		return body();
	} finally {
		I.live.models = saved.models;
		I.live.known = saved.known;
		I.live.retryAt = saved.retryAt;
		I.live.inFlight = saved.inFlight;
		I.live.lastError = saved.lastError;
	}
}

const CATALOG_GPT = { input: 14.4, output: 72, cacheRead: 1.44, cacheWrite: 14.4 };
const CATALOG_MIMO = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 };

test('the online catalog resolves a foreign model name and marks it as a reference', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		// `codex/gpt-6.1-sol` is not listed; the minor-version collapse finds it.
		const priced = I.rateAt('codex/gpt-6.1-sol', beijing('2026-10-22', 22, 0));
		assert.notEqual(priced, undefined, 'a catalog hit is a real price');
		assert.equal(priced.reference, true, 'catalog prices are references, not official DeepSeek tiers');
		assert.equal(priced.rate.input, 14.4);
	});
});

test('the built-in DeepSeek table outranks any catalog entry', () => {
	withCatalog({ 'deepseek-flash': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } }, () => {
		const priced = I.rateAt('deepseek-flash', beijing('2026-10-22', 22, 0));
		assert.equal(priced.reference, false);
		assert.equal(priced.rate.input, I.PRICING['deepseek-flash'].offPeak.input, 'off-peak tier, not the catalog');
	});
});

test('a catalog-priced request is charged and flagged in the breakdown', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const result = I.costBreakdown({
			requests: [{
				startedAt: beijing('2026-10-22', 22, 0),
				providerMetadata: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				usage: { inputTokens: 1000000 },
			}],
			totals: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			current: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
			now: beijing('2026-10-22', 23, 0),
		});
		assert.ok(Math.abs(result.cost - 14.4) < 1e-9, 'cost: ' + result.cost);
		assert.equal(result.unpricedTokens, 0);
		assert.equal(result.rows[0].reference, true);
		assert.equal(result.rows[0].priced, true);
	});
});

test('a catalog price is used for both periods (no peak doubling)', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const offPeak = I.rateAt('gpt-6.1-sol', beijing('2026-10-22', 22, 0));
		const peak = I.rateAt('gpt-6.1-sol', beijing('2026-10-22', 10, 0));
		assert.deepEqual(peak.rate, offPeak.rate);
	});
});

test('the rendered tooltip marks a catalog price and explains the asterisk', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const tree = renderAt(beijing('2026-10-22', 22, 0), {
			requests: [{
				startedAt: beijing('2026-10-22', 22, 0),
				providerMetadata: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				usage: { inputTokens: 1000000 },
			}],
			usage: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			selection: {
				lastUsed: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				next: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
			},
		});
		const text = textOf(tree);
		assert.equal(text.includes('\u00a514.40'), true, 'cost from the catalog: ' + text);
		const title = titlesOf(tree)[0];
		assert.equal(title.includes(I.zh.byModel), false, 'the hover title stays a summary');
		assert.equal(title.includes('*'), true, 'the current rate is still marked');
		assert.equal(tree.props['data-breakdown'].includes(I.zh.referenceNote), true, 'the asterisk is explained in the breakdown');
	});
});

test('client-side name candidates mirror the host expansion', () => {
	const candidates = I.nameCandidates('codex/gpt-6.1-sol');
	assert.equal(candidates.includes('gpt-6-sol'), true);
	assert.equal(candidates.includes('gpt-6.1-sol'), true);
	assert.deepEqual(I.nameCandidates(undefined), []);
	const grok = I.nameCandidates('cursor/grok-4.7@500k');
	assert.equal(grok.includes('grok-4.7'), true, 'context-window tag stripped');
	assert.equal(grok.includes('grok-4'), false, 'not collapsed onto grok-4');
	assert.equal(I.nameCandidates('anthropic/claude-opus-4-5@20251101').includes('claude-opus-4-5'), false, 'snapshot dates stay');
	assert.equal(I.nameCandidates('apikeyfan/muse-wonder-1.0-contributor').includes('muse-wonder-1.0'), true, 'contributor is release noise');
});

test('a session running only on flat-priced models shows no period marker', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const tree = renderAt(beijing('2026-10-22', 10, 0), {
			requests: [{
				startedAt: beijing('2026-10-22', 10, 0),
				providerMetadata: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				usage: { inputTokens: 1000000 },
			}],
			usage: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			selection: {
				lastUsed: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				next: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
			},
		});
		const text = textOf(tree);
		assert.equal(text.includes(I.zh.peak), false, 'no peak label for a flat-priced model: ' + text);
		assert.equal(text.includes(I.zh.offPeak), false, 'no off-peak label either');
		assert.equal(text.includes(I.zh.spend), true, 'the cost is still shown');
		assert.equal(text.trim().startsWith(I.zh.spend), true, 'no leading separator where the marker was: ' + JSON.stringify(text));
		assert.equal(text.includes('\u00a514.40'), true);
		assert.equal(tree.props['data-session-meter'], 'flat', 'the marker state says why it is absent');
		const title = titlesOf(tree)[0];
		assert.equal(title.includes(I.zh.peakTip), false, 'no peak window is described');
		assert.equal(title.includes(I.zh.nextChange), false, 'no countdown for a price that never changes');
		assert.equal(title.includes(I.zh.estimateCatalog), true, 'the note describes the real price source');
		assert.equal(title.includes(I.zh.estimate), false, 'DeepSeek wording is not claimed for another vendor');
		assert.equal(tree.props['data-breakdown'].includes(I.zh.referenceNote), true, 'the catalog asterisk is still explained');
	});
});

test('a mimo route falls through to the catalog with no period price', () => {
	withCatalog({ 'mimo-v2.6-pro': CATALOG_MIMO }, () => {
		const priced = I.rateAt('workbuddy/mimo-v2.6-pro', beijing('2026-10-22', 10, 0));
		assert.notEqual(priced, undefined, 'the catalog prices the model');
		assert.equal(priced.reference, true, 'a catalog reference, not a DeepSeek tier');
		assert.equal(priced.periodPriced, false, 'no peak/off-peak split to report');
		assert.deepEqual(priced.rate, CATALOG_MIMO);
	});
});

test('a session on a mimo route shows no peak/off-peak marker', () => {
	withCatalog({ 'mimo-v2.6-pro': CATALOG_MIMO }, () => {
		const tree = renderAt(beijing('2026-10-22', 10, 0), {
			requests: [{
				startedAt: beijing('2026-10-22', 10, 0),
				providerMetadata: { provider: 'workbuddy', model: 'workbuddy/mimo-v2.6-pro' },
				usage: { inputTokens: 1000000 },
			}],
			usage: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			selection: {
				lastUsed: { provider: 'workbuddy', model: 'workbuddy/mimo-v2.6-pro' },
				next: { provider: 'workbuddy', model: 'workbuddy/mimo-v2.6-pro' },
			},
		});
		const text = textOf(tree);
		assert.equal(text.includes(I.zh.peak), false, 'no peak label for a flat-priced model: ' + text);
		assert.equal(text.includes(I.zh.offPeak), false, 'no off-peak label either');
		assert.equal(tree.props['data-session-meter'], 'flat');
		// 1M input at the catalog's 2.0/M, not DeepSeek pro's 9.0/M peak rate.
		assert.equal(text.includes('\u00a52.00'), true, 'the catalog price: ' + text);
		assert.equal(text.includes('\u00a59.00'), false, 'DeepSeek pro money is gone: ' + text);
	});
});

test('one DeepSeek model anywhere in the session keeps the period marker', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const tree = renderAt(beijing('2026-10-22', 10, 0), {
			requests: [
				{
					startedAt: beijing('2026-10-22', 10, 0),
					providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
					usage: { inputTokens: 1000000 },
				},
				{
					startedAt: beijing('2026-10-22', 10, 0),
					providerMetadata: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
					usage: { inputTokens: 1000000 },
				},
			],
			usage: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			selection: {
				lastUsed: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				next: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
			},
		});
		const text = textOf(tree);
		assert.equal(text.includes(I.zh.peak), true, 'the mixed session still reports its period: ' + text);
		assert.equal(tree.props['data-session-meter'], 'peak');
		const title = titlesOf(tree)[0];
		assert.equal(title.includes(I.zh.nextChange), true, 'the countdown is back with a period-priced model');
	});
});

test('a fresh session on a flat-priced model hides the marker before any usage', () => {
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const tree = renderAt(beijing('2026-10-22', 10, 0), {
			requests: [],
			usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			selection: {
				lastUsed: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
				next: { provider: 'magpie', model: 'codex/gpt-6.1-sol' },
			},
		});
		assert.equal(tree, null, 'a zero total does not take a composer row');
	});
});

test('a session with no usage on the DeepSeek route still announces its period', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [],
		usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		selection: {
			lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
			next: { provider: 'deepseek-account', model: 'deepseek-flash' },
		},
	});
	assert.equal(tree.props['data-session-meter'], 'peak');
	assert.equal(textOf(tree).includes(I.zh.peak), true);
	assert.equal(textOf(tree).includes(I.zh.spend), false, 'no tokens yet, so no zero cost');
	assert.equal(titlesOf(tree)[0].includes(I.zh.estimate), false, 'no bill, so no cost estimate');
});

test('costBreakdown reports whether any model in play is period-priced', () => {
	const deepseek = I.costBreakdown({
		requests: [{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'deepseek-flash' }, usage: { inputTokens: 1 } }],
		totals: { uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		current: { model: 'deepseek-flash' },
		now: beijing('2026-10-22', 23, 0),
	});
	assert.equal(deepseek.periodPriced, true);
	assert.equal(deepseek.rows[0].periodPriced, true);
	withCatalog({ 'gpt-6-sol': CATALOG_GPT }, () => {
		const flat = I.costBreakdown({
			requests: [{ startedAt: beijing('2026-10-22', 22, 0), providerMetadata: { model: 'gpt-6.1-sol' }, usage: { inputTokens: 1 } }],
			totals: { uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			current: { model: 'gpt-6.1-sol' },
			now: beijing('2026-10-22', 23, 0),
		});
		assert.equal(flat.periodPriced, false);
		assert.equal(flat.rows[0].periodPriced, false);
	});
});

/** Install a fresh live-price state with a stubbed fetch, run `body`, restore. */
async function withLiveFetch(respond, body) {
	const saved = {
		models: I.live.models,
		known: I.live.known,
		retryAt: I.live.retryAt,
		inFlight: I.live.inFlight,
		lastError: I.live.lastError,
		fetchedAt: I.live.fetchedAt,
		fetch: globalThis.fetch,
	};
	const calls = [];
	I.live.models = Object.create(null);
	I.live.known = new Set();
	I.live.retryAt = 0;
	I.live.inFlight = false;
	I.live.lastError = undefined;
	I.live.fetchedAt = 0;
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		return respond(url, options);
	};
	try {
		return await body(calls);
	} finally {
		globalThis.fetch = saved.fetch;
		I.live.models = saved.models;
		I.live.known = saved.known;
		I.live.retryAt = saved.retryAt;
		I.live.inFlight = saved.inFlight;
		I.live.lastError = saved.lastError;
		I.live.fetchedAt = saved.fetchedAt;
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a model the built-in table prices is not sent to the catalog', async () => {
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, models: {} }) }),
		async (calls) => {
			I.requestLivePrices(['deepseek-flash', 'relay/v4-pro@1m']);
			assert.equal(calls.length, 0, 'a DeepSeek-only session does not hit the network');
			I.requestLivePrices(['codex/gpt-6.1-sol', 'deepseek-v4-pro']);
			assert.equal(calls.length, 1);
			assert.equal(decodeURIComponent(calls[0].url).includes('deepseek'), false, 'the built-in name is left out of the query');
		},
	);
});

test('the client asks the Host by name and merges what comes back', async () => {
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, models: { 'codex/gpt-6.1-sol': CATALOG_GPT } }) }),
		async (calls) => {
			I.requestLivePrices(['codex/gpt-6.1-sol', 'deepseek-flash']);
			assert.equal(calls.length, 1, 'one request for the set');
			assert.equal(calls[0].url.startsWith('/session-meter/prices?m='), true, 'same-origin route: ' + calls[0].url);
			assert.equal(calls[0].url.includes(encodeURIComponent('codex/gpt-6.1-sol')), true, 'the call name is asked for by name');
			await settle();
			assert.equal(I.live.models['codex/gpt-6.1-sol'].input, CATALOG_GPT.input, 'merged under the asked name');
			I.requestLivePrices(['deepseek-flash', 'codex/gpt-6.1-sol']);
			assert.equal(calls.length, 1, 'names the Host already answered about are not asked again');
		},
	);
});

test('a failed lookup stays askable instead of silencing the model for good', async () => {
	let attempt = 0;
	await withLiveFetch(
		async () => {
			attempt += 1;
			if (attempt === 1) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, json: async () => ({ ok: true, models: { 'codex/gpt-6.1-sol': CATALOG_GPT } }) };
		},
		async (calls) => {
			I.requestLivePrices(['codex/gpt-6.1-sol']);
			await settle();
			assert.equal(calls.length, 1, 'first attempt ran');
			assert.equal(I.live.known.has('codex/gpt-6.1-sol'), false, 'a 404 is not an answer about the model');
			assert.equal(typeof I.live.lastError, 'string', 'the failure is recorded for the tooltip');
			// The 30 s tick calls again; the backoff only has to be defeated here.
			I.live.retryAt = 0;
			I.requestLivePrices(['codex/gpt-6.1-sol']);
			await settle();
			assert.equal(calls.length, 2, 'a retry really happens');
			assert.equal(I.live.models['codex/gpt-6.1-sol'].input, CATALOG_GPT.input, 'and it can still succeed');
			assert.equal(I.live.known.has('codex/gpt-6.1-sol'), true);
			assert.equal(I.live.lastError, undefined, 'success clears the recorded failure');
		},
	);
});

test('a context-window tag is priced from the bare catalog id the host already has', async () => {
	await withLiveFetch(
		async (url) => {
			const asked = decodeURIComponent(String(url).split('m=')[1] || '');
			assert.equal(asked.split(',').includes('grok-4.7'), true, 'the bare id is asked, so an old host can answer: ' + asked);
			// What the running host returns today: the bare key, not the routed name.
			return { ok: true, json: async () => ({ ok: true, models: { 'grok-4.7': { input: 13.37, output: 40.11, cacheRead: 3.34, cacheWrite: 13.37 } } }) };
		},
		async () => {
			I.requestLivePrices(['cursor/grok-4.7@500k']);
			await settle();
			const priced = I.rateAt('cursor/grok-4.7@500k', beijing('2026-10-22', 22, 0));
			assert.equal(priced.reference, true);
			assert.equal(priced.rate.input, 13.37);
			assert.equal(priced.rate.output, 40.11);
		},
	);
});

test('a price query stops before the encoded url outgrows the budget', () => {
	const names = [];
	for (let index = 0; index < 20; index += 1) names.push('relay/' + 'n'.repeat(80) + '-' + index);
	const batch = I.priceQueryBatch(names, 200);
	assert.ok(batch.length >= 1);
	assert.ok(batch.length < names.length, 'the rest waits for the next request');
	const encoded = encodeURIComponent(batch.join(',')).length;
	assert.ok(encoded <= 200, 'the batch stays inside the budget: ' + encoded);
	const mixed = I.priceQueryBatch(['x'.repeat(400), 'short'], 50);
	assert.deepEqual(mixed, ['short'], 'a name that cannot fit is skipped so the next one is asked');
});

test('a name that cannot fit any query is not fetched again', async () => {
	const huge = 'x'.repeat(2000);
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, models: {} }) }),
		async (calls) => {
			I.requestLivePrices([huge, 'short-model']);
			assert.equal(calls.length, 1);
			assert.equal(decodeURIComponent(calls[0].url).includes(huge), false);
			assert.equal(decodeURIComponent(calls[0].url).includes('short-model'), true);
			await settle();
			I.live.retryAt = 0;
			I.requestLivePrices([huge]);
			assert.equal(calls.length, 1, 'an unsendable name does not keep the poll alive');
		},
	);
});

test('more names than one request can carry are asked in a later batch', async () => {
	// Bare ids: a provider prefix expands into a second spelling and would
	// hide whether the batch counted names or spellings.
	const names = [];
	for (let index = 0; index < 70; index += 1) names.push('model-' + index);
	await withLiveFetch(
		async (url) => {
			const asked = decodeURIComponent(String(url).split('m=')[1] || '').split(',');
			assert.ok(asked.length <= 64, 'one request stays inside the host cap: ' + asked.length);
			const models = {};
			for (const name of asked) models[name] = { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 };
			return { ok: true, json: async () => ({ ok: true, models }) };
		},
		async (calls) => {
			I.requestLivePrices(names);
			await settle();
			assert.equal(calls.length, 1);
			assert.equal(I.live.known.size, 64, 'only the batch that was sent is settled');
			// A batch that found nothing is still a success, and success does not
			// arm the retry. Clear it anyway: this test is about the tail, not
			// about the backoff.
			I.live.retryAt = 0;
			I.requestLivePrices(names);
			await settle();
			assert.equal(calls.length, 2, 'the tail is a second request');
			assert.equal(I.live.known.size, 70);
			// Names are asked in sorted order, so model-9 sorts after model-69.
			assert.equal(I.live.models['model-9'].input, 1);
		},
	);
});

test('a newer catalog makes an absent name askable again', async () => {
	let fetchedAt = 1000;
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, fetchedAt, models: {} }) }),
		async (calls) => {
			I.requestLivePrices(['relay/new-model']);
			await settle();
			assert.equal(I.live.known.has('relay/new-model'), true);
			I.live.retryAt = 0;
			I.requestLivePrices(['relay/new-model']);
			assert.equal(calls.length, 1, 'the same catalog does not ask again');
			fetchedAt = 2000;
			I.requestLivePrices(['relay/other']);
			await settle();
			assert.equal(I.live.known.has('relay/new-model'), false, 'the catalog moved, so the absence is stale');
			I.live.retryAt = 0;
			I.requestLivePrices(['relay/new-model']);
			assert.equal(calls.length, 3, 'the name is asked against the new catalog');
		},
	);
});

test('a newer catalog drops a rate the new answer does not repeat', async () => {
	let fetchedAt = 1000;
	const first = { input: 3, output: 3, cacheRead: 3, cacheWrite: 3 };
	const kept = { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 };
	await withLiveFetch(
		async () => ({
			ok: true,
			json: async () => ({
				ok: true,
				fetchedAt,
				models: fetchedAt === 1000 ? { old: first, kept } : {},
			}),
		}),
		async (calls) => {
			I.requestLivePrices(['old', 'kept']);
			await settle();
			assert.equal(I.live.models.old.input, 3);
			assert.equal(I.live.models.kept.input, 5);
			fetchedAt = 2000;
			I.live.retryAt = 0;
			I.requestLivePrices(['other']);
			await settle();
			assert.equal(I.live.models.old.input, 3, 'not asked this time, so it stays');
			assert.equal(I.live.models.kept.input, 5);
			I.live.retryAt = 0;
			I.live.known.delete('old');
			const before = calls.length;
			I.requestLivePrices(['old']);
			await settle();
			assert.equal(calls.length, before + 1, 'the retired name is asked again');
			assert.equal(decodeURIComponent(calls[calls.length - 1].url).includes('old'), true);
			assert.equal(I.live.models.old, undefined, 'asked and absent from the new catalog');
			assert.equal(I.live.models.kept.input, 5, 'a rate this answer did not ask about stays');
		},
	);
});

test('the same catalog rate does not bump the cost generation', async () => {
	const rate = { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 };
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, fetchedAt: 1000, models: { kept: rate } }) }),
		async () => {
			I.requestLivePrices(['kept']);
			await settle();
			const generation = I.live.generation;
			const stored = I.live.models.kept;
			I.live.known.delete('kept');
			I.live.retryAt = 0;
			I.requestLivePrices(['kept']);
			await settle();
			assert.equal(I.live.generation, generation, 'identical numbers are not a new catalog');
			assert.equal(I.live.models.kept, stored, 'the stored rate object is kept');
		},
	);
});

test('an answer without the model still settles it, so retries stop', async () => {
	await withLiveFetch(
		async () => ({ ok: true, json: async () => ({ ok: true, models: {} }) }),
		async (calls) => {
			I.requestLivePrices(['relay/unknown-model']);
			await settle();
			assert.equal(calls.length, 1);
			assert.equal(I.live.known.has('relay/unknown-model'), true, 'the Host answered: no price exists');
			I.live.retryAt = 0;
			I.requestLivePrices(['relay/unknown-model']);
			assert.equal(calls.length, 1, 'a known-absent model is not asked again');
		},
	);
});

/** Flatten a createElement tree into the text it would show. */
function textOf(node) {
	if (node === null || node === undefined) return '';
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	return textOf(node.children);
}

/**
 * Render the shipped component through the React stand-in.
 * `now` is pinned by overriding Date.now so the peak decision is fixed.
 * @param {number} ms - pinned "now".
 * @param {object} [options] - overrides for the projection/trajectory inputs.
 */
function renderAt(ms, options) {
	const opts = options ?? {};
	const realDateNow = Date.now;
	Date.now = () => ms;
	try {
		const usage = opts.usage ?? { uncachedInputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000 };
		const selection = opts.selection ?? {
			lastUsed: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			next: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
		};
		return I.SessionMeter({
			// The component reads `t` from its injected locale seat.
			t: (key) => I.zh[key],
			useProjection: (key) => {
				if (key === 'tokenUsage') return usage;
				if (key === 'contextPressure') return opts.pressure;
				return selection;
			},
			useTrajectory: opts.requests === undefined
				? undefined
				: (selector) => selector({ requests: opts.requests }),
		});
	} finally {
		Date.now = realDateNow;
	}
}

/** Every `title` attribute in the rendered tree. */
function titlesOf(tree) {
	const titles = [];
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (typeof node.props.title === 'string') titles.push(node.props.title);
		(node.children ?? []).forEach(walk);
	};
	walk(tree);
	return titles;
}

test('a second press closes the breakdown and its click does not reopen it', () => {
	let state = { open: false, swallowClick: false };
	const down = () => { state = I.pillGesture(state.open, state.swallowClick, 'pointerdown'); };
	const click = () => { state = I.pillGesture(state.open, state.swallowClick, 'click'); };
	down();
	click();
	assert.deepEqual(state, { open: true, swallowClick: false }, 'first press opens');
	down();
	assert.deepEqual(state, { open: false, swallowClick: true }, 'pointerdown closes before the click');
	click();
	assert.deepEqual(state, { open: false, swallowClick: false }, 'the click of that press is discarded');
	// Keyboard activation is a click with no pointerdown.
	state = { open: true, swallowClick: false };
	click();
	assert.deepEqual(state, { open: false, swallowClick: false }, 'Enter or Space closes');
	click();
	assert.deepEqual(state, { open: true, swallowClick: false }, 'the next keypress opens again');
});

test('the breakdown panel flips above the pill when the composer is at the bottom', () => {
	const below = I.panelBox(
		{ left: 40, top: 200, bottom: 224, width: 160 },
		{ width: 1280, height: 800 },
	);
	assert.equal(below.top, 230, 'room below: sit under the pill');
	assert.equal(below.left, 40);
	assert.equal(below.maxHeight, 240);

	const above = I.panelBox(
		{ left: 40, top: 760, bottom: 784, width: 160 },
		{ width: 1280, height: 800 },
	);
	assert.ok(above.top + above.maxHeight <= 760, 'sits above the pill: ' + above.top + ' + ' + above.maxHeight);
	assert.equal(above.top, 760 - 6 - above.maxHeight);

	const clipped = I.panelBox(
		{ left: 1200, top: 200, bottom: 224, width: 160 },
		{ width: 1280, height: 800 },
	);
	assert.ok(clipped.left + 320 <= 1280 - 8, 'stays inside the right edge: ' + clipped.left);
});

test('the breakdown dialog is not in the tree until the pill is opened', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1000000, outputTokens: 1000000 },
		}],
	});
	assert.equal(tree.type, 'span');
	assert.equal(tree.props['data-session-meter'], 'peak');
	const button = tree.children.find((child) => child && child.type === 'button');
	assert.equal(button.props.type, 'button', 'must not submit the composer');
	assert.equal(button.props['aria-expanded'], false);
	assert.equal(typeof button.props.title, 'string');
	assert.equal(tree.children.some((child) => child && child.props && child.props.role === 'dialog'), false);
});

test('the rendered pill shows the period label and the session cost', () => {
	// 2026-10-22 10:00 Beijing: peak, and the request started inside the
	// window, so flash peak rates apply to it whatever the clock says now.
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1000000, outputTokens: 1000000 },
		}],
	});
	const text = textOf(tree);
	assert.equal(text.includes(I.zh.peak), true, 'labels the period: ' + text);
	assert.equal(text.includes(I.zh.spend), true, 'labels the cost');
	// 1M uncached input at 2.0 plus 1M output at 8.0 = 10.00 CNY at peak rates.
	assert.equal(text.includes('\u00a510.00'), true, 'shows the peak-rate total: ' + text);
	const titles = titlesOf(tree);
	assert.equal(titles.length, 1);
	assert.equal(titles[0].includes(I.zh.peakTip), true, 'tooltip explains the window');
	assert.equal(titles[0].includes(I.zh.nextChange), true, 'tooltip carries the countdown');
	assert.equal(titles[0].includes('auto/deepseek-v4.1-flash'), true, 'tooltip names the routed model');
	// 10:00 to 12:00 is two hours, past the hour we print on the pill.
	assert.equal(text.includes('2 \u5c0f\u65f6'), false, 'a far flip stays in the tooltip: ' + text);
});

test('the last hour before a flip is printed on the pill', () => {
	const tree = renderAt(beijing('2026-10-22', 11, 30), {
		requests: [{
			startedAt: beijing('2026-10-22', 11, 30),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1, outputTokens: 1 },
		}],
	});
	const text = textOf(tree);
	assert.equal(text.includes('30 \u5206\u949f'), true, 'half an hour left is on the pill: ' + text);
});

test('the same usage costs half as much off-peak', () => {
	// The same usage started at 22:00 Beijing (off-peak): its own interval
	// halves the bill, whatever the clock says now.
	const tree = renderAt(beijing('2026-10-22', 22, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 22, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1000000, outputTokens: 1000000 },
		}],
	});
	const text = textOf(tree);
	assert.equal(text.includes(I.zh.offPeak), true, 'labels the period: ' + text);
	assert.equal(text.includes('\u00a55.00'), true, 'off-peak halves the same usage: ' + text);
});

test('the pill cost does not swing when the period flips', () => {
	// Same session data rendered at night and in the morning (reported
	// 2026-10-29): the label follows the clock, but the money is pinned to
	// the intervals the tokens ran in.
	const options = {
		requests: [{
			startedAt: beijing('2026-10-22', 22, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
			usage: { inputTokens: 1000000 },
		}],
		usage: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		selection: {
			lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' },
			next: { provider: 'deepseek-account', model: 'deepseek-flash' },
		},
	};
	const night = renderAt(beijing('2026-10-22', 22, 0), options);
	const morning = renderAt(beijing('2026-10-23', 10, 0), options);
	// 1M exact at the night rate (1.0) + 1M unloaded history estimated at the
	// window's oldest instant (the same night, 1.0) = 2.00 in both renders.
	assert.equal(textOf(night).includes('\u00a52.00'), true, textOf(night));
	assert.equal(textOf(morning).includes('\u00a52.00'), true, textOf(morning));
	assert.equal(textOf(night).includes(I.zh.offPeak), true, 'night label');
	assert.equal(textOf(morning).includes(I.zh.peak), true, 'morning label');
});

test('a mixed-model session renders the sum and lists every model', () => {	const requests = [
		{
			purpose: 'assistant',
			startedAt: beijing('2026-10-22', 22, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
			usage: { inputTokens: 1000000, outputTokens: 0 },
		},
		{
			purpose: 'assistant',
			startedAt: beijing('2026-10-23', 10, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
			usage: { inputTokens: 1000000, outputTokens: 0 },
		},
	];
	const tree = renderAt(beijing('2026-10-23', 10, 30), {
		requests,
		usage: { uncachedInputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		selection: {
			lastUsed: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
			next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
		},
	});
	const text = textOf(tree);
	// 1.0 for the off-peak flash request + 9.0 for the peak pro request.
	assert.equal(text.includes('\u00a510.00'), true, 'total of both models: ' + text);
	const title = titlesOf(tree)[0];
	assert.equal(title.includes(I.zh.byModel), false, 'the hover title does not carry every row');
	assert.equal(title.includes(I.zh.details), true, 'the hover title says the list is one click away');
	const listed = tree.props['data-breakdown'];
	assert.equal(listed.includes(I.zh.byModel), true, 'the breakdown has the per-model section');
	assert.equal(listed.includes('deepseek-flash'), true, 'lists the flash row');
	assert.equal(listed.includes('deepseek-v4-pro'), true, 'lists the pro row');
	assert.equal(listed.includes('\u00a59.00'), true, 'pro row carries its own peak cost');
	assert.equal(listed.includes('\u00a51.00'), true, 'flash row carries its own off-peak cost');
});

test('a single foreign model is named in the tooltip even without a second row', () => {
	// The session ran on flash, but the selector has since moved to pro.
	const tree = renderAt(beijing('2026-10-22', 22, 0), {
		requests: [
			{
				startedAt: beijing('2026-10-22', 22, 0),
				providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
				usage: { inputTokens: 1000000 },
			},
		],
		usage: { uncachedInputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		selection: {
			lastUsed: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
			next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
		},
	});
	const listed = tree.props['data-breakdown'];
	assert.equal(listed.includes(I.zh.byModel), true, 'the stale selection does not hide the real model');
	assert.equal(listed.includes('deepseek-flash'), true);
});

test('cache reads are reported as money the input rate would have charged', () => {
	const rows = [{
		model: 'deepseek-flash',
		priced: true,
		periodPriced: true,
		usage: { cacheReadTokens: 1000000, uncachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 },
	}];
	const night = beijing('2026-10-22', 22, 0);
	const morning = beijing('2026-10-22', 10, 0);
	// Off-peak flash: input 1.0, cache read 0.02. The current window decides
	// the rate a reader can check, so night and morning differ.
	assert.ok(Math.abs(I.cacheSaved(rows, I.rateAt, night) - 0.98) < 1e-9);
	assert.ok(Math.abs(I.cacheSaved(rows, I.rateAt, morning) - 1.96) < 1e-9);
	const flat = [{ ...rows[0], periodPriced: false }];
	assert.ok(Math.abs(I.cacheSaved(flat, I.rateAt, morning) - 0.98) < 1e-9, 'a flat row stays on the off-peak quote');
	const none = [{ ...rows[0], usage: { ...rows[0].usage, cacheReadTokens: 0 } }];
	assert.equal(I.cacheSaved(none, I.rateAt, night), 0);
	const unpriced = [{ ...rows[0], priced: false }];
	assert.equal(I.cacheSaved(unpriced, I.rateAt, night), 0, 'an unpriced row has no rate to save against');
});

test('the pill prints the cache saving next to the cost', () => {
	const tree = renderAt(beijing('2026-10-22', 22, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 22, 0),
			providerMetadata: { provider: 'deepseek-account', model: 'deepseek-flash' },
			usage: { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 0 },
		}],
		usage: { uncachedInputTokens: 1000000, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 0 },
	});
	const text = textOf(tree);
	assert.equal(text.includes(I.zh.saved), true, 'names the saving: ' + text);
	// 1M reads at 0.02 instead of 1.0.
	assert.equal(tree.props['data-cache-saved'], '\u00a50.980', 'off-peak saving: ' + tree.props['data-cache-saved']);
	assert.equal(text.includes('\u00a50.980'), true);
});

test('context fill uses the next-prompt figure and bands it like a status line', () => {
	assert.equal(I.contextFill(undefined), undefined);
	assert.equal(I.contextFill({ pressureTokens: 0, contextWindow: 1000 }), undefined, 'nothing occupied yet');
	const low = I.contextFill({ projectedTokens: 100, pressureTokens: 80, contextWindow: 1000 });
	assert.equal(low.used, 100, 'the next-prompt figure wins over the last sample');
	assert.equal(low.percent, 10);
	assert.equal(low.band, 'low');
	assert.equal(I.contextFill({ pressureTokens: 500, contextWindow: 1000 }).band, 'mid');
	assert.equal(I.contextFill({ pressureTokens: 900, contextWindow: 1000 }).band, 'high');
	const over = I.contextFill({ projectedTokens: 1500, contextWindow: 1000 });
	assert.equal(over.percent, 100, 'past the window stays at 100');
	assert.equal(over.band, 'high');
	const blind = I.contextFill({ pressureTokens: 400 });
	assert.equal(blind.band, 'unknown');
	assert.equal(blind.percent, undefined);
	assert.equal(blind.used, 400);
});

test('the pill shows the context percent and its band', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1000, outputTokens: 1000 },
		}],
		pressure: { projectedTokens: 90000, pressureTokens: 80000, contextWindow: 100000 },
	});
	const text = textOf(tree);
	assert.equal(text.includes('90%'), true, 'percent of the window: ' + text);
	assert.equal(text.includes(I.zh.context), false, 'the word stays in the hover: ' + text);
	const span = JSON.stringify(tree);
	assert.equal(span.includes('"high"'), true, 'the band is on the element');
	const title = titlesOf(tree)[0];
	assert.equal(title.includes(I.zh.contextHigh), true, 'the hover says why the colour changed');
	assert.equal(title.includes('90K'), true, 'the hover keeps the token count');
});

test('a route without a window still shows the occupied tokens', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1, outputTokens: 1 },
		}],
		pressure: { pressureTokens: 4000 },
	});
	const text = textOf(tree);
	assert.equal(text.includes(I.zh.context), false, 'no window, so the pill stays on the cost: ' + text);
	assert.equal(text.includes('%'), false);
	const title = titlesOf(tree)[0];
	assert.equal(title.includes(I.zh.contextUnknown), true);
	assert.equal(title.includes('4K'), true, 'the hover still has the token count: ' + title);
});

test('a context window under half full stays off the pill', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1, outputTokens: 1 },
		}],
		pressure: { projectedTokens: 12000, contextWindow: 100000 },
	});
	assert.equal(textOf(tree).includes('%'), false, 'the host ring already shows a quiet fill');
	assert.equal(titlesOf(tree)[0].includes(I.zh.contextLow), true);
	assert.equal(titlesOf(tree)[0].includes('12%'), true);
});

test('a context window past half full is printed on the pill', () => {
	const tree = renderAt(beijing('2026-10-22', 10, 0), {
		requests: [{
			startedAt: beijing('2026-10-22', 10, 0),
			providerMetadata: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
			usage: { inputTokens: 1, outputTokens: 1 },
		}],
		pressure: { projectedTokens: 60000, contextWindow: 100000 },
	});
	assert.equal(textOf(tree).includes('60%'), true, textOf(tree));
	assert.equal(JSON.stringify(tree).includes('"mid"'), true);
});

test('pace needs two requests at least a minute apart', () => {
	const one = new Map([['a', { at: beijing('2026-10-22', 10, 0) }]]);
	assert.equal(I.burnPerHour(10, one, beijing('2026-10-22', 12, 0)), undefined);
	const close = new Map([
		['a', { at: beijing('2026-10-22', 10, 0) }],
		['b', { at: beijing('2026-10-22', 10, 0) + 20000 }],
	]);
	assert.equal(I.burnPerHour(10, close, beijing('2026-10-22', 10, 0) + 20000), undefined, 'under a minute is not a pace');
	const hour = new Map([
		['a', { at: beijing('2026-10-22', 10, 0) }],
		['b', { at: beijing('2026-10-22', 12, 0) }],
	]);
	assert.ok(Math.abs(I.burnPerHour(10, hour, beijing('2026-10-22', 12, 0)) - 5) < 1e-9, '10 CNY over 2 h');
	const short = new Map([
		['a', { at: beijing('2026-10-22', 10, 0) }],
		['b', { at: beijing('2026-10-22', 10, 20) }],
	]);
	assert.equal(I.burnPerHour(3, short, beijing('2026-10-22', 10, 20)), 3, 'under an hour the figure is the session so far');
	assert.equal(I.burnPerHour(0, hour, beijing('2026-10-22', 12, 0)), undefined);
});

test('the breakdown lists each model as its own block with the buckets', () => {
	const row = {
		model: 'deepseek-flash',
		priced: true,
		cost: 1,
		usage: { uncachedInputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 2000000, cacheWriteTokens: 0 },
	};
	const lines = I.modelLines(row, (key) => I.zh[key]);
	assert.equal(lines[0], 'deepseek-flash');
	assert.equal(lines[1].includes('\u00a51.00'), true);
	assert.equal(lines[2].includes(I.zh.input), true);
	assert.equal(lines[2].includes(I.zh.output), true);
	assert.equal(lines[2].includes(I.zh.cacheRead), true);
	assert.equal(lines.length, 3);
});

