/**
 * Daily spend ledger mirrored in memory and persisted best-effort in
 * `localStorage` with bounded days, sessions, and per-session request keys.
 *
 * Pure ASCII only.
 */

const LEDGER_STORAGE_KEY = "dsh-session-meter-ledger";
const LEDGER_VERSION = 2;
const LEDGER_MAX_DAYS = 60;
const LEDGER_MAX_SESSIONS = 200;
const LEDGER_MAX_REQUESTS_PER_SESSION = 500;
const LEDGER_OVERFLOW_KEY = "__overflow";

/** In-memory mirror avoiding redundant JSON.parse/stringify on idle renders. */
let mirroredLedger = null;
let mirroredRaw = null;

function localDateKey(ms) {
	const date = new Date(Number.isFinite(ms) ? ms : Date.now());
	return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function normalizeLedger(ledger) {
	if (ledger?.version === LEDGER_VERSION && ledger.days && typeof ledger.days === "object") return ledger;
	return { version: LEDGER_VERSION, days: {} };
}

/**
 * Bound per-session request tracking so a marathon session never bloats
 * `localStorage` unboundedly; evicted request costs are rolled into
 * `__overflow` so `dayTotal` remains exact.
 */
function capSessionRequests(record) {
	const keys = Object.keys(record);
	if (keys.length <= LEDGER_MAX_REQUESTS_PER_SESSION) return record;
	const overflowBase = Number.isFinite(record[LEDGER_OVERFLOW_KEY]) ? record[LEDGER_OVERFLOW_KEY] : 0;
	const regular = keys.filter((k) => k !== LEDGER_OVERFLOW_KEY);
	const keepCount = LEDGER_MAX_REQUESTS_PER_SESSION - 1;
	const dropCount = Math.max(0, regular.length - keepCount);
	let overflow = overflowBase;
	for (let i = 0; i < dropCount; i += 1) {
		const value = record[regular[i]];
		if (Number.isFinite(value)) overflow += value;
	}
	const trimmed = {};
	if (overflow > 0) trimmed[LEDGER_OVERFLOW_KEY] = overflow;
	for (let i = dropCount; i < regular.length; i += 1) {
		trimmed[regular[i]] = record[regular[i]];
	}
	return trimmed;
}

/** Upsert dated estimates by session and request, keeping requests already seen. */
function updateDayLedger(ledger, sessionId, datedCosts) {
	ledger = normalizeLedger(ledger);
	if (typeof sessionId !== "string" || sessionId === "" || !(datedCosts instanceof Map) || datedCosts.size === 0) return ledger;
	const days = { ...ledger.days };
	const retainedDates = [...new Set([...Object.keys(days), ...datedCosts.keys()])].sort().slice(-LEDGER_MAX_DAYS);
	let changed = false;
	for (const date of retainedDates) {
		const costs = datedCosts.get(date);
		if (costs === undefined) continue;
		const sessions = days[date] ?? {};
		const previous = (Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined) ?? {};
		if ([...costs].every(([requestId, cost]) => previous[requestId] === cost)) continue;
		const nextSession = capSessionRequests({ ...previous, ...Object.fromEntries(costs) });
		const merged = { ...sessions, [sessionId]: nextSession };
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
			if (typeof raw === "string" && raw !== "") {
				if (raw === mirroredRaw && mirroredLedger !== null) return mirroredLedger;
				const parsed = normalizeLedger(JSON.parse(raw));
				mirroredRaw = raw;
				mirroredLedger = parsed;
				return parsed;
			}
		}
	} catch { /* storage is best-effort */ }
	if (mirroredLedger !== null && fallback === undefined) return mirroredLedger;
	return normalizeLedger(fallback);
}

function saveLedger(ledger) {
	mirroredLedger = ledger;
	try {
		if (typeof localStorage !== "undefined") {
			const serialized = JSON.stringify(ledger);
			if (serialized === mirroredRaw) return;
			localStorage.setItem(LEDGER_STORAGE_KEY, serialized);
			mirroredRaw = serialized;
		}
	} catch { /* storage full or blocked: the ledger is best-effort */ }
}
