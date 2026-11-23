/**
 * Live catalog price fetcher for dsh-plugin-session-meter (browser half).
 *
 * Sends raw model names in `m=` since the Host already expands candidates via
 * shared `nameCandidates`, and only invokes `liveNotify()` when rates, error
 * state, or remaining queued batches actually changed.
 *
 * Pure ASCII only.
 */

const live = {
	models: Object.create(null),
	known: new Set(),
	listeners: new Set(),
	inFlight: false,
	lastError: undefined,
	retryAt: 0,
	generation: 0,
	fetchedAt: 0,
};

const ROUTE = "/session-meter/prices";
const LIVE_RETRY_MS = 60000;
const LIVE_TIMEOUT_MS = 15000;
const LIVE_BATCH = 64;
const LIVE_URL_BUDGET = 1500;

function priceQueryBatch(names, budget) {
	const cap = Number.isFinite(budget) && budget > 0 ? budget : LIVE_URL_BUDGET;
	const batch = [];
	let used = 0;
	const list = Array.isArray(names) ? names : [];
	for (let index = 0; index < list.length && batch.length < LIVE_BATCH; index += 1) {
		const name = list[index];
		if (typeof name !== "string" || name.length === 0) continue;
		const encoded = encodeURIComponent(name).length;
		if (encoded > cap) continue;
		const extra = encoded + (batch.length > 0 ? 3 : 0);
		if (batch.length > 0 && used + extra > cap) break;
		batch.push(name);
		used += extra;
	}
	return batch;
}

function liveSubscribe(listener) {
	live.listeners.add(listener);
	return () => {
		live.listeners.delete(listener);
	};
}

function liveNotify() {
	for (const listener of [...live.listeners]) {
		try {
			listener();
		} catch {
			// A listener throwing must not stop the others.
		}
	}
}

/**
 * Ask the Host for the prices of raw routed model names not covered by the
 * built-in DeepSeek table. The Host expands spellings with `nameCandidates`.
 */
function requestLivePrices(names) {
	if (typeof fetch !== "function") return;
	const unknown = [];
	const seen = new Set();
	for (const rawName of names) {
		if (typeof rawName !== "string" || rawName.length === 0) continue;
		if (priceOf(rawName) !== undefined) continue;
		const name = rawName.toLowerCase();
		if (live.known.has(name) || seen.has(name)) continue;
		seen.add(name);
		unknown.push(name);
	}
	if (unknown.length === 0 || live.inFlight) return;
	if (Date.now() < live.retryAt) return;
	unknown.sort();
	const batch = priceQueryBatch(unknown);
	for (const name of unknown) {
		if (encodeURIComponent(name).length > LIVE_URL_BUDGET) live.known.add(name);
	}
	if (batch.length === 0) return;
	const hasMore = unknown.length > batch.length;
	const prevGeneration = live.generation;
	const prevError = live.lastError;
	const key = batch.join(",");
	live.inFlight = true;
	fetch(ROUTE + "?m=" + encodeURIComponent(key), {
		credentials: "same-origin",
		signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
			? AbortSignal.timeout(LIVE_TIMEOUT_MS)
			: undefined,
	})
		.then((response) => {
			if (!response.ok) throw new Error("HTTP " + response.status);
			return response.json();
		})
		.then((payload) => {
			if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "catalog not ready");
			const models = payload.models && typeof payload.models === "object" ? payload.models : {};
			const fetchedAt = Number(payload.fetchedAt);
			let added = false;
			if (Number.isFinite(fetchedAt) && fetchedAt > 0 && live.fetchedAt > 0 && fetchedAt !== live.fetchedAt) {
				live.known = new Set();
			}
			if (Number.isFinite(fetchedAt) && fetchedAt > 0) live.fetchedAt = fetchedAt;
			for (const name of batch) {
				live.known.add(name);
				const rate = models[name];
				if (!rate || typeof rate !== "object" || typeof rate.input !== "number") {
					if (live.models[name]) {
						delete live.models[name];
						added = true;
					}
					continue;
				}
				const next = {
					input: Number(rate.input),
					output: Number(rate.output),
					cacheRead: Number(rate.cacheRead),
					cacheWrite: Number(rate.cacheWrite),
				};
				const held = live.models[name];
				if (held && held.input === next.input && held.output === next.output
					&& held.cacheRead === next.cacheRead && held.cacheWrite === next.cacheWrite) continue;
				live.models[name] = next;
				added = true;
			}
			if (added) {
				live.generation += 1;
				live.models = { ...live.models };
			}
			live.lastError = undefined;
			live.retryAt = 0;
		})
		.catch((error) => {
			live.lastError = error instanceof Error ? error.message : String(error);
			live.retryAt = Date.now() + LIVE_RETRY_MS;
		})
		.finally(() => {
			live.inFlight = false;
			if (hasMore || live.generation !== prevGeneration || live.lastError !== prevError) {
				liveNotify();
			}
		});
}

function liveRateFor(model) {
	if (typeof model !== "string" || model.length === 0) return undefined;
	for (const candidate of nameCandidates(model)) {
		const rate = live.models[candidate];
		if (rate !== undefined) return rate;
	}
	return undefined;
}

function rateAt(model, at, config) {
	const tier = priceOf(model);
	if (tier !== undefined) {
		return { rate: isPeakAt(at, config) ? tier.peak : tier.offPeak, reference: false, periodPriced: true };
	}
	const catalogRate = liveRateFor(model);
	if (catalogRate !== undefined) return { rate: catalogRate, reference: true, periodPriced: false };
	return undefined;
}
