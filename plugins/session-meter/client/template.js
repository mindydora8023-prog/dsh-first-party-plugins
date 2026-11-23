/**
 * dsh-plugin-session-meter -- browser half.
 *
 * Built by `node ../tools/build-client.mjs session-meter` from `client/bundle.json`.
 * Do not edit `lib/client.js` by hand; edit the modular sources under `client/`
 * and `lib/`. Pure ASCII only.
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

		/*__LOCALES__*/

		const en = LOCALES.en;
		const zh = LOCALES.zh;
		const FALLBACK = zh;

		/*__MODEL_NAMES__*/

		/*__PRICING__*/

		/*__LIVE_PRICES__*/

		/*__COST__*/

		/*__LEDGER__*/

		/*__EXPORT__*/

		/*__UI__*/

		/* ------------------------------------------------------------- wiring */
		function apply(ctx) {
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
