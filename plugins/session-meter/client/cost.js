/**
 * Session cost breakdown, pinned-rate cache savings, context fill, burn rate,
 * and formatting helpers for dsh-plugin-session-meter.
 *
 * Pure ASCII only.
 */

const ZERO = Object.freeze({
	uncachedInputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
});

function numberOrZero(value) {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function bucketsOf(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	const buckets = {
		uncachedInputTokens: numberOrZero(usage.inputTokens),
		outputTokens: numberOrZero(usage.outputTokens),
		cacheReadTokens: numberOrZero(usage.cacheReadTokens),
		cacheWriteTokens: numberOrZero(usage.cacheWriteTokens),
	};
	return totalBilledTokens(buckets) > 0 ? buckets : undefined;
}

function addInto(target, source) {
	target.uncachedInputTokens += source.uncachedInputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	return target;
}

function zeroBuckets() {
	return { ...ZERO };
}

function costOf(usage, rate) {
	if (!usage || !rate) return 0;
	const perMillion = (tokens, price) => (numberOrZero(tokens) / 1000000) * price;
	const cacheWrite = Number.isFinite(rate.cacheWrite) ? rate.cacheWrite : rate.input;
	return perMillion(usage.uncachedInputTokens, rate.input)
		+ perMillion(usage.cacheReadTokens, rate.cacheRead)
		+ perMillion(usage.cacheWriteTokens, cacheWrite)
		+ perMillion(usage.outputTokens, rate.output);
}

function cacheSavingFor(usage, rate) {
	if (!usage || !rate) return 0;
	const reads = numberOrZero(usage.cacheReadTokens);
	if (reads <= 0) return 0;
	const input = numberOrZero(rate.input);
	const read = numberOrZero(rate.cacheRead);
	if (input <= read) return 0;
	return (reads / 1000000) * (input - read);
}

function totalBilledTokens(usage) {
	if (!usage) return 0;
	return numberOrZero(usage.uncachedInputTokens)
		+ numberOrZero(usage.cacheReadTokens)
		+ numberOrZero(usage.cacheWriteTokens)
		+ numberOrZero(usage.outputTokens);
}

function requestCosts(requests, opts = {}) {
	const list = Array.isArray(requests) ? requests : [];
	const current = opts.current && typeof opts.current === "object" ? opts.current : {};
	const lookup = typeof opts.rateAt === "function"
		? opts.rateAt
		: (model, at) => rateAt(model, at, opts.config);
	const instants = pinnedInstants(list);
	const out = [];
	for (let index = 0; index < list.length; index += 1) {
		const request = list[index];
		const buckets = bucketsOf(request && request.usage);
		if (buckets === undefined) continue;
		const id = modelOfRequest(request) || {};
		const model = id.model !== undefined ? id.model : current.model;
		const at = instants[index];
		const priced = lookup(model, at);
		out.push({
			index,
			turn: Number.isFinite(request && request.turn) ? request.turn : undefined,
			step: Number.isFinite(request && request.step) ? request.step : undefined,
			model: model || "",
			at,
			priced: priced !== undefined,
			cost: priced !== undefined ? costOf(buckets, priced.rate) : 0,
			tokens: totalBilledTokens(buckets),
		});
	}
	return out;
}

function modelOfRequest(request) {
	if (!request || typeof request !== "object") return undefined;
	for (const candidate of [request.providerMetadata, request.requestConfig]) {
		if (!candidate || typeof candidate !== "object") continue;
		if (typeof candidate.model !== "string" || candidate.model.length === 0) continue;
		return {
			provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
			model: candidate.model,
		};
	}
	return undefined;
}

const UNKNOWN_PEAK_AT = Date.UTC(2026, 9, 22, 2, 0); // 10:00 Beijing
const UNKNOWN_OFFPEAK_AT = Date.UTC(2026, 9, 22, 14, 0); // 22:00 Beijing

function pinnedInstants(requests) {
	const out = requests.map((request) =>
		Number.isFinite(request && request.startedAt) ? request.startedAt : undefined);
	for (let index = 1; index < out.length; index++) {
		if (out[index] === undefined) out[index] = out[index - 1];
	}
	for (let index = out.length - 2; index >= 0; index--) {
		if (out[index] === undefined) out[index] = out[index + 1];
	}
	return out;
}

function requestKey(request) {
	if (!request || typeof request !== "object") return undefined;
	const purpose = typeof request.purpose === "string" ? request.purpose : "";
	if (Number.isFinite(request.turn) && Number.isFinite(request.step)) {
		return purpose + "\u0000" + request.turn + "\u0000" + request.step;
	}
	if (request.seq !== undefined && request.seq !== null) return purpose + "\u0000" + String(request.seq);
	if (request.startSeq !== undefined && request.startSeq !== null) return purpose + "\u0000" + String(request.startSeq);
	return undefined;
}

function mixUsage(hash, value) {
	if (!value || typeof value !== "object") return mixKey(hash, "-");
	hash = mixKey(hash, numberOrZero(value.inputTokens));
	hash = mixKey(hash, numberOrZero(value.uncachedInputTokens));
	hash = mixKey(hash, numberOrZero(value.outputTokens));
	hash = mixKey(hash, numberOrZero(value.cacheReadTokens));
	hash = mixKey(hash, numberOrZero(value.cacheWriteTokens));
	return hash;
}

function inputStamp(requests, totals) {
	const list = Array.isArray(requests) ? requests : [];
	let hash = mixUsage(list.length, totals);
	for (let index = 0; index < list.length; index += 1) {
		const request = list[index];
		if (!request || typeof request !== "object") {
			hash = mixKey(hash, index);
			continue;
		}
		const meta = request.providerMetadata;
		const config = request.requestConfig;
		const served = meta && typeof meta === "object" ? meta : undefined;
		const issued = config && typeof config === "object" ? config : undefined;
		const source = served && typeof served.model === "string" && served.model.length > 0 ? served : issued;
		hash = mixKey(hash, source && source.provider);
		hash = mixKey(hash, source && source.model);
		hash = mixKey(hash, request.startedAt);
		hash = mixUsage(hash, request.usage);
	}
	return hash;
}

function mixKey(hash, value) {
	const text = value === undefined || value === null ? "" : String(value);
	let next = hash;
	for (let index = 0; index < text.length; index += 1) {
		next = ((next * 33) ^ text.charCodeAt(index)) >>> 0;
	}
	return (next * 33) >>> 0;
}

function breakdownKey(input) {
	const requests = Array.isArray(input.requests) ? input.requests : [];
	const current = input.current && typeof input.current === "object" ? input.current : {};
	const totals = input.totals && typeof input.totals === "object" ? input.totals : undefined;
	let hash = mixKey(requests.length, current.provider);
	hash = mixKey(hash, current.model);
	if (totals !== undefined) {
		hash = mixKey(hash, numberOrZero(totals.uncachedInputTokens));
		hash = mixKey(hash, numberOrZero(totals.outputTokens));
		hash = mixKey(hash, numberOrZero(totals.cacheReadTokens));
		hash = mixKey(hash, numberOrZero(totals.cacheWriteTokens));
	} else {
		hash = mixKey(hash, "-");
	}
	for (let index = 0; index < requests.length; index += 1) {
		const request = requests[index];
		if (!request || typeof request !== "object") {
			hash = mixKey(hash, index);
			continue;
		}
		const id = modelOfRequest(request);
		const usage = request.usage && typeof request.usage === "object" ? request.usage : {};
		hash = mixKey(hash, requestKey(request));
		hash = mixKey(hash, request.startedAt);
		hash = mixKey(hash, id ? id.provider : "");
		hash = mixKey(hash, id ? id.model : "");
		hash = mixKey(hash, numberOrZero(usage.inputTokens));
		hash = mixKey(hash, numberOrZero(usage.outputTokens));
		hash = mixKey(hash, numberOrZero(usage.cacheReadTokens));
		hash = mixKey(hash, numberOrZero(usage.cacheWriteTokens));
	}
	hash = mixKey(hash, input._liveGeneration);
	return hash;
}

/**
 * Price a whole session model by model, pinning both cost AND cache savings to
 * the interval each token block was billed in (so crossing 09:00 / 18:00 never
 * double-jumps either the session cost or the cache saving).
 */
function costBreakdown(input) {
	const requests = Array.isArray(input.requests) ? input.requests : [];
	const current = input.current && typeof input.current === "object" ? input.current : {};
	const config = input.config || PEAK;
	const now = Number.isFinite(input.now) ? input.now : Date.now();
	const customLookup = typeof input.rateAt === "function";
	const lookup = customLookup
		? input.rateAt
		: (model, at) => rateAt(model, at, config);

	const currentUsesPeriods = () => {
		const priced = lookup(current.model, now);
		return priced !== undefined && priced.periodPriced === true;
	};

	const memo = input._memo;
	const sameLookup = memo && memo.customLookup === customLookup && (!customLookup || memo.lookup === lookup);
	const sameRefs = memo
		&& memo.requests === requests
		&& memo.totals === input.totals
		&& memo.model === current.model
		&& memo.provider === current.provider
		&& memo.generation === input._liveGeneration
		&& memo.pinned === input.pinned
		&& memo.stamp === (input._stamp !== undefined ? input._stamp : inputStamp(requests, input.totals));
	if (memo && memo.result && sameLookup && (sameRefs || memo.key === breakdownKey(input))) {
		const periodPriced = memo.result.rows.some((row) => row.periodPriced) || currentUsesPeriods();
		if (periodPriced === memo.result.periodPriced) return memo.result;
		return { ...memo.result, periodPriced };
	}

	const ledger = input.pinned instanceof Map ? input.pinned : new Map();
	const entries = new Map(ledger);
	const loose = [];
	const instants = pinnedInstants(requests);
	for (let index = 0; index < requests.length; index++) {
		const request = requests[index];
		const buckets = bucketsOf(request && request.usage);
		if (buckets === undefined) continue;
		const id = modelOfRequest(request) || {};
		const entry = {
			provider: id.provider ?? current.provider,
			model: id.model ?? current.model,
			at: instants[index],
			own: Number.isFinite(request && request.startedAt),
			usage: buckets,
		};
		const key = requestKey(request);
		if (key === undefined) {
			loose.push(entry);
			continue;
		}
		const previous = entries.get(key);
		const at = !entry.own && previous?.own === true
			? previous.at
			: (entry.at ?? previous?.at);
		const own = entry.own || previous?.own === true;
		entries.set(key, { provider: entry.provider, model: entry.model, at, own, usage: entry.usage });
	}

	const rows = new Map();
	const datedCosts = new Map();
	const charged = zeroBuckets();
	let cost = 0;
	let savedTotal = 0;
	let unpricedTokens = 0;

	const rowOf = (provider, model) => {
		const key = String(provider ?? "") + "\u0000" + String(model ?? "");
		let row = rows.get(key);
		if (row === undefined) {
			row = {
				provider: provider ?? undefined,
				model: model ?? undefined,
				usage: zeroBuckets(),
				cost: 0,
				saved: 0,
				priced: false,
				reference: false,
				periodPriced: false,
				estimated: false,
			};
			rows.set(key, row);
		}
		return row;
	};

	let anchorAt;
	const noteInstant = (value) => {
		if (Number.isFinite(value) && (anchorAt === undefined || value < anchorAt)) anchorAt = value;
	};
	for (const entry of entries.values()) noteInstant(entry.at);
	for (const entry of loose) noteInstant(entry.at);

	const charge = (entry, estimated, requestId) => {
		const row = rowOf(entry.provider, entry.model);
		addInto(row.usage, entry.usage);
		addInto(charged, entry.usage);
		if (estimated === true || entry.own !== true) row.estimated = true;
		const at = entry.at !== undefined ? entry.at : anchorAt;
		if (at === undefined) {
			const peak = lookup(entry.model, UNKNOWN_PEAK_AT);
			const off = lookup(entry.model, UNKNOWN_OFFPEAK_AT);
			const hit = peak !== undefined ? peak : off;
			if (hit === undefined) {
				unpricedTokens += totalBilledTokens(entry.usage);
				return;
			}
			const rowCost = peak !== undefined && off !== undefined
				? 0.5 * costOf(entry.usage, peak.rate) + 0.5 * costOf(entry.usage, off.rate)
				: costOf(entry.usage, hit.rate);
			const rowSaved = peak !== undefined && off !== undefined
				? 0.5 * cacheSavingFor(entry.usage, peak.rate) + 0.5 * cacheSavingFor(entry.usage, off.rate)
				: cacheSavingFor(entry.usage, hit.rate);
			row.priced = true;
			if (hit.reference === true) row.reference = true;
			if ((peak !== undefined && peak.periodPriced === true) || (off !== undefined && off.periodPriced === true)) row.periodPriced = true;
			row.cost += rowCost;
			row.saved += rowSaved;
			cost += rowCost;
			savedTotal += rowSaved;
			return;
		}
		const priced = lookup(entry.model, at);
		if (priced === undefined) {
			unpricedTokens += totalBilledTokens(entry.usage);
			return;
		}
		const rowCost = costOf(entry.usage, priced.rate);
		const rowSaved = cacheSavingFor(entry.usage, priced.rate);
		row.priced = true;
		if (priced.reference === true) row.reference = true;
		if (priced.periodPriced === true) row.periodPriced = true;
		row.cost += rowCost;
		row.saved += rowSaved;
		cost += rowCost;
		savedTotal += rowSaved;
		if (requestId !== undefined && entry.own === true && Number.isFinite(rowCost)) {
			const date = localDateKey(at);
			let day = datedCosts.get(date);
			if (day === undefined) {
				day = new Map();
				datedCosts.set(date, day);
			}
			day.set(requestId, rowCost);
		}
	};

	for (const [requestId, entry] of entries) charge(entry, false, requestId);
	for (const entry of loose) charge(entry, false);

	let remainderTokens = 0;
	const totals = input.totals && typeof input.totals === "object" ? input.totals : undefined;
	if (totals !== undefined) {
		const remainder = {
			uncachedInputTokens: Math.max(0, numberOrZero(totals.uncachedInputTokens) - charged.uncachedInputTokens),
			outputTokens: Math.max(0, numberOrZero(totals.outputTokens) - charged.outputTokens),
			cacheReadTokens: Math.max(0, numberOrZero(totals.cacheReadTokens) - charged.cacheReadTokens),
			cacheWriteTokens: Math.max(0, numberOrZero(totals.cacheWriteTokens) - charged.cacheWriteTokens),
		};
		remainderTokens = totalBilledTokens(remainder);
		if (remainderTokens > 0) {
			charge({
				provider: current.provider,
				model: current.model,
				at: anchorAt,
				own: false,
				usage: remainder,
			}, true);
		}
	} else if (entries.size === 0 && loose.length === 0) {
		return {
			cost,
			cacheSaved: savedTotal,
			datedCosts,
			rows: [],
			unpricedTokens,
			remainderTokens: 0,
			periodPriced: currentUsesPeriods(),
			pinned: entries,
		};
	}

	const visibleRows = [...rows.values()].filter((row) => totalBilledTokens(row.usage) > 0);
	return {
		cost,
		cacheSaved: savedTotal,
		datedCosts,
		rows: visibleRows,
		unpricedTokens,
		remainderTokens: totals === undefined ? 0 : remainderTokens,
		periodPriced: visibleRows.some((row) => row.periodPriced) || currentUsesPeriods(),
		pinned: entries,
	};
}

function fmtMoney(value) {
	if (!Number.isFinite(value)) return "\u2014";
	if (value === 0) return "\u00a50.00";
	if (value < 0.01) return "\u00a5" + value.toFixed(4);
	if (value < 1) return "\u00a5" + value.toFixed(3);
	return "\u00a5" + value.toFixed(2);
}

function contextFill(pressure) {
	if (!pressure || typeof pressure !== "object") return undefined;
	const projected = numberOrZero(pressure.projectedTokens);
	const sampled = numberOrZero(pressure.pressureTokens);
	const used = projected > 0 ? projected : sampled;
	if (used <= 0) return undefined;
	const window = numberOrZero(pressure.contextWindow);
	if (window <= 0) return { used, window: undefined, percent: undefined, band: "unknown" };
	const percent = Math.min(100, Math.round((used / window) * 100));
	const band = percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
	return { used, window, percent, band };
}

/**
 * Cache-read saving across rows. Uses pinned per-row `row.saved` when computed
 * by `costBreakdown`, falling back to `lookup` for callers passing synthetic rows.
 */
function cacheSaved(rows, lookup, now) {
	if (!Array.isArray(rows)) return 0;
	let saved = 0;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (!row || row.priced !== true) continue;
		if (Number.isFinite(row.saved)) {
			saved += row.saved;
			continue;
		}
		if (typeof lookup !== "function") continue;
		const reads = numberOrZero(row.usage && row.usage.cacheReadTokens);
		if (reads <= 0) continue;
		const hit = lookup(row.model, row.periodPriced === true ? now : UNKNOWN_OFFPEAK_AT);
		if (!hit || !hit.rate) continue;
		saved += cacheSavingFor(row.usage, hit.rate);
	}
	return saved;
}

