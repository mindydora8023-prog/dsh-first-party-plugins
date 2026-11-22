/**
 * dsh-plugin-session-meter -- browser half.
 *
 * Registers one ambient entry into `conversation.composer.dock`, the row just
 * below the composer card where the shipped speed/cache pills live. It shows
 * whether the current minute is inside a DeepSeek peak window (Beijing time,
 * Mon-Fri, 09:00-12:00 and 14:00-18:00, excluding Chinese statutory holidays)
 * and what THIS session has cost at the official DeepSeek price of every model
 * it actually ran on.
 *
 * Model attribution is per request, not per session: a session that switched
 * models (or whose routing group resolved differently) is priced model by
 * model, and each request is billed at the peak/off-peak rate in force when it
 * started. Three live session projections feed that:
 *   - `tokenUsage`     -> { uncachedInputTokens, outputTokens, cacheReadTokens,
 *                           cacheWriteTokens } (whole durable log; the authority
 *                           for the session total)
 *   - `modelSelection` -> { lastUsed, next } (current routed provider/model)
 *   - `useTrajectory`  -> requests[].{ providerMetadata, requestConfig, usage,
 *                           startedAt, purpose } (per-request model + usage)
 *
 * The Host route is optional: until it answers, lookups use this built-in
 * table. The source is kept pure ASCII on purpose (workspace convention): user-visible
 * Chinese text is written as \u escapes inside the locale dictionary, and the
 * copy logic here is exported through the module factory so tests exercise the
 * shipped functions rather than a copy.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = "sessionMeter";

		/* ------------------------------------------------------------ pricing */
		/**
		 * DeepSeek official pricing, in CNY per 1,000,000 tokens.
		 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
		 * (checked 2026-11-17; CNY figures unchanged). Off-peak is half of peak.
		 *
		 * Keys are the billed model ids DeepSeek documents. Lookup order is
		 * exact id -> provider tail -> family (`flash` / `pro`), so a routing
		 * group such as `auto/deepseek-v4.1-flash` or a reseller prefix is
		 * still recognised without listing every combination here.
		 */
		// One tier per billed model; several request-time ids share a tier
		// because DeepSeek bills them as the same model (the docs' footnote:
		// deepseek-v4-flash / deepseek-v4.1-flash are served and priced as
		// deepseek-flash).
		const FLASH_TIER = {
			offPeak: { cacheRead: 0.02, input: 1.0, output: 4.0 },
			peak: { cacheRead: 0.04, input: 2.0, output: 8.0 },
		};
		const PRO_TIER = {
			offPeak: { cacheRead: 0.15, input: 4.5, output: 13.5 },
			peak: { cacheRead: 0.3, input: 9.0, output: 27.0 },
		};
		const PRICING = {
			"deepseek-flash": FLASH_TIER,
			"deepseek-v4.1-flash": FLASH_TIER,
			"deepseek-v4-flash": FLASH_TIER,
			// Docs footnote: this legacy vision id is served and billed as flash.
			"deepseek-v4-flash-vision-exp": FLASH_TIER,
			"deepseek-pro": PRO_TIER,
			"deepseek-v4-pro": PRO_TIER,
			"deepseek-v4.1-pro": PRO_TIER,
			"deepseek-v4-pro-0813": PRO_TIER,
		};
		/** Second-pass family names inside a model id, in match order. */
		const FAMILIES = [
			["flash", FLASH_TIER],
			["pro", PRO_TIER],
		];
		/**
		 * The only shape the family fallback may claim besides a segment that
		 * literally says `deepseek`: the family word alone (`flash`, `pro`)
		 * behind at most DeepSeek's own version prefix (`v4-pro`, `v4.1-flash`,
		 * `v4-pro-0813`), with no vendor word in front.
		 *
		 * This used to be a denylist of foreign vendors, which is a losing game:
		 * `workbuddy/mimo-v2.6-pro` is another vendor's model, yet its `pro`
		 * tail matched the family fallback and borrowed DeepSeek PRO_TIER --
		 * wrong price, and the peak/off-peak marker came with it (reported
		 * 2026-10-29). Now a segment that leads with anything the rule does not
		 * recognise is simply another vendor's model and stays out.
		 */
		const BARE_FAMILY = /^(?:v\d+(?:\.\d+)*[-_.]?)?(?:flash|pro)(?:[-_.](?:\d{3,6}|preview|latest|free|beta|alpha|experimental))?$/;

		/* --------------------------------------------------------------- text */
		/** English copy (plain ASCII). */
		const en = {
			peak: "Peak",
			offPeak: "Off-peak",
			spend: "Session cost",
			pricedSubtotal: "Priced subtotal",
			unpricedUsage: "Usage without a price",
			estimatedHistory: "History estimated at the selected model's rate (~)",
			noPrice: "unpriced",
			peakTip: "Peak window: 09:00-12:00 and 14:00-18:00 Beijing time on weekdays",
			offPeakTip: "Off-peak: every price is half the peak price",
			estimate: "Estimated at official DeepSeek prices, cache discount included",
			estimateCatalog: "Estimated from each model's own official price list",
			byModel: "Per model",
			byRequest: "Recent requests",
			balanceLabel: "Balance",
			today: "Today total",
			nextChange: "Next change in",
			model: "Model",
			unknown: "unknown",
			input: "input",
			output: "output",
			cacheRead: "cache read",
			perMillion: "CNY per million tokens",
			tokens: "Session tokens",
			tokensUnit: "tokens",
			referenceNote: "* price from the online catalog (converted to CNY)",
			details: "Click for the breakdown",
			catalogError: "Online price list unavailable:",
			minute: "min",
			hour: "h",
			day: "d",
			context: "Context",
			saved: "Cache saved",
			burn: "Pace",
			perHour: "/h",
			contextLow: "Context is under half full",
			contextMid: "Context is over half full",
			contextHigh: "Context is near the window limit",
			contextUnknown: "The route did not report a context window",
		};

		/** Chinese copy; kept as \u escapes so this file never carries raw CJK. */
		const zh = {
			peak: "\u9ad8\u5cf0",
			offPeak: "\u4f4e\u8c37",
			spend: "\u672c\u4f1a\u8bdd\u82b1\u8d39",
			pricedSubtotal: "\u5df2\u8ba1\u4ef7\u5c0f\u8ba1",
			unpricedUsage: "\u7f3a\u4ef7\u7528\u91cf",
			estimatedHistory: "\u6309\u5f53\u524d\u6a21\u578b\u8d39\u7387\u8865\u4f30\u7684\u5386\u53f2\u7528\u91cf (~)",
			noPrice: "\u672a\u5b9a\u4ef7",
			peakTip: "\u9ad8\u5cf0\u65f6\u6bb5 09:00-12:00\u300114:00-18:00\uff08\u5317\u4eac\u65f6\u95f4\uff0c\u5de5\u4f5c\u65e5\uff09",
			offPeakTip: "\u7a7a\u95f2\u4f4e\u8c37\uff0c\u5355\u4ef7\u4e3a\u9ad8\u5cf0\u7684\u4e00\u534a",
			estimate: "\u6309 DeepSeek \u5b98\u65b9\u4ef7\u683c\u4f30\u7b97\uff0c\u542b\u7f13\u5b58\u6298\u6263",
			estimateCatalog: "\u6309\u5404\u6a21\u578b\u5b98\u65b9\u4ef7\u76ee\u8868\u4f30\u7b97",
			byModel: "\u5206\u6a21\u578b",
			byRequest: "\u8fd1\u51e0\u6b21\u8bf7\u6c42",
			balanceLabel: "\u4f59\u989d",
			today: "\u4eca\u65e5\u7d2f\u8ba1",
			nextChange: "\u8ddd\u5207\u6362",
			model: "\u6a21\u578b",
			unknown: "\u672a\u77e5",
			input: "\u8f93\u5165",
			output: "\u8f93\u51fa",
			cacheRead: "\u7f13\u5b58\u8bfb\u53d6",
			perMillion: "\u5143/\u767e\u4e07 tokens",
			tokens: "\u672c\u4f1a\u8bdd tokens",
			tokensUnit: "tokens",
			referenceNote: "* \u4e3a\u5728\u7ebf\u4ef7\u76ee\u8868\u4ef7\u683c\uff08\u5df2\u6362\u7b97\u4e3a\u4eba\u6c11\u5e01\uff09",
			details: "\u70b9\u51fb\u67e5\u770b\u660e\u7ec6",
			catalogError: "\u5728\u7ebf\u4ef7\u76ee\u8868\u672a\u53d6\u5230\uff1a",
			minute: "\u5206\u949f",
			hour: "\u5c0f\u65f6",
			day: "\u5929",
			context: "\u4e0a\u4e0b\u6587",
			saved: "\u7f13\u5b58\u7701\u4e0b",
			burn: "\u8282\u594f",
			perHour: "/\u5c0f\u65f6",
			contextLow: "\u4e0a\u4e0b\u6587\u4e0d\u5230\u4e00\u534a",
			contextMid: "\u4e0a\u4e0b\u6587\u5df2\u8d85\u8fc7\u4e00\u534a",
			contextHigh: "\u4e0a\u4e0b\u6587\u63a5\u8fd1\u7a97\u53e3\u4e0a\u9650",
			contextUnknown: "\u8fd9\u6761\u8def\u7531\u6ca1\u6709\u62a5\u544a\u4e0a\u4e0b\u6587\u7a97\u53e3",
		};

		/** Copy used when no locale seat is injected (tests, locale-less hosts). */
		const FALLBACK = zh;

		/**
		 * One dictionary entry through the injected translator, falling back to
		 * the built-in Chinese table. A translator that echoes the key back
		 * means the namespace was never registered, so that also falls back.
		 * @param {((key: string) => string) | undefined} t - injected translator.
		 * @param {string} key - dictionary key.
		 * @returns {string}
		 */
		function textKey(t, key) {
			if (typeof t === "function") {
				const value = t(key);
				if (typeof value === "string" && value.length > 0 && value !== key) return value;
			}
			return FALLBACK[key];
		}

		/* --------------------------------------------------------------- peak */
		/**
		 * Official peak rule, mirrored from peak-guard: Beijing time (UTC+8),
		 * Monday-Friday, 09:00-12:00 and 14:00-18:00, excluding Chinese
		 * statutory holidays. Every other minute is off-peak.
		 */
		const PEAK = {
			timezoneOffsetMinutes: 480,
			windows: [
				[9 * 60, 12 * 60],
				[14 * 60, 18 * 60],
			],
			// Statutory holidays (State Council). 2026 stays: a request is priced
			// at its own start time, so last year's holiday must still be off-peak.
			// 2027: notice of 2026-11-05. Inclusive ranges; the whole day is off-peak.
			// Makeup workdays that fall on Sat/Sun stay off-peak: the price page says
			// weekends are off-peak all day, not "whatever the office calendar says".
			holidays: [
				["2026-01-01", "2026-01-03"],
				["2026-02-15", "2026-02-23"],
				["2026-04-04", "2026-04-06"],
				["2026-05-01", "2026-05-05"],
				["2026-06-19", "2026-06-21"],
				["2026-09-25", "2026-09-27"],
				["2026-10-01", "2026-10-07"],
				["2027-01-01", "2027-01-03"],
				["2027-02-05", "2027-02-13"],
				["2027-04-03", "2027-04-05"],
				["2027-05-01", "2027-05-05"],
				["2027-06-09", "2027-06-09"],
				["2027-09-15", "2027-09-15"],
				["2027-10-01", "2027-10-07"],
			],
		};

		const MINUTE_MS = 60000;
		const DAY_MS = 86400000;
		/** How many calendar days the off-peak scan looks ahead for a window. */
		const FLIP_HORIZON_DAYS = 15;

		function pad2(value) {
			return value < 10 ? "0" + value : String(value);
		}

		/** Wall-clock reading for one instant: minutes-of-day, weekday, date key. */
		function localParts(ms, offsetMinutes) {
			const shifted = new Date(ms + offsetMinutes * MINUTE_MS);
			const year = shifted.getUTCFullYear();
			const month = shifted.getUTCMonth() + 1;
			const day = shifted.getUTCDate();
			return {
				minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
				weekday: shifted.getUTCDay(),
				dateKey: year + "-" + pad2(month) + "-" + pad2(day),
			};
		}

		function inAnyWindow(minutes, windows) {
			for (const window of windows) {
				if (minutes >= window[0] && minutes < window[1]) return true;
			}
			return false;
		}

		function isHoliday(dateKey, holidays) {
			// Spans are sorted and non-overlapping. Stop at the first span that
			// starts after this date instead of scanning every later year.
			for (const span of holidays) {
				if (dateKey < span[0]) return false;
				if (dateKey <= span[1]) return true;
			}
			return false;
		}

		/** Whether one wall-clock day is a DeepSeek working day at all. */
		function isWorkday(parts, config) {
			if (parts.weekday === 0 || parts.weekday === 6) return false;
			return !isHoliday(parts.dateKey, config.holidays);
		}

		/**
		 * Whether one instant is inside a DeepSeek peak window.
		 * Order: weekend -> off-peak; holiday -> off-peak; else window test.
		 * @param {number} ms - UTC milliseconds.
		 * @param {object} [config] - overrides PEAK (tests / diagnostics).
		 * @returns {boolean}
		 */
		function isPeakAt(ms, config) {
			const cfg = config || PEAK;
			if (!Number.isFinite(ms)) return false;
			const parts = localParts(ms, cfg.timezoneOffsetMinutes);
			if (!isWorkday(parts, cfg)) return false;
			return inAnyWindow(parts.minutes, cfg.windows);
		}

		/**
		 * First instant strictly after `ms` whose peak state differs from `ms`.
		 *
		 * Inside a window the answer is that window's end, so it is always at
		 * most four hours out. Off-peak is answered by walking forward one
		 * calendar day at a time (at most FLIP_HORIZON_DAYS) and returning the
		 * first window start on a working day - which skips nights, the lunch
		 * break, weekends and whole holiday blocks without a minute-by-minute
		 * scan.
		 *
		 * @param {number} ms - UTC milliseconds.
		 * @param {object} [config] - overrides PEAK (tests / diagnostics).
		 * @returns {number|undefined} the flip instant, or undefined when the
		 *   next FLIP_HORIZON_DAYS contain no state change.
		 */
		function nextFlipAt(ms, config) {
			const cfg = config || PEAK;
			if (!Number.isFinite(ms)) return undefined;
			const parts = localParts(ms, cfg.timezoneOffsetMinutes);
			const remainder = ms % MINUTE_MS;

			if (isPeakAt(ms, cfg)) {
				for (const window of cfg.windows) {
					if (parts.minutes >= window[0] && parts.minutes < window[1]) {
						return ms + (window[1] - parts.minutes) * MINUTE_MS - remainder;
					}
				}
				return undefined;
			}

			// Local midnight of the current day, on the same fixed offset model
			// `localParts` uses.
			const dayStart = ms - parts.minutes * MINUTE_MS - remainder;
			for (let day = 0; day < FLIP_HORIZON_DAYS; day += 1) {
				const dayBase = dayStart + day * DAY_MS;
				const dayParts = localParts(dayBase, cfg.timezoneOffsetMinutes);
				if (!isWorkday(dayParts, cfg)) continue;
				for (const window of cfg.windows) {
					const at = dayBase + window[0] * MINUTE_MS;
					if (at > ms) return at;
				}
			}
			return undefined;
		}

		/* ------------------------------------------------------------ costing */
		/**
		 * Online catalog (models.dev, converted to CNY by the Host) for models the
		 * built-in table does not cover. The Host serves only the names a session
		 * asks for, so this stays a few hundred bytes and never blocks rendering:
		 * until it answers, lookups fall back to the built-in table.
		 */
		const live = {
			models: Object.create(null),
			/** Names the Host has answered about, whether it found a price or not. */
			known: new Set(),
			listeners: new Set(),
			inFlight: false,
			lastError: undefined,
			retryAt: 0,
			/** Bumped only when a new catalog rate lands. The cost memo keys on it. */
			generation: 0,
			/** Catalog instant the last answer was built from. */
			fetchedAt: 0,
		};

		const ROUTE = "/session-meter/prices";
		/** How long a failed lookup waits before trying again. */
		const LIVE_RETRY_MS = 60000;
		/** Bound one price request; a hung request would leave inFlight stuck. */
		const LIVE_TIMEOUT_MS = 15000;
		/**
		 * Names per request. The host answers at most this many and ignores the
		 * rest, so a longer list has to be split or its tail stays unpriced.
		 */
		const LIVE_BATCH = 64;
		/**
		 * Encoded query budget. A batch of long relay names used to exceed what
		 * a URL can carry, the request failed, and the same batch was retried.
		 */
		const LIVE_URL_BUDGET = 1500;

		/**
		 * The first names that fit in one query.
		 * A comma is encoded as three characters. A name that is over the budget
		 * by itself is skipped: sending it would fail the request and, because it
		 * sorts first, it would be retried ahead of every other name.
		 * @param {string[]} names
		 * @param {number} [budget]
		 * @returns {string[]}
		 */
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
		 * Ask the Host for the prices of these model names.
		 *
		 * A name counts as settled only when the Host ANSWERED about it, not when a
		 * request was merely sent: an attempt that ran before the route existed (or
		 * while the host was restarting) must not silence the model for the rest of
		 * the page's life. Failures keep the names unknown and retry after
		 * `LIVE_RETRY_MS`. The pill sleeps until that time, then asks again.
		 * @param {string[]} names - routed model ids seen in this session.
		 */
		function requestLivePrices(names) {
			if (typeof fetch !== "function") return;
			const unknown = [];
			for (const name of names) {
				if (typeof name !== "string" || name.length === 0) continue;
				// The built-in table already prices this name, including a
				// context-window tag. Asking the catalog would only get "not
				// listed" back: DeepSeek ids are left out of it on purpose.
				if (priceOf(name) !== undefined) continue;
				// Ask every spelling, not only the routed id. A host that has not
				// picked up a newer nameCandidates still has the bare catalog key
				// (`grok-4.7`), and liveRateFor looks candidates up in that order.
				for (const candidate of nameCandidates(name)) {
					if (live.known.has(candidate)) continue;
					if (!unknown.includes(candidate)) unknown.push(candidate);
				}
			}
			if (unknown.length === 0 || live.inFlight) return;
			if (Date.now() < live.retryAt) return;
			unknown.sort();
			const batch = priceQueryBatch(unknown);
			// Every remaining name is too long for a URL. Asking with an empty
			// query would fetch nothing and then ask again on the next tick.
			// A name that cannot fit is settled here, not only when it is the
			// whole list. Left unknown, it was re-measured on every later tick.
			for (const name of unknown) {
				if (encodeURIComponent(name).length > LIVE_URL_BUDGET) live.known.add(name);
			}
			if (batch.length === 0) return;
			const key = batch.join(",");
			live.inFlight = true;
			fetch(ROUTE + "?m=" + encodeURIComponent(key), {
				credentials: "same-origin",
				// Without a deadline a request that never settles leaves inFlight
				// true forever, so no unpriced model on this page would ever be
				// retried (the "pill stuck on unpriced" symptom after a host
				// restart or half-open connection).
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
					// A newer catalog invalidates "this name has no price". The answer
					// was about the previous snapshot; the same name may be listed now.
					if (Number.isFinite(fetchedAt) && fetchedAt > 0 && live.fetchedAt > 0 && fetchedAt !== live.fetchedAt) {
						// Names not in this batch keep their rate until they are asked.
						// Clearing known is what makes that later ask happen.
						live.known = new Set();
					}
					if (Number.isFinite(fetchedAt) && fetchedAt > 0) live.fetchedAt = fetchedAt;
					// Only the names this request sent. An answer with no usable rate
					// retires a rate we stored earlier; an empty object is not a rate.
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
						// The same four numbers are not a new catalog. Replacing the object
						// anyway bumped the generation and recomputed every session cost.
						if (held && held.input === next.input && held.output === next.output
							&& held.cacheRead === next.cacheRead && held.cacheWrite === next.cacheWrite) continue;
						live.models[name] = next;
						added = true;
					}
					// A generation bump is what invalidates the cost memo. An answer that
					// added no rate (already known, or genuinely unpriced) must not.
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
					liveNotify();
				});
		}

		/**
		 * Catalog rate for one model, or undefined.
		 * @param {string|undefined} model - routed model id.
		 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|undefined}
		 */
		function liveRateFor(model) {
			if (typeof model !== "string" || model.length === 0) return undefined;
			for (const candidate of nameCandidates(model)) {
				const rate = live.models[candidate];
				if (rate !== undefined) return rate;
			}
			return undefined;
		}

		/**
		 * Rate in force for one model at one instant.
		 *
		 * The built-in DeepSeek table wins (it carries the official peak/off-peak
		 * split); a catalog price is a single reference rate used for both periods,
		 * so it flags `periodPriced: false` and the pill drops its period marker.
		 * @param {string|undefined} model - routed model id.
		 * @param {number} at - instant the request started.
		 * @param {object} [config] - overrides PEAK (tests / diagnostics).
		 * @returns {{rate: object, reference: boolean, periodPriced: boolean}|undefined}
		 */
		function rateAt(model, at, config) {
			const tier = priceOf(model);
			if (tier !== undefined) {
				return { rate: isPeakAt(at, config) ? tier.peak : tier.offPeak, reference: false, periodPriced: true };
			}
			const catalogRate = liveRateFor(model);
			if (catalogRate !== undefined) return { rate: catalogRate, reference: true, periodPriced: false };
			return undefined;
		}

		/**
		 * Model id -> price tier, or undefined when the name does not identify a
		 * DeepSeek model.
		 *
		 * The point of this function is exactly what a user sees in the selector:
		 * a third-party relay shows the model it serves under its own route name
		 * (`auto/deepseek-v4.1-flash`, `workbuddy/deepseek-v4.1-flash`,
		 * `opencode-zen-free/deepseek-v4.1-flash-free`). Those names still say
		 * which official model is behind them, and the plugin prices them at that
		 * official rate - it deliberately does not try to model a relay's own
		 * billing, which the client cannot see anyway.
		 *
		 * Lookup order: exact id -> last segment of `provider/model` -> family
		 * word (`flash` / `pro`), but only when that segment still looks like a
		 * billed DeepSeek id: it says `deepseek`, or it is the bare spelling with
		 * no vendor word in front (`v4.1-flash`, `relay/v4-pro`). A segment that
		 * leads with anything else (`mimo-v2.6-pro`, `llama-pro`,
		 * `qwen3-coder-flash`) names another vendor and stays unpriced here, so
		 * `rateAt` can price it from the catalog instead.
		 * @param {string|undefined} model - routed model id.
		 * @returns {{peak: object, offPeak: object}|undefined}
		 */
		function priceOf(model) {
			if (typeof model !== "string" || model.length === 0) return undefined;
			// `@1m` / `@500k` is a route's context-window tag, not part of the
			// billed id. A snapshot date (`@20251101`) has no unit and stays.
			const lower = model.toLowerCase().replace(CONTEXT_SUFFIX, "");
			if (Object.hasOwn(PRICING, lower)) return PRICING[lower];
			const slash = lower.lastIndexOf("/");
			const tail = slash >= 0 ? lower.slice(slash + 1) : lower;
			if (Object.hasOwn(PRICING, tail)) return PRICING[tail];
			if (!tail.includes("deepseek") && !BARE_FAMILY.test(tail)) return undefined;
			for (const family of FAMILIES) {
				if (tail.includes(family[0])) return family[1];
			}
			return undefined;
		}

		/** Trailing release-suffix noise a relay may append to an official id. */
		const RELEASE_SUFFIX = /-(preview|latest|free|beta|alpha|experimental|contributor)$/;
		/**
		 * Context-window tag a route appends (`grok-4.7@500k`). Not part of the
		 * catalog id. Snapshot dates (`@20250929`) have no k/m/b unit and stay.
		 * Mirrors CONTEXT_SUFFIX in lib/prices.js.
		 */
		const CONTEXT_SUFFIX = /@\d+(?:\.\d+)?[kmb]$/;

		/**
		 * Every spelling of a routed model id worth trying against the online
		 * catalog, most specific first (mirrors the Host's lib/prices.js).
		 * @param {string|undefined} model - `provider/model` or bare model id.
		 * @returns {string[]}
		 */
		function nameCandidates(model) {
			if (typeof model !== "string" || model.length === 0) return [];
			const lower = model.toLowerCase();
			const forms = [lower];
			const bare = lower.replace(CONTEXT_SUFFIX, "");
			if (bare !== lower) forms.push(bare);
			const collapseMinor = (value) => value.replace(/\.(\d+)(?=[-/])/g, "");
			const stripSuffix = (value) => value.replace(RELEASE_SUFFIX, "");
			const out = [];
			const push = (value) => {
				if (value.length > 0 && !out.includes(value)) out.push(value);
			};
			for (const form of forms) {
				const slash = form.lastIndexOf("/");
				const tail = slash >= 0 ? form.slice(slash + 1) : form;
				push(form);
				push(tail);
				for (const value of [tail, collapseMinor(tail)]) {
					push(stripSuffix(value));
					push(collapseMinor(stripSuffix(value)));
					push(stripSuffix(collapseMinor(value)));
				}
			}
			return out;
		}

		const ZERO = Object.freeze({
			uncachedInputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});

		function numberOrZero(value) {
			return Number.isFinite(value) && value > 0 ? value : 0;
		}

		/**
		 * Normalise one durable TokenUsage into the four disjoint billing
		 * buckets. `inputTokens` is already the uncached prompt count (the
		 * token-meter projection maps it to `uncachedInputTokens` verbatim).
		 * @param {object|undefined} usage - provider-reported TokenUsage.
		 * @returns {object|undefined} buckets, or undefined for an empty sample.
		 */
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

		/**
		 * Convert one token-bucket value to CNY.
		 * `cacheWrite` falls back to the input rate for tables that do not quote a
		 * separate cache-write price, which is what DeepSeek charges.
		 * @param {object} usage - buckets value.
		 * @param {object} rate - CNY per million tokens.
		 * @returns {number}
		 */
		function costOf(usage, rate) {
			if (!usage || !rate) return 0;
			const perMillion = (tokens, price) => (numberOrZero(tokens) / 1000000) * price;
			const cacheWrite = Number.isFinite(rate.cacheWrite) ? rate.cacheWrite : rate.input;
			return perMillion(usage.uncachedInputTokens, rate.input)
				+ perMillion(usage.cacheReadTokens, rate.cacheRead)
				+ perMillion(usage.cacheWriteTokens, cacheWrite)
				+ perMillion(usage.outputTokens, rate.output);
		}

		/** Total billed tokens across the disjoint buckets and output. */
		function totalBilledTokens(usage) {
			if (!usage) return 0;
			return numberOrZero(usage.uncachedInputTokens)
				+ numberOrZero(usage.cacheReadTokens)
				+ numberOrZero(usage.cacheWriteTokens)
				+ numberOrZero(usage.outputTokens);
		}

		/**
		 * Per-request cost list, cheapest useful "per turn" view. Prices each
		 * request at the period its own start time fixes, using the same helpers
		 * the session total uses, so the two cannot drift. Pure: no DOM, no clock.
		 * @param {Array} requests
		 * @param {{current?:object, rateAt?:Function, config?:object}} [opts]
		 * @returns {Array<{index:number,turn:number|undefined,step:number|undefined,model:string,at:number|undefined,priced:boolean,cost:number,tokens:number}>}
		 */
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

		/**
		 * Provider/model a request actually ran on. The assistant message's own
		 * source is authoritative; a request that has not settled yet falls back
		 * to the header it was issued with.
		 * @param {object} request - one trajectory request record.
		 * @returns {{provider: string|undefined, model: string|undefined}|undefined}
		 */
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

		/**
		 * Fixed instants used to price usage that nothing dates. Both fall on a
		 * plain weekday (2026-10-22, a Thursday): one inside a peak window and
		 * one outside. The average of the two is the only clock-free expectation,
		 * so an undated estimate can never swing when the period flips.
		 */
		const UNKNOWN_PEAK_AT = Date.UTC(2026, 9, 22, 2, 0); // 10:00 Beijing
		const UNKNOWN_OFFPEAK_AT = Date.UTC(2026, 9, 22, 14, 0); // 22:00 Beijing

		/**
		 * Billing instant for every request: its own `startedAt` when the record
		 * carries one, otherwise the nearest request's (records arrive in start
		 * order; forward fill first, then backward fill). A request is never
		 * re-dated to the render time: tokens used in one period must keep that
		 * period's price when the clock crosses a window edge (reported
		 * 2026-10-29).
		 * @param {Array} requests - trajectory request records.
		 * @returns {Array<number|undefined>} one instant per request.
		 */
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

		/**
		 * Stable identity of one request, mirroring the host's own key scheme
		 * (`assistant` by turn+step, `compaction` by seq). Undefined for a record
		 * with no identity at all: such a record is charged for the current
		 * render only and never enters the ledger, because a positional key
		 * would double-count it across renders.
		 * @param {object} request - one trajectory request record.
		 * @returns {string|undefined}
		 */
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

		/**
		 * Price a whole session model by model, pinned to the interval each
		 * token block was billed in.
		 *
		 * Billing never reads the render-time clock: a request is charged at the
		 * peak/off-peak rate in force when it STARTED (its own `startedAt`, or
		 * the nearest request's when the record carries none), and it keeps that
		 * price for good. Re-pricing off-peak history at peak rates once the
		 * clock entered a peak window -- and the reverse -- was a reported bug
		 * (2026-10-29).
		 *
		 * The durable `tokenUsage` projection is the authority for the session
		 * total, so usage beyond the seen requests (history the window never
		 * showed: not paged in, or dropped by a compaction rewrite) is topped up
		 * as an estimate at the OLDEST instant this page session knows -- unseen
		 * history is older than everything seen. With no instant at all the
		 * estimate is the fixed peak/off-peak average (UNKNOWN_*_AT). Neither
		 * follows the clock.
		 *
		 * Callers may pass the previous `pinned` map so requests that later drop
		 * out of the window keep their price; the returned `pinned` map is the
		 * one to pass back on the next call.
		 *
		 * @param {object} input
		 * @param {Array|undefined} input.requests - trajectory request records.
		 * @param {object|undefined} input.totals - tokenUsage projection buckets.
		 * @param {{provider?: string, model?: string}|undefined} input.current - routed selection.
		 * @param {number} input.now - current instant (ms); display decisions only.
		 * @param {Map} [input.pinned] - retention ledger from the previous call.
		 * @param {object} [input.config] - overrides PEAK (tests / diagnostics).
		 * @param {Function} [input.rateAt] - `(model, at) => {rate, reference}|undefined`;
		 *   defaults to the built-in table plus the fetched catalog.
		 * @returns {{cost: number, datedCosts: Map, rows: Array, unpricedTokens: number, remainderTokens: number, pinned: Map}}
		 */
		/**
		 * A number that changes when any request's usage, or the session totals,
		 * change in place.
		 *
		 * A streaming turn rewrites `usage` on the same request object and the
		 * same array. Watching only the tail would miss a correction to an
		 * earlier row. The walk is a few mixes per request, not the cost walk.
		 *
		 * Buckets are mixed one at a time. A weighted sum collided: 5 input
		 * tokens and 1 output token produced the same stamp, so the pill kept
		 * the old price.
		 * @param {Array|undefined} requests
		 * @param {object|undefined} totals
		 * @returns {number}
		 */
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
				// Same order as modelOfRequest: the served model, else the model the
				// request was issued with. A stamp that only read providerMetadata
				// ignored an in-place change of requestConfig.
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
			// Every request, not just the tail: a compaction can rewrite an earlier
			// record without changing the length or the last row.
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
			// A number, not the table: String(object) is always "[object Object]",
			// which would keep yesterday's price after the catalog arrives.
			hash = mixKey(hash, input._liveGeneration);
			return hash;
		}

		function costBreakdown(input) {
			const requests = Array.isArray(input.requests) ? input.requests : [];
			const current = input.current && typeof input.current === "object" ? input.current : {};
			const config = input.config || PEAK;
			const now = Number.isFinite(input.now) ? input.now : Date.now();
			const customLookup = typeof input.rateAt === "function";
			const lookup = customLookup
				? input.rateAt
				: (model, at) => rateAt(model, at, config);

			/** Whether the model the composer would use now is period-priced. */
			const currentUsesPeriods = () => {
				const priced = lookup(current.model, now);
				return priced !== undefined && priced.periodPriced === true;
			};

			// Same requests, same totals, same catalog: the clock tick cannot change
			// a pinned price. Skip the walk and only refresh the period-marker flag,
			// which DOES follow `now` (a fresh DeepSeek selection, no rows yet).
			const memo = input._memo;
			const sameLookup = memo && memo.customLookup === customLookup && (!customLookup || memo.lookup === lookup);
			// Identity check first. A clock tick keeps the same requests array, totals
			// object and ledger; hashing every row on that tick was the whole walk
			// the memo was meant to skip. A new array (trajectory publish, compaction)
			// falls through to the fingerprint.
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

			// Retention ledger: every request this page session has seen, keyed
			// by identity, so a record that later drops out of the window
			// (compaction rewrites it, paging replaces it) keeps the price its
			// own start time fixes. Callers pass the previous map back in on
			// every render.
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
					// No identity to upsert by: charged for this render only. A
					// positional key would double-count it across renders.
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
						priced: false,
						reference: false,
						periodPriced: false,
						estimated: false,
					};
					rows.set(key, row);
				}
				return row;
			};

			// The oldest instant this page session knows. Usage the durable
			// projection counts beyond the seen requests is history the window
			// never showed, so it predates everything seen and is estimated at
			// this instant -- never at the render-time period.
			let anchorAt;
			const noteInstant = (value) => {
				if (Number.isFinite(value) && (anchorAt === undefined || value < anchorAt)) anchorAt = value;
			};
			for (const entry of entries.values()) noteInstant(entry.at);
			for (const entry of loose) noteInstant(entry.at);

			/**
			 * Price one usage block at the instant pinned to it -- the request's
			 * own start time, the nearest request's, or the oldest known -- and,
			 * when nothing dates it, at the fixed peak/off-peak average. The
			 * render-time clock is never consulted: tokens used in one period
			 * must keep that period's price.
			 */
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
					row.priced = true;
					if (hit.reference === true) row.reference = true;
					if ((peak !== undefined && peak.periodPriced === true) || (off !== undefined && off.periodPriced === true)) row.periodPriced = true;
					row.cost += rowCost;
					cost += rowCost;
					return;
				}
				const priced = lookup(entry.model, at);
				if (priced === undefined) {
					unpricedTokens += totalBilledTokens(entry.usage);
					return;
				}
				const rowCost = costOf(entry.usage, priced.rate);
				row.priced = true;
				if (priced.reference === true) row.reference = true;
				if (priced.periodPriced === true) row.periodPriced = true;
				row.cost += rowCost;
				cost += rowCost;
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

			// Whole-log projection minus what the seen requests already account
			// for: nonzero only when history fell outside the window. Charged as
			// an estimate above, but reported separately so the caller can see
			// how much of the total was attributed rather than measured.
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
					// History the projection counts but the window never showed.
					// Older than everything seen, so estimated at the oldest known
					// instant (or the fixed average) -- never at the render-time
					// period, which re-priced past tokens on every window flip.
					charge({
						provider: current.provider,
						model: current.model,
						at: anchorAt,
						own: false,
						usage: remainder,
					}, true);
				}
			} else if (entries.size === 0 && loose.length === 0) {
				// No tokenUsage projection either: nothing billable to show.
				return { cost, datedCosts, rows: [], unpricedTokens, remainderTokens: 0, periodPriced: currentUsesPeriods(), pinned: entries };
			}

			const visibleRows = [...rows.values()].filter((row) => totalBilledTokens(row.usage) > 0);
			return {
				cost,
				datedCosts,
				rows: visibleRows,
				unpricedTokens,
				remainderTokens: totals === undefined ? 0 : remainderTokens,
				// Whether the period marker means anything for this session: true when
				// any model in play is billed by the official peak/off-peak table, or
				// when the routed model is (a fresh session has no rows yet). A session
				// running only on flat-priced models has no period to report.
				periodPriced: visibleRows.some((row) => row.periodPriced) || currentUsesPeriods(),
				pinned: entries,
			};
		}

		/** CNY amount: keep enough decimals that a tiny session is not shown as 0.00. */
		function fmtMoney(value) {
			if (!Number.isFinite(value)) return "\u2014";
			if (value === 0) return "\u00a50.00";
			if (value < 0.01) return "\u00a5" + value.toFixed(4);
			if (value < 1) return "\u00a5" + value.toFixed(3);
			return "\u00a5" + value.toFixed(2);
		}

		/**
		 * How full the next prompt is, against the route's advertised window.
		 *
		 * `projectedTokens` is what the next request's prompt would cost (the
		 * token-meter's own definition: last provider sample plus the surface
		 * delta). `pressureTokens` is that sample alone, used when the projection
		 * has not derived the next-prompt figure yet. Neither is this session's
		 * billed total: output is excluded, so the number does not climb while a
		 * turn streams.
		 *
		 * The bands are the ones ccusage prints on its status line: under half,
		 * half to four fifths, and past that. A route that never advertised a
		 * window still reports the token count, with no percentage and no band.
		 *
		 * @param {{projectedTokens?: number, pressureTokens?: number, contextWindow?: number}|undefined} pressure
		 * @returns {{used: number, window: number|undefined, percent: number|undefined, band: "low"|"mid"|"high"|"unknown"}|undefined}
		 */
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
		 * What the cache reads were worth: the same tokens billed at the input
		 * rate instead of the cache-read rate. A table that quotes cache reads at
		 * the input rate saves nothing, and the pill stays quiet rather than
		 * printing a zero.
		 *
		 * @param {Array<{usage: object, priced?: boolean, periodPriced?: boolean}>} rows
		 * @param {(model: string|undefined, at: number) => {rate: object}|undefined} lookup
		 * @param {number} now - only consulted for a row the period table prices,
		 *   because that row's own instants are already folded into its cost and
		 *   the current window is the rate a reader can check.
		 * @returns {number}
		 */
		function cacheSaved(rows, lookup, now) {
			if (!Array.isArray(rows) || typeof lookup !== "function") return 0;
			let saved = 0;
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				if (!row || row.priced !== true) continue;
				const reads = numberOrZero(row.usage && row.usage.cacheReadTokens);
				if (reads <= 0) continue;
				const hit = lookup(row.model, row.periodPriced === true ? now : UNKNOWN_OFFPEAK_AT);
				if (!hit || !hit.rate) continue;
				const input = numberOrZero(hit.rate.input);
				const read = numberOrZero(hit.rate.cacheRead);
				if (input <= read) continue;
				saved += ((reads / 1000000) * (input - read));
			}
			return saved;
		}

		/**
		 * Spend per hour across the span the requests actually cover.
		 *
		 * One request, or a span under a minute, is not a pace: dividing the bill
		 * by a few seconds prints a number nobody spent. Under an hour the figure
		 * is the session so far, not an extrapolation.
		 *
		 * @param {number} cost
		 * @param {Map<string, {at?: number}>|undefined} pinned
		 * @param {number} now
		 * @returns {number|undefined}
		 */
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

		/** Compact token count: 1234 -> 1.23K, 1234567 -> 1.23M. */
		function fmtTokens(value) {
			if (!Number.isFinite(value)) return "\u2014";
			if (value < 1000) return String(value);
			if (value < 1000000) {
				const text = (value / 1000).toFixed(value < 10000 ? 2 : 1);
				return text.replace(/\.0+$/, "") + "K";
			}
			return (value / 1000000).toFixed(2).replace(/\.0+$/, "") + "M";
		}

		/**
		 * How long the pill may sleep before the next redraw.
		 *
		 * The period dot has to move when the window flips, not up to one poll
		 * later, and a failed catalog lookup has to wake at its retry time. With
		 * neither pending, sleeping until the flip (capped) replaces a fixed 30 s
		 * poll: the dot was late, and every open session re-rendered for a cost
		 * that cannot change until a request does.
		 *
		 * @param {number} nowMs
		 * @param {{flipAt?: number, retryAt?: number, retryDue?: boolean, capMs?: number}} [options]
		 * @returns {number} delay in milliseconds, at least 250.
		 */
		function nextDelayMs(nowMs, options) {
			const opts = options || {};
			const cap = Number.isFinite(opts.capMs) && opts.capMs > 0 ? opts.capMs : 300000;
			let wait = cap;
			if (Number.isFinite(opts.flipAt) && opts.flipAt > nowMs) {
				const until = opts.flipAt - nowMs;
				const hour = 60 * MINUTE_MS;
				// The pill prints the countdown for the last hour. Once it is up, the
				// label changes when the remainder crosses a minute, not on the clock.
				if (opts.countdown === true && until <= hour) {
					const into = until % MINUTE_MS;
					const boundary = into === 0 ? MINUTE_MS : into;
					wait = Math.min(wait, until, boundary);
				} else if (opts.period === true && until > hour) {
					// Only a period-priced session prints the countdown. A flat session
					// has nothing to show at the hour, so it keeps the long sleep.
					wait = Math.min(wait, until - hour);
				} else {
					wait = Math.min(wait, until);
				}
			}
			if (Number.isFinite(opts.retryAt) && opts.retryAt > nowMs) wait = Math.min(wait, opts.retryAt - nowMs);
			else if (opts.retryDue === true) wait = Math.min(wait, 1000);
			return Math.max(250, wait);
		}

		/**
		 * The countdown label is computed from the last render's clock. That clock
		 * can be several minutes old when the label first appears, after a model
		 * switch into the last hour. A few seconds of drift is the render itself.
		 * @param {number} shownAt
		 * @param {number} wall
		 * @param {boolean} active
		 * @returns {boolean}
		 */
		function countdownStale(shownAt, wall, active) {
			if (active !== true) return false;
			if (!Number.isFinite(shownAt) || !Number.isFinite(wall)) return false;
			return wall - shownAt > 5000;
		}

		/** The pill is absent and no catalog retry is waiting, so a timer would only redraw nothing. */
		function pillNeedsClock(showPill, retryPending) {
			return showPill === true || retryPending === true;
		}

		/**
		 * The price effect re-asks only when a lookup has failed. A countdown tick
		 * changes `now` every minute and must not re-enter the catalog request.
		 * @param {number} now
		 * @param {string|undefined} lastError
		 * @returns {number}
		 */
		function priceEffectTick(now, lastError) {
			return typeof lastError === "string" && lastError.length > 0 ? now : 0;
		}

		/**
		 * Countdown text: 25 min / 2 h 5 min / 3 d 4 h.
		 *
		 * A positive span rounds up to the next minute. Rounding to nearest made
		 * the last half minute read "0 min" while the window was still open.
		 * A zero or negative span is the only thing that reads 0.
		 */
		function fmtSpan(ms, t) {
			if (!Number.isFinite(ms) || ms <= 0) return "0 " + textKey(t, "minute");
			const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS - 1e-9));
			// 60 stays "60 min". Treating 60 as an hour made 59 min 1 s read
			// "1 h" for the whole last minute of that hour.
			if (totalMinutes <= 60) return totalMinutes + " " + textKey(t, "minute");
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			// 24 stays "24 h", for the same reason 60 stays "60 min".
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

		/* --------------------------------------------------------------- view */
		/**
		 * One press on the pill.
		 *
		 * The browser closes the popover on pointerdown, then delivers the click.
		 * Toggling on the click reopens it, because React has not re-rendered yet
		 * and `open` is still true. So pointerdown while open closes and arms
		 * `swallowClick`; the click that follows is discarded.
		 *
		 * A keyboard activation has no pointerdown. While the panel is open that
		 * click closes it; treating every click as "open" left Enter and Space
		 * unable to dismiss the panel.
		 *
		 * @param {boolean} open
		 * @param {boolean} swallowClick - armed by the pointerdown of this press.
		 * @param {"pointerdown"|"click"} phase
		 * @returns {{open: boolean, swallowClick: boolean}}
		 */
		function pillGesture(open, swallowClick, phase) {
			if (phase === "pointerdown") {
				if (!open) return { open: false, swallowClick: false };
				return { open: false, swallowClick: true };
			}
			if (swallowClick) return { open: false, swallowClick: false };
			return { open: !open, swallowClick: false };
		}

		/** Ids for the breakdown popover. One per mount, so two sessions do not collide. */
		let breakdownSerial = 0;
		function nextBreakdownId() {
			breakdownSerial += 1;
			return breakdownSerial;
		}

		/**
		 * Where the breakdown panel sits relative to the pill.
		 *
		 * Below the pill when it fits, above it when the composer is at the
		 * bottom of the viewport. `top` is the panel's top edge; `maxHeight` is
		 * what remains in that direction, so the panel scrolls instead of leaving
		 * the viewport.
		 * @param {{left: number, top: number, bottom: number, width: number}} anchor
		 * @param {{width: number, height: number}} view
		 * @param {{width?: number, margin?: number, maxHeight?: number}} [options]
		 * @returns {{left: number, top: number, maxHeight: number}}
		 */
		function panelBox(anchor, view, options) {
			const opts = options || {};
			const width = opts.width || 320;
			const margin = opts.margin || 8;
			const gap = 6;
			const cap = opts.maxHeight || 240;
			const viewWidth = Number.isFinite(view.width) && view.width > 0 ? view.width : width + margin * 2;
			const viewHeight = Number.isFinite(view.height) && view.height > 0 ? view.height : cap + margin * 2;
			const left = Math.max(margin, Math.min(anchor.left, viewWidth - Math.min(width, viewWidth - margin * 2) - margin));
			const below = viewHeight - anchor.bottom - gap - margin;
			const above = anchor.top - gap - margin;
			const placeBelow = below >= 120 || below >= above;
			const room = Math.max(80, placeBelow ? below : above);
			const maxHeight = Math.min(cap, room);
			const top = placeBelow
				? anchor.bottom + gap
				: Math.max(margin, anchor.top - gap - maxHeight);
			return { left, top, maxHeight };
		}

		const style = {
			anchor: {
				minWidth: 0,
				display: "inline-flex",
				fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
				lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
			},
			pill: {
				boxSizing: "border-box",
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "1px 8px",
				borderRadius: "var(--dsw-radius-sm)",
				color: "var(--dsw-alias-label-tertiary)",
				font: "inherit",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
				maxWidth: "100%",
			},
			dot: {
				flex: "none",
				width: "7px",
				height: "7px",
				borderRadius: "999px",
			},
			label: {
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			soon: {
				color: "var(--dsw-alias-label-secondary)",
			},
			// Context bands follow ccusage's status line: quiet, then warning, then
			// danger. The rest of the pill stays tertiary so one number can shout.
			fill: {
				low: "var(--dsw-alias-state-success-primary)",
				mid: "var(--dsw-alias-state-warn-primary)",
				high: "var(--dsw-alias-state-danger-primary, var(--dsw-alias-state-warn-primary))",
				unknown: "var(--dsw-alias-label-tertiary)",
			},
			sep: {
				color: "var(--dsw-alias-separator-primary)",
				margin: "0 1px",
			},
			button: {
				minWidth: 0,
				display: "inline-flex",
				appearance: "none",
				background: "transparent",
				border: 0,
				padding: 0,
				margin: 0,
				color: "inherit",
				font: "inherit",
				fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
				lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
				cursor: "pointer",
				textAlign: "inherit",
			},
			panel: {
				position: "fixed",
				margin: 0,
				boxSizing: "border-box",
				width: "min(320px, calc(100vw - 16px))",
				maxHeight: "240px",
				overflow: "auto",
				padding: "8px 10px",
				borderRadius: "var(--dsw-radius-sm, 6px)",
				border: "1px solid var(--dsw-alias-border-l3)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary, inherit)",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "1.45",
				textAlign: "left",
				whiteSpace: "normal",
			},
			panelLine: {
				padding: "1px 0",
			},
			exportButton: {
				appearance: "none",
				background: "transparent",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm, 6px)",
				padding: "0 6px",
				marginTop: "4px",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				cursor: "pointer",
			},
		};

		/**
		 * One model row for the breakdown panel: the name, then one fact per line.
		 * A single run-on line was the whole reason a long session's panel could
		 * not be scanned.
		 * @returns {string[]}
		 */
		function modelLines(row, t) {
			const label = row.model || textKey(t, "unknown");
			const tokens = fmtTokens(totalBilledTokens(row.usage));
			const amount = row.priced ? fmtMoney(row.cost) : textKey(t, "noPrice");
			const marks = (row.reference ? "*" : "") + (row.estimated ? " ~" : "");
			const lines = [label + marks, tokens + " " + textKey(t, "tokensUnit") + "  " + amount];
			const usage = row.usage || {};
			const parts = [];
			if (numberOrZero(usage.uncachedInputTokens) > 0) parts.push(textKey(t, "input") + " " + fmtTokens(usage.uncachedInputTokens));
			if (numberOrZero(usage.outputTokens) > 0) parts.push(textKey(t, "output") + " " + fmtTokens(usage.outputTokens));
			if (numberOrZero(usage.cacheReadTokens) > 0) parts.push(textKey(t, "cacheRead") + " " + fmtTokens(usage.cacheReadTokens));
			if (parts.length > 0) lines.push(parts.join(" \u00b7 "));
			return lines;
		}

		/** One line, for callers that still want the compact form. */
		function modelLine(row, t) {
			return modelLines(row, t).join("  ");
		}

		/**
		 * Serialize a breakdown for export (CSV or JSON). Pure: no DOM, no clock,
		 * so a test can assert the exact bytes. Costs are CNY estimates already in
		 * the breakdown; this only re-shapes them for a spreadsheet or a script.
		 */
		function exportBreakdown(breakdown, format) {
			const rows = Array.isArray(breakdown && breakdown.rows) ? breakdown.rows : [];
			const shape = (row) => {
				const usage = row.usage || {};
				return {
					model: row.model || "",
					priced: row.priced === true,
					uncachedInputTokens: numberOrZero(usage.uncachedInputTokens),
					outputTokens: numberOrZero(usage.outputTokens),
					cacheReadTokens: numberOrZero(usage.cacheReadTokens),
					cacheWriteTokens: numberOrZero(usage.cacheWriteTokens),
					billedTokens: totalBilledTokens(usage),
					costCny: row.priced === true && Number.isFinite(row.cost) ? row.cost : null,
					reference: row.reference === true,
					estimated: row.estimated === true,
				};
			};
			const shaped = rows.map(shape);
			if (String(format).toLowerCase() === "csv") {
				const header = "model,priced,uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,billedTokens,costCny,reference,estimated";
				const esc = (value) => {
					const text = value === null || value === undefined ? "" : String(value);
					return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
				};
				const body = shaped.map((row) => [
					row.model, row.priced, row.uncachedInputTokens, row.outputTokens,
					row.cacheReadTokens, row.cacheWriteTokens, row.billedTokens,
					row.costCny === null ? "" : row.costCny, row.reference, row.estimated,
				].map(esc).join(","));
				return [header, ...body].join("\n");
			}
			return JSON.stringify({
				totalCny: Number.isFinite(breakdown && breakdown.cost) ? breakdown.cost : null,
				unpricedTokens: numberOrZero(breakdown && breakdown.unpricedTokens),
				remainderTokens: numberOrZero(breakdown && breakdown.remainderTokens),
				rows: shaped,
			}, null, 2);
		}

		/* ---------------------------------------------------------- day ledger */

		const LEDGER_STORAGE_KEY = "dsh-session-meter-ledger";
		const LEDGER_VERSION = 2;
		const LEDGER_MAX_DAYS = 60;
		const LEDGER_MAX_SESSIONS = 200;

		/** Local calendar day key, e.g. 2026-11-22. */
		function localDateKey(ms) {
			const date = new Date(Number.isFinite(ms) ? ms : Date.now());
			return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
		}

		function normalizeLedger(ledger) {
			// Earlier ledgers stored lifetime totals without request dates.
			if (ledger?.version === LEDGER_VERSION && ledger.days && typeof ledger.days === "object") return ledger;
			return { version: LEDGER_VERSION, days: {} };
		}

		/** Upsert dated estimates by session and request, keeping requests already seen. */
		function updateDayLedger(ledger, sessionId, datedCosts) {
			ledger = normalizeLedger(ledger);
			if (typeof sessionId !== "string" || sessionId === "" || datedCosts.size === 0) return ledger;
			const days = { ...ledger.days };
			const retainedDates = [...new Set([...Object.keys(days), ...datedCosts.keys()])].sort().slice(-LEDGER_MAX_DAYS);
			let changed = false;
			for (const date of retainedDates) {
				const costs = datedCosts.get(date);
				if (costs === undefined) continue;
				const sessions = days[date] ?? {};
				const previous = (Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined) ?? {};
				if ([...costs].every(([requestId, cost]) => previous[requestId] === cost)) continue;
				const merged = { ...sessions, [sessionId]: { ...previous, ...Object.fromEntries(costs) } };
				const ids = Object.keys(merged);
				for (const id of ids.slice(0, Math.max(0, ids.length - LEDGER_MAX_SESSIONS))) delete merged[id];
				days[date] = merged;
				changed = true;
			}
			if (!changed) return ledger;
			return { version: LEDGER_VERSION, days: Object.fromEntries(retainedDates.map((date) => [date, days[date]])) };
		}

		/** One day's summed cost from the ledger. */
		function dayTotal(ledger, date) {
			const sessions = normalizeLedger(ledger).days[date];
			let total = 0;
			for (const requests of Object.values(sessions ?? {})) {
				for (const cost of Object.values(requests ?? {})) if (Number.isFinite(cost)) total += cost;
			}
			return total;
		}

		function loadLedger(fallback) {
			try {
				if (typeof localStorage !== "undefined") {
					const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
					if (typeof raw === "string" && raw !== "") return normalizeLedger(JSON.parse(raw));
				}
			} catch { /* storage is best-effort */ }
			return normalizeLedger(fallback);
		}

		function saveLedger(ledger) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger));
			} catch { /* storage full or blocked: the ledger is best-effort */ }
		}

		/* A host without the Trajectory feature still renders; hooks must run in a
		 * stable order, so the fallback is a hook-shaped reader over an empty
		 * snapshot rather than a conditional call. */
		const EMPTY_TRAJECTORY = Object.freeze({ requests: Object.freeze([]) });
		function useEmptyTrajectory(selector) {
			return selector(EMPTY_TRAJECTORY);
		}

		/**
		 * Per-request model + usage records. Returns the requests array of the
		 * Trajectory target, or an empty array when the host has no Trajectory.
		 * @param {Function|undefined} useTrajectory - standard slot prop.
		 * @returns {Array}
		 */
		function useRequestRecords(useTrajectory) {
			const reader = typeof useTrajectory === "function" ? useTrajectory : useEmptyTrajectory;
			return reader((snapshot) => snapshot.requests);
		}

		/** The pill: current peak/off-peak state + this session's estimated cost. */
		function SessionMeter(props) {
			const t = props.t;
			const useProjection = props.useProjection;
			const usage = useProjection("tokenUsage");
			const selection = useProjection("modelSelection");
			// Newest prompt size against the route window. Absent on a host that
			// does not publish the projection; the pill then omits the fill.
			const pressure = useProjection("contextPressure");
			const requests = useRequestRecords(props.useTrajectory);
			const [now, setNow] = React.useState(() => Date.now());
			const [liveRevision, setLiveRevision] = React.useState(0);
			const [open, setOpen] = React.useState(false);
			const [balance, setBalance] = React.useState(null);
			const [ledger, setLedger] = React.useState(() => loadLedger());
			const buttonRef = React.useRef(null);
			const swallowClickRef = React.useRef(false);
			const countdownRef = React.useRef(false);
			const periodRef = React.useRef(false);
			const popIdRef = React.useRef("");
			if (popIdRef.current === "") popIdRef.current = "session-meter-breakdown-" + nextBreakdownId();

			React.useEffect(() => liveSubscribe(() => setLiveRevision((value) => value + 1)), []);

			// Account balance: fetched only when the panel opens, from the host's
			// read-only, key-gated route. Absent key / offline / non-loopback just
			// means no line; the pill never depends on it.
			React.useEffect(() => {
				if (!open) {
					setBalance(null);
					return undefined;
				}
				let alive = true;
				const controller = new AbortController();
				try {
					if (typeof fetch === "function") {
						fetch("/session-meter/balance", { signal: controller.signal, headers: { accept: "application/json" } })
							.then((response) => (response && response.ok ? response.json() : null))
							.then((value) => { if (alive && value && value.ok === true) setBalance(value); })
							.catch(() => {});
					}
				} catch { /* no fetch: balance stays absent */ }
				return () => { alive = false; controller.abort(); };
			}, [open]);

			const peak = isPeakAt(now);
			const model = selection && selection.next ? selection.next.model : undefined;
			const provider = selection && selection.next ? selection.next.provider : undefined;
			const current = rateAt(model, now);
			const rate = current ? current.rate : undefined;
			// The retention ledger survives window rewrites within this mount; a
			// remount (session switch, page reload) re-derives from what loads.
			const pinnedRef = React.useRef(null);
			const memoRef = React.useRef(null);
			if (pinnedRef.current === null || memoRef.current?.sessionId !== props.sessionId) {
				pinnedRef.current = new Map();
				memoRef.current = null;
			}
			const stamp = inputStamp(requests, usage);
			const breakdownInput = {
				requests,
				totals: usage,
				current: { provider, model },
				now,
				pinned: pinnedRef.current,
				_memo: memoRef.current,
				_liveGeneration: live.generation,
				_stamp: stamp,
			};
			const breakdown = costBreakdown(breakdownInput);
			// References, not a fingerprint: the next clock tick hits `sameRefs`
			// and does not re-hash the trajectory. A published new array misses
			// the references and falls through to `key`, so the key is stored here
			// but only recomputed when the result itself changed.
			const previousMemo = memoRef.current;
			memoRef.current = {
				sessionId: props.sessionId,
				requests,
				totals: usage,
				model,
				provider,
				generation: live.generation,
				pinned: breakdown.pinned,
				stamp,
				customLookup: false,
				result: breakdown,
				key: previousMemo && previousMemo.result === breakdown
					? previousMemo.key
					: breakdownKey(breakdownInput),
			};
			pinnedRef.current = breakdown.pinned;
			// Merge against the latest storage before writing, including on panel open
			// so previously observed requests from other sessions remain visible.
			React.useEffect(() => {
				const stored = loadLedger(ledger);
				const updated = updateDayLedger(stored, props.sessionId, breakdown.datedCosts);
				if (updated !== stored) saveLedger(updated);
				setLedger(updated);
			}, [breakdown.datedCosts, open, props.sessionId]);
			const tokens = totalBilledTokens(usage);
			const flip = nextFlipAt(now);
			const fill = contextFill(pressure);
			const saved = cacheSaved(breakdown.rows, (model, at) => rateAt(model, at), now);
			const hasUnpricedUsage = breakdown.unpricedTokens > 0;
			const allUnpriced = hasUnpricedUsage && unpricedOnly(breakdown);
			const burn = hasUnpricedUsage ? undefined : burnPerHour(breakdown.cost, breakdown.pinned, now);
			// The host draws its own context ring on this same row, and hides that
			// ring while a turn is running. A second "context 12%" on every idle
			// session only lengthens the pill. The percent earns a place here once
			// the window is half full: that is the moment the colour is a warning,
			// and the moment a long turn has hidden the host ring.
			const showFill = fill !== undefined && (fill.band === "mid" || fill.band === "high");

			// Ask the Host for prices of every model this session touched. `now` is a
			// dependency on purpose: the sleep above wakes at the retry time, and
			// nothing else would ask again once the page settles. Settled names
			// return before any request.
			const asked = [model, ...breakdown.rows.map((row) => row.model)].filter(Boolean).join(",");
			const priceTick = priceEffectTick(now, live.lastError);
			React.useEffect(() => {
				requestLivePrices(asked.split(","));
			}, [asked, liveRevision, priceTick]);

			// The period marker follows the models: it only means something when a
			// model in play is billed by the official peak/off-peak table. A session
			// running on flat-priced models has no period to report, so the pill
			// shows the cost alone instead of a label that would never change.
			const showPeriod = breakdown.periodPriced === true;
			const periodLabel = showPeriod ? textKey(t, peak ? "peak" : "offPeak") : undefined;
			const costKey = hasUnpricedUsage && !allUnpriced ? "pricedSubtotal" : "spend";
			const costLabel = textKey(t, costKey) + " " + (allUnpriced ? textKey(t, "noPrice") : fmtMoney(breakdown.cost));
			// Zero is not a cost. A period-priced model still announces the window.
			const showCost = tokens > 0;
			const showPill = showPeriod || showCost;
			// The countdown used to live only in the hover title, so a window
			// ending in a few minutes looked the same as one ending tonight.
			// Show it on the pill for the last hour; longer waits stay in the title.
			const soon = showPeriod && flip !== undefined && flip - now <= 60 * MINUTE_MS;
			const soonLabel = soon ? fmtSpan(flip - now, t) : undefined;
			countdownRef.current = soon;
			periodRef.current = showPeriod;
			const clockStale = countdownStale(now, Date.now(), soon);

			// One effect so a stale clock does not also install a timer. The
			// refresh changes `now`, and the next run is what schedules the sleep.
			React.useEffect(() => {
				if (clockStale) {
					setNow(Date.now());
					return undefined;
				}
				// An empty composer has nothing that changes with the clock. A failed
				// price lookup still has to wake, because the retry is this timer.
				if (!pillNeedsClock(showPill, live.lastError !== undefined)) return undefined;
				let timer = null;
				let stopped = false;
				const hidden = () => {
					try { return typeof document !== "undefined" && document.visibilityState === "hidden"; }
					catch { return false; }
				};
				const clear = () => {
					if (timer === null) return;
					clearTimeout(timer);
					timer = null;
				};
				const schedule = () => {
					clear();
					if (stopped || hidden()) return;
					const nowMs = Date.now();
					const wait = nextDelayMs(nowMs, {
						flipAt: nextFlipAt(nowMs),
						period: periodRef.current,
						countdown: countdownRef.current,
						retryAt: live.retryAt,
						retryDue: live.lastError !== undefined && nowMs >= live.retryAt,
					});
					const midnight = new Date(nowMs);
					const delay = open ? Math.min(wait, midnight.setHours(24, 0, 0, 0) - nowMs) : wait;
					timer = setTimeout(() => {
						timer = null;
						if (!stopped) setNow(Date.now());
					}, delay);
				};
				// A hidden page has no viewer. Waking on show also covers a machine
				// that slept past the flip: the timeout alone would not have fired.
				const onVisible = () => {
					if (hidden()) { clear(); return; }
					setNow(Date.now());
				};
				try { document.addEventListener("visibilitychange", onVisible); } catch { /* non-DOM host */ }
				schedule();
				return () => {
					stopped = true;
					clear();
					try { document.removeEventListener("visibilitychange", onVisible); } catch { /* ignore */ }
				};
			}, [now, liveRevision, showPeriod, soon, clockStale, showPill, open]);

			const summary = [];
			if (showPeriod) summary.push(textKey(t, peak ? "peakTip" : "offPeakTip"));
			// No tokens yet: the pill is only the period. "Estimated cost" would
			// describe a bill that does not exist.
			if (tokens > 0 && !allUnpriced) {
				const useCatalog = !showPeriod || breakdown.rows.some((row) => row.reference);
				summary.push(textKey(t, useCatalog ? "estimateCatalog" : "estimate"));
			}
			if (hasUnpricedUsage) {
				if (!allUnpriced) summary.push(costLabel);
				summary.push(textKey(t, "unpricedUsage") + " " + fmtTokens(breakdown.unpricedTokens) + " " + textKey(t, "tokensUnit"));
			}
			if (showPeriod && flip !== undefined) summary.push(textKey(t, "nextChange") + " " + fmtSpan(flip - now, t));
			if (rate) {
				const mark = current && current.reference ? "*" : "";
				summary.push(
					textKey(t, "model") + " " + (model || textKey(t, "unknown")) + mark
					+ " " + textKey(t, "input") + " \u00a5" + rate.input
					+ " \u00b7 " + textKey(t, "output") + " \u00a5" + rate.output
					+ " \u00b7 " + textKey(t, "cacheRead") + " \u00a5" + rate.cacheRead
					+ " " + textKey(t, "perMillion"),
				);
			} else if (model) {
				summary.push(textKey(t, "model") + " " + model);
			}
			if (tokens > 0) summary.push(textKey(t, "tokens") + " " + fmtTokens(tokens));
			if (breakdown.remainderTokens > 0) {
				summary.push(textKey(t, "estimatedHistory") + " " + fmtTokens(breakdown.remainderTokens) + " " + textKey(t, "tokensUnit"));
			}
			if (saved > 0) summary.push(textKey(t, "saved") + " " + fmtMoney(saved));
			if (burn !== undefined) summary.push(textKey(t, "burn") + " " + fmtMoney(burn) + textKey(t, "perHour"));
			if (fill !== undefined) {
				const fillText = fill.percent === undefined
					? fmtTokens(fill.used)
					: fmtTokens(fill.used) + " (" + fill.percent + "%)";
				const bandKey = fill.band === "high" ? "contextHigh"
					: fill.band === "mid" ? "contextMid"
					: fill.band === "low" ? "contextLow"
					: "contextUnknown";
				summary.push(textKey(t, "context") + " " + fillText + " \u00b7 " + textKey(t, bandKey));
			}
			// Say why a model stayed unpriced instead of leaving a silent dash.
			if (live.lastError !== undefined && breakdown.rows.some((row) => !row.priced)) {
				summary.push(textKey(t, "catalogError") + " " + live.lastError);
			}
			// The per-model list used to live in the hover title. A long session
			// made that attribute thousands of characters, and the browser tooltip
			// truncated it. The list belongs to the panel; the title stays a summary.
			// The list is also the expensive string. A clock tick reuses the
			// breakdown object, so it reuses this text; the short summary above
			// (the countdown) is rebuilt because it follows the clock.
			// `byModel` stands in for the active language. A cached list from the
			// other language must be rebuilt, or the panel stays in the old one.
			const localeTag = textKey(t, "byModel");
			let detailText = previousMemo && previousMemo.result === breakdown && previousMemo.localeTag === localeTag
				? previousMemo.detailText
				: undefined;
			if (detailText === undefined) {
				const detail = [];
				if (breakdown.rows.length > 0) {
					const blocks = breakdown.rows.map((row) => modelLines(row, t).join("\n"));
					detail.push(textKey(t, "byModel") + ":\n" + blocks.join("\n\n"));
					if (breakdown.rows.some((row) => row.reference)) detail.push(textKey(t, "referenceNote"));
					const perRequest = requestCosts(requests, { current: { model, provider } });
					if (perRequest.length > 0) {
						const recent = perRequest.slice(-10);
						const reqLines = recent.map((row) => {
							const tag = row.turn !== undefined
								? "T" + row.turn + (row.step !== undefined ? "." + row.step : "")
								: "#" + (row.index + 1);
							const amount = row.priced ? fmtMoney(row.cost) : textKey(t, "noPrice");
							return tag + "  " + fmtTokens(row.tokens) + "  " + amount;
						});
						detail.push(textKey(t, "byRequest") + ":\n" + reqLines.join("\n"));
					}
				}
				detailText = detail.join("\n");
			}
			memoRef.current.detailText = detailText;
			memoRef.current.localeTag = localeTag;
			const titleParts = detailText.length > 0 ? summary.concat(textKey(t, "details")) : summary;
			const title = titleParts.join(" \u00b7 ");
			// The per-model text is the stable part. Folding the countdown into it
			// made a new multi-kilobyte string on every tick, which React then wrote
			// back into the DOM attribute. The attribute keeps the stable part; the
			// countdown stays in the hover title and, while open, at the top of the
			// panel.
			const lines = [];
			if (open) {
				const shown = detailText.length > 0 ? summary.join("\n") + "\n" + detailText : summary.join("\n");
				const chunks = shown.split("\n");
				for (let index = 0; index < chunks.length; index += 1) {
					if (chunks[index].length > 0) lines.push(chunks[index]);
				}
				if (balance && balance.ok === true && Array.isArray(balance.balances) && balance.balances.length > 0) {
					const account = balance.balances[0];
					lines.push(textKey(t, "balanceLabel") + " " + (account.currency ? account.currency + " " : "") + account.total);
				}
				const todayCost = dayTotal(ledger, localDateKey(Date.now()));
				if (todayCost > 0) lines.push(textKey(t, "today") + " " + fmtMoney(todayCost));
			}

			// The dock clips overflow and is the containing block for `position:
			// fixed`, so the breakdown is a top-layer popover, shown from here.
			React.useEffect(() => {
				if (!open) return undefined;
				const el = typeof document !== "undefined" ? document.getElementById(popIdRef.current) : null;
				const anchor = buttonRef.current;
				if (!el || !anchor || typeof el.showPopover !== "function") return undefined;
				let frame = 0;
				const useFrame = typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function";
				const writeBox = () => {
					const rect = anchor.getBoundingClientRect();
					const box = panelBox(rect, {
						width: typeof window !== "undefined" ? window.innerWidth : 0,
						height: typeof window !== "undefined" ? window.innerHeight : 0,
					});
					el.style.left = box.left + "px";
					el.style.top = box.top + "px";
					el.style.maxHeight = box.maxHeight + "px";
				};
				// First placement is synchronous: waiting a frame shows the panel at
				// the browser's default popover position, then jumps it.
				writeBox();
				const place = () => {
					if (frame !== 0) return;
					const schedule = useFrame ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
					frame = schedule(() => {
						frame = 0;
						writeBox();
					});
				};
				try { el.showPopover(); } catch { /* already showing */ }
				const onToggle = (event) => {
					if (event.newState === "closed") setOpen(false);
				};
				el.addEventListener("toggle", onToggle);
				// The pill moves when the window resizes or the transcript scrolls.
				// The text of the panel is not a dependency: rebuilding this effect
				// on every cost tick called hidePopover, and that closed the panel
				// the moment a request finished.
				const onMove = () => place();
				try {
					window.addEventListener("resize", onMove);
					window.addEventListener("scroll", onMove, true);
				} catch { /* non-DOM host */ }
				return () => {
					el.removeEventListener("toggle", onToggle);
					try {
						window.removeEventListener("resize", onMove);
						window.removeEventListener("scroll", onMove, true);
					} catch { /* ignore */ }
					if (frame !== 0) {
						if (useFrame) cancelAnimationFrame(frame);
						else clearTimeout(frame);
						frame = 0;
					}
					try {
						if (typeof el.matches === "function" && el.matches(":popover-open") && typeof el.hidePopover === "function") el.hidePopover();
					} catch { /* already closed */ }
				};
			}, [open]);

			const copyExport = (format) => {
				let text;
				try { text = exportBreakdown(breakdown, format); } catch { return; }
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(text);
					}
				} catch { /* clipboard unavailable: the breakdown is still visible in the panel */ }
			};

			const dotColor = peak
				? "var(--dsw-alias-state-warn-primary)"
				: "var(--dsw-alias-state-success-primary)";

			// Nothing to say yet: an empty button still occupies the composer row.
			if (!showPill) return null;

			// The dialog is a sibling of the button, not a child: a button must not
			// contain another interactive layer, and the popover escapes the dock.
			return h(
				"span",
				{
					style: style.anchor,
					"data-session-meter": showPeriod ? (peak ? "peak" : "off-peak") : "flat",
					"data-breakdown": detailText,
					"data-cache-saved": saved > 0 ? fmtMoney(saved) : undefined,
					"data-burn": burn !== undefined ? fmtMoney(burn) : undefined,
				},
				h(
					"button",
					{
						type: "button",
						ref: buttonRef,
						style: style.button,
						title: open ? undefined : title,
						"aria-expanded": open,
						"aria-controls": open ? popIdRef.current : undefined,
						onPointerDown: (event) => {
							const next = pillGesture(open, swallowClickRef.current, "pointerdown");
							swallowClickRef.current = next.swallowClick;
							if (!next.swallowClick) return;
							// This press is the popover's light-dismiss. Keep it from also
							// arriving as a click that opens the panel again.
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
						},
						onClick: () => {
							const next = pillGesture(open, swallowClickRef.current, "click");
							swallowClickRef.current = next.swallowClick;
							if (next.open === open) return;
							setOpen(next.open);
						},
					},
					h(
						"span",
						{ style: style.pill },
						showPeriod && h("span", { style: { ...style.dot, background: dotColor } }),
						showPeriod && h("span", { style: style.label }, periodLabel),
						soonLabel !== undefined && h("span", { style: style.soon }, soonLabel),
						showPeriod && showCost && tokens > 0 && h("span", { style: style.sep, "aria-hidden": true }, "\u00b7"),
						showCost && h("span", { style: style.label }, costLabel),
						saved > 0 && h("span", { style: style.sep, "aria-hidden": true }, "\u00b7"),
						saved > 0 && h("span", { style: style.label }, textKey(t, "saved") + " " + fmtMoney(saved)),
						showFill && h("span", { style: style.sep, "aria-hidden": true }, "\u00b7"),
						showFill && h(
							"span",
							{
								style: { ...style.label, color: style.fill[fill.band] },
								"data-context-band": fill.band,
							},
							fill.percent + "%",
						),
					),
				),
				open && h(
					"div",
					{
						id: popIdRef.current,
						popover: "auto",
						role: "dialog",
						style: style.panel,
					},
					lines.map((line, index) => h("div", { key: index, style: style.panelLine }, line)),
					h(
						"div",
						{ key: "export", style: style.panelLine },
						h("button", { type: "button", style: style.exportButton, onClick: () => copyExport("csv"), title: "Copy as CSV" }, "CSV"),
						" ",
						h("button", { type: "button", style: style.exportButton, onClick: () => copyExport("json"), title: "Copy as JSON" }, "JSON"),
					),
				),
			);
		}

		/** True when every billable token belongs to a model this table cannot price. */
		function unpricedOnly(breakdown) {
			const priced = breakdown.rows.some((row) => row.priced && totalBilledTokens(row.usage) > 0);
			return !priced && breakdown.unpricedTokens > 0;
		}

		/* ------------------------------------------------------------- wiring */
		function apply(ctx) {
			// `locale` is declared in `inject`, so Cordis waits for it instead of
			// racing the service. The renderer also refuses an entry whose declared
			// namespace has no locale face, so the dependency is real, not optional.
			// The guard below only keeps a host that provides `slots` but not
			// `locale` from crashing: it renders the built-in Chinese table.
			const locale = ctx.locale;
			if (locale && typeof locale.register === "function") {
				ctx.effect(() => locale.register(NS, { zh, en }), "session meter dictionaries");
			}
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "session-meter",
						order: 2,
						locale: NS,
					},
					SessionMeter,
				),
			);
		}

		exports.name = "session-meter";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		// Exposed so tests can exercise the exact shipped pure logic.
		exports.__internals = {
			NS,
			PRICING,
			PEAK,
			en,
			zh,
			textKey,
			localParts,
			isPeakAt,
			nextFlipAt,
			priceOf,
			nameCandidates,
			rateAt,
			live,
			liveRateFor,
			priceQueryBatch,
			requestLivePrices,
			liveSubscribe,
			bucketsOf,
			modelOfRequest,
			costBreakdown,
			breakdownKey,
			inputStamp,
			pinnedInstants,
			requestKey,
			UNKNOWN_PEAK_AT,
			UNKNOWN_OFFPEAK_AT,
			costOf,
			totalBilledTokens,
			fmtMoney,
			fmtTokens,
			nextDelayMs,
			countdownStale,
			pillNeedsClock,
			priceEffectTick,
			panelBox,
			pillGesture,
			fmtSpan,
			modelLine,
			modelLines,
			contextFill,
			cacheSaved,
			burnPerHour,
			unpricedOnly,
			exportBreakdown,
			requestCosts,
			updateDayLedger,
			dayTotal,
			localDateKey,
			SessionMeter,
		};
		return module.exports;
	},
});
