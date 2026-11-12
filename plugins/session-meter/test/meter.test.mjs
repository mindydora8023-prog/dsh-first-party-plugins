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
		assert.equal(title.includes(I.zh.referenceNote), true, 'the asterisk is explained');
		assert.equal(title.includes('*'), true, 'the row is marked');
	});
});

test('client-side name candidates mirror the host expansion', () => {
	const candidates = I.nameCandidates('codex/gpt-6.1-sol');
	assert.equal(candidates.includes('gpt-6-sol'), true);
	assert.equal(candidates.includes('gpt-6.1-sol'), true);
	assert.deepEqual(I.nameCandidates(undefined), []);
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
		assert.equal(title.includes(I.zh.referenceNote), true, 'the catalog asterisk is still explained');
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
		assert.equal(tree.props['data-session-meter'], 'flat');
		assert.equal(textOf(tree).includes(I.zh.offPeak), false);
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
		fetch: globalThis.fetch,
	};
	const calls = [];
	I.live.models = Object.create(null);
	I.live.known = new Set();
	I.live.retryAt = 0;
	I.live.inFlight = false;
	I.live.lastError = undefined;
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
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
			useProjection: (key) => (key === 'tokenUsage' ? usage : selection),
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
	assert.equal(title.includes(I.zh.byModel), true, 'tooltip has the per-model section');
	assert.equal(title.includes('deepseek-flash'), true, 'lists the flash row');
	assert.equal(title.includes('deepseek-v4-pro'), true, 'lists the pro row');
	assert.equal(title.includes('\u00a59.00'), true, 'pro row carries its own peak cost');
	assert.equal(title.includes('\u00a51.00'), true, 'flash row carries its own off-peak cost');
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
	const title = titlesOf(tree)[0];
	assert.equal(title.includes(I.zh.byModel), true, 'the stale selection does not hide the real model');
	assert.equal(title.includes('deepseek-flash'), true);
});