function burnPerHour(cost, pinned, now) {
	if (!Number.isFinite(cost) || cost <= 0) return undefined;
	if (!(pinned instanceof Map) || pinned.size < 2) return undefined;
	let oldest;
	let newest;
	for (const entry of pinned.values()) {
		if (!entry || !Number.isFinite(entry.at)) continue;
		if (oldest === undefined || entry.at < oldest) oldest = entry.at;
		if (newest === undefined || entry.at > newest) newest = entry.at;
	}
	if (oldest === undefined) return undefined;
	const end = Number.isFinite(now) && now > newest ? now : newest;
	const span = end - oldest;
	if (!Number.isFinite(span) || span < MINUTE_MS) return undefined;
	if (span < 60 * MINUTE_MS) return cost;
	return cost * (60 * MINUTE_MS) / span;
}

function fmtTokens(value) {
	if (!Number.isFinite(value)) return "\u2014";
	if (value < 1000) return String(value);
	if (value < 1000000) {
		const text = (value / 1000).toFixed(value < 10000 ? 2 : 1);
		return text.replace(/\.0+$/, "") + "K";
	}
	return (value / 1000000).toFixed(2).replace(/\.0+$/, "") + "M";
}

function nextDelayMs(nowMs, options) {
	const opts = options || {};
	const cap = Number.isFinite(opts.capMs) && opts.capMs > 0 ? opts.capMs : 300000;
	let wait = cap;
	if (Number.isFinite(opts.flipAt) && opts.flipAt > nowMs) {
		const until = opts.flipAt - nowMs;
		const hour = 60 * MINUTE_MS;
		if (opts.countdown === true && until <= hour) {
			const into = until % MINUTE_MS;
			const boundary = into === 0 ? MINUTE_MS : into;
			wait = Math.min(wait, until, boundary);
		} else if (opts.period === true && until > hour) {
			wait = Math.min(wait, until - hour);
		} else {
			wait = Math.min(wait, until);
		}
	}
	if (Number.isFinite(opts.retryAt) && opts.retryAt > nowMs) wait = Math.min(wait, opts.retryAt - nowMs);
	else if (opts.retryDue === true) wait = Math.min(wait, 1000);
	return Math.max(250, wait);
}

function countdownStale(shownAt, wall, active) {
	if (active !== true) return false;
	if (!Number.isFinite(shownAt) || !Number.isFinite(wall)) return false;
	return wall - shownAt > 5000;
}

function pillNeedsClock(showPill, retryPending) {
	return showPill === true || retryPending === true;
}

function priceEffectTick(now, lastError) {
	return typeof lastError === "string" && lastError.length > 0 ? now : 0;
}

function fmtSpan(ms, t) {
	if (!Number.isFinite(ms) || ms <= 0) return "0 " + textKey(t, "minute");
	const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS - 1e-9));
	if (totalMinutes <= 60) return totalMinutes + " " + textKey(t, "minute");
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours <= 24) {
		return minutes === 0
			? hours + " " + textKey(t, "hour")
			: hours + " " + textKey(t, "hour") + " " + minutes + " " + textKey(t, "minute");
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0
		? days + " " + textKey(t, "day")
		: days + " " + textKey(t, "day") + " " + restHours + " " + textKey(t, "hour");
}

function unpricedOnly(breakdown) {
	const priced = breakdown.rows.some((row) => row.priced && totalBilledTokens(row.usage) > 0);
	return !priced && breakdown.unpricedTokens > 0;
}
