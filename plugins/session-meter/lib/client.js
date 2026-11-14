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
 * Only the client is involved: no Host route, credential, or network call. The
 * source is kept pure ASCII on purpose (workspace convention): user-visible
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
		 * (checked 2026-10-22). Off-peak price is exactly half the peak price.
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
			noPrice: "unpriced",
			peakTip: "Peak window: 09:00-12:00 and 14:00-18:00 Beijing time on weekdays",
			offPeakTip: "Off-peak: every price is half the peak price",
			estimate: "Estimated at official DeepSeek prices, cache discount included",
			estimateCatalog: "Estimated from each model's own official price list",
			byModel: "Per model",
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
			catalogError: "Online price list unavailable:",
			minute: "min",
			hour: "h",
			day: "d",
		};

		/** Chinese copy; kept as \u escapes so this file never carries raw CJK. */
		const zh = {
			peak: "\u9ad8\u5cf0",
			offPeak: "\u4f4e\u8c37",
			spend: "\u672c\u4f1a\u8bdd\u82b1\u8d39",
			noPrice: "\u672a\u5b9a\u4ef7",
			peakTip: "\u9ad8\u5cf0\u65f6\u6bb5 09:00-12:00\u300114:00-18:00\uff08\u5317\u4eac\u65f6\u95f4\uff0c\u5de5\u4f5c\u65e5\uff09",
			offPeakTip: "\u7a7a\u95f2\u4f4e\u8c37\uff0c\u5355\u4ef7\u4e3a\u9ad8\u5cf0\u7684\u4e00\u534a",
			estimate: "\u6309 DeepSeek \u5b98\u65b9\u4ef7\u683c\u4f30\u7b97\uff0c\u542b\u7f13\u5b58\u6298\u6263",
			estimateCatalog: "\u6309\u5404\u6a21\u578b\u5b98\u65b9\u4ef7\u76ee\u8868\u4f30\u7b97",
			byModel: "\u5206\u6a21\u578b",
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
			catalogError: "\u5728\u7ebf\u4ef7\u76ee\u8868\u672a\u53d6\u5230\uff1a",
			minute: "\u5206\u949f",
			hour: "\u5c0f\u65f6",
			day: "\u5929",
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
			// 2026 statutory holidays (same table as peak-guard/lib/holidays.js);
			// an inclusive date range means the whole day stays off-peak.
			holidays: [
				["2026-01-01", "2026-01-03"],
				["2026-02-15", "2026-02-23"],
				["2026-04-04", "2026-04-06"],
				["2026-05-01", "2026-05-05"],
				["2026-06-19", "2026-06-21"],
				["2026-09-25", "2026-09-27"],
				["2026-10-01", "2026-10-07"],
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
			for (const span of holidays) {
				if (dateKey >= span[0] && dateKey <= span[1]) return true;
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
		};

		const ROUTE = "/session-meter/prices";
		/** How long a failed lookup waits before trying again. */
		const LIVE_RETRY_MS = 60000;
		/** Bound one price request; a hung request would leave inFlight stuck. */
		const LIVE_TIMEOUT_MS = 15000;

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
		 * `LIVE_RETRY_MS`, which is what the 30 s tick in the component drives.
		 * @param {string[]} names - routed model ids seen in this session.
		 */
		function requestLivePrices(names) {
			if (typeof fetch !== "function") return;
			const unknown = [];
			for (const name of names) {
				if (typeof name !== "string" || name.length === 0) continue;
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
			const key = unknown.join(",");
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
					for (const name of unknown) {
						live.known.add(name);
						const rate = models[name];
						if (!rate || typeof rate !== "object") continue;
						live.models[name] = {
							input: Number(rate.input),
							output: Number(rate.output),
							cacheRead: Number(rate.cacheRead),
							cacheWrite: Number(rate.cacheWrite),
						};
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
			const lower = model.toLowerCase();
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
		const RELEASE_SUFFIX = /-(preview|latest|free|beta|alpha|experimental)$/;
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
		 * @returns {{cost: number, rows: Array, unpricedTokens: number, remainderTokens: number, pinned: Map}}
		 */
		function costBreakdown(input) {
			const requests = Array.isArray(input.requests) ? input.requests : [];
			const current = input.current && typeof input.current === "object" ? input.current : {};
			const config = input.config || PEAK;
			const now = Number.isFinite(input.now) ? input.now : Date.now();
			const lookup = typeof input.rateAt === "function"
				? input.rateAt
				: (model, at) => rateAt(model, at, config);

			/** Whether the model the composer would use now is period-priced. */
			const currentUsesPeriods = () => {
				const priced = lookup(current.model, now);
				return priced !== undefined && priced.periodPriced === true;
			};

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
				const at = entry.at !== undefined ? entry.at : (previous !== undefined ? previous.at : undefined);
				const own = entry.own || (previous !== undefined && previous.own === true);
				entries.set(key, { provider: entry.provider, model: entry.model, at, own, usage: entry.usage });
			}

			const rows = new Map();
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
			const charge = (entry, estimated) => {
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
			};

			for (const entry of entries.values()) charge(entry, false);
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
				return { cost, rows: [], unpricedTokens, remainderTokens: 0, periodPriced: currentUsesPeriods(), pinned: entries };
			}

			const visibleRows = [...rows.values()].filter((row) => totalBilledTokens(row.usage) > 0);
			return {
				cost,
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

		/** Countdown text: 25 min / 2 h 5 min / 3 d 4 h. */
		function fmtSpan(ms, t) {
			const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
			if (totalMinutes < 60) return totalMinutes + " " + textKey(t, "minute");
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			if (hours < 24) {
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
			sep: {
				color: "var(--dsw-alias-separator-primary)",
				margin: "0 1px",
			},
		};

		/** Tooltip line for one model that produced tokens. */
		function modelLine(row, t) {
			const label = row.model || textKey(t, "unknown");
			const tokens = fmtTokens(totalBilledTokens(row.usage));
			const amount = row.priced ? fmtMoney(row.cost) : textKey(t, "noPrice");
			const marks = (row.reference ? "*" : "") + (row.estimated ? " ~" : "");
			return label + "  " + tokens + " " + textKey(t, "tokensUnit") + "  " + amount + marks;
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
			const requests = useRequestRecords(props.useTrajectory);
			const [now, setNow] = React.useState(() => Date.now());
			const [liveRevision, setLiveRevision] = React.useState(0);

			React.useEffect(() => {
				let timer = null;
				const hidden = () => {
					try { return typeof document !== "undefined" && document.visibilityState === "hidden"; }
					catch { return false; }
				};
				const arm = () => {
					if (timer !== null) return;
					setNow(Date.now());
					timer = setInterval(() => setNow(Date.now()), 30000);
				};
				const disarm = () => {
					if (timer === null) return;
					clearInterval(timer);
					timer = null;
				};
				// The 30s clock only redraws the pill and retries prices. A hidden
				// page has no viewer, so the interval stops until it is visible.
				const sync = () => { if (hidden()) disarm(); else arm(); };
				try { document.addEventListener("visibilitychange", sync); } catch { /* non-DOM host */ }
				sync();
				return () => {
					disarm();
					try { document.removeEventListener("visibilitychange", sync); } catch { /* ignore */ }
				};
			}, []);

			React.useEffect(() => liveSubscribe(() => setLiveRevision((value) => value + 1)), []);

			const peak = isPeakAt(now);
			const model = selection && selection.next ? selection.next.model : undefined;
			const provider = selection && selection.next ? selection.next.provider : undefined;
			const current = rateAt(model, now);
			const rate = current ? current.rate : undefined;
			// The retention ledger survives window rewrites within this mount; a
			// remount (session switch, page reload) re-derives from what loads.
			const pinnedRef = React.useRef(null);
			if (pinnedRef.current === null) pinnedRef.current = new Map();
			const breakdown = costBreakdown({
				requests,
				totals: usage,
				current: { provider, model },
				now,
				pinned: pinnedRef.current,
			});
			pinnedRef.current = breakdown.pinned;
			const tokens = totalBilledTokens(usage);
			const flip = nextFlipAt(now);

			// Ask the Host for prices of every model this session touched. The 30 s
			// clock is a dependency on purpose: a failed lookup must be retried, and
			// nothing else would wake this component once the page settles.
			const tick = Math.floor(now / 30000);
			const asked = [model, ...breakdown.rows.map((row) => row.model)].filter(Boolean).join(",");
			React.useEffect(() => {
				requestLivePrices(asked.split(","));
			}, [asked, liveRevision, tick]);

			// The period marker follows the models: it only means something when a
			// model in play is billed by the official peak/off-peak table. A session
			// running on flat-priced models has no period to report, so the pill
			// shows the cost alone instead of a label that would never change.
			const showPeriod = breakdown.periodPriced === true;
			const periodLabel = showPeriod ? textKey(t, peak ? "peak" : "offPeak") : undefined;
			const costLabel = tokens > 0 && unpricedOnly(breakdown) ? textKey(t, "noPrice") : fmtMoney(breakdown.cost);

			const parts = [];
			if (showPeriod) parts.push(textKey(t, peak ? "peakTip" : "offPeakTip"));
			parts.push(textKey(t, showPeriod ? "estimate" : "estimateCatalog"));
			if (showPeriod && flip !== undefined) parts.push(textKey(t, "nextChange") + " " + fmtSpan(flip - now, t));
			if (rate) {
				const mark = current && current.reference ? "*" : "";
				parts.push(
					textKey(t, "model") + " " + (model || textKey(t, "unknown")) + mark
					+ " " + textKey(t, "input") + " \u00a5" + rate.input
					+ " \u00b7 " + textKey(t, "output") + " \u00a5" + rate.output
					+ " \u00b7 " + textKey(t, "cacheRead") + " \u00a5" + rate.cacheRead
					+ " " + textKey(t, "perMillion"),
				);
			} else if (model) {
				parts.push(textKey(t, "model") + " " + model);
			}
			if (tokens > 0) parts.push(textKey(t, "tokens") + " " + fmtTokens(tokens));
			// Always name the model(s) the log actually recorded, so a relay route
			// reads back exactly as it was called. One row plus the rate line above
			// is honest even when the selector has moved on since.
			if (breakdown.rows.length > 0) {
				parts.push(textKey(t, "byModel") + ":\n" + breakdown.rows.map((row) => modelLine(row, t)).join("\n"));
				if (breakdown.rows.some((row) => row.reference)) parts.push(textKey(t, "referenceNote"));
			}
			// Say why a model stayed unpriced instead of leaving a silent dash.
			if (live.lastError !== undefined && breakdown.rows.some((row) => !row.priced)) {
				parts.push(textKey(t, "catalogError") + " " + live.lastError);
			}
			const title = parts.join(" \u00b7 ");

			const dotColor = peak
				? "var(--dsw-alias-state-warn-primary)"
				: "var(--dsw-alias-state-success-primary)";

			return h(
				"span",
				{
					style: style.anchor,
					title,
					"data-session-meter": showPeriod ? (peak ? "peak" : "off-peak") : "flat",
				},
				h(
					"span",
					{ style: style.pill },
					showPeriod && h("span", { style: { ...style.dot, background: dotColor } }),
					showPeriod && h("span", { style: style.label }, periodLabel),
					showPeriod && h("span", { style: style.sep, "aria-hidden": true }, "\u00b7"),
					h("span", { style: style.label }, textKey(t, "spend") + " " + costLabel),
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
			requestLivePrices,
			liveSubscribe,
			bucketsOf,
			modelOfRequest,
			costBreakdown,
			pinnedInstants,
			requestKey,
			UNKNOWN_PEAK_AT,
			UNKNOWN_OFFPEAK_AT,
			costOf,
			totalBilledTokens,
			fmtMoney,
			fmtTokens,
			fmtSpan,
			modelLine,
			unpricedOnly,
			SessionMeter,
		};
		return module.exports;
	},
});
