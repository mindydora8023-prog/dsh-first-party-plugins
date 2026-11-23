/**
 * DeepSeek built-in pricing table, peak/off-peak schedule, and locale lookup
 * for dsh-plugin-session-meter.
 *
 * `CONTEXT_SUFFIX`, `RELEASE_SUFFIX`, and `nameCandidates` are inlined from
 * `lib/model-names.js` so Host and Client never drift. Pure ASCII only.
 */

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
	"deepseek-v4-flash-vision-exp": FLASH_TIER,
	"deepseek-pro": PRO_TIER,
	"deepseek-v4-pro": PRO_TIER,
	"deepseek-v4.1-pro": PRO_TIER,
	"deepseek-v4-pro-0813": PRO_TIER,
};
const FAMILIES = [
	["flash", FLASH_TIER],
	["pro", PRO_TIER],
];
const BARE_FAMILY = /^(?:v\d+(?:\.\d+)*[-_.]?)?(?:flash|pro)(?:[-_.](?:\d{3,6}|preview|latest|free|beta|alpha|experimental))?$/;

/** Dictionary lookup with built-in Chinese fallback. */
function textKey(t, key) {
	if (typeof t === "function") {
		const value = t(key);
		if (typeof value === "string" && value.length > 0 && value !== key) return value;
	}
	return FALLBACK[key];
}

const PEAK = {
	timezoneOffsetMinutes: 480,
	windows: [
		[9 * 60, 12 * 60],
		[14 * 60, 18 * 60],
	],
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
const FLIP_HORIZON_DAYS = 15;

function pad2(value) {
	return value < 10 ? "0" + value : String(value);
}

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
		if (dateKey < span[0]) return false;
		if (dateKey <= span[1]) return true;
	}
	return false;
}

function isWorkday(parts, config) {
	if (parts.weekday === 0 || parts.weekday === 6) return false;
	return !isHoliday(parts.dateKey, config.holidays);
}

function isPeakAt(ms, config) {
	const cfg = config || PEAK;
	if (!Number.isFinite(ms)) return false;
	const parts = localParts(ms, cfg.timezoneOffsetMinutes);
	if (!isWorkday(parts, cfg)) return false;
	return inAnyWindow(parts.minutes, cfg.windows);
}

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

function priceOf(model) {
	if (typeof model !== "string" || model.length === 0) return undefined;
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
