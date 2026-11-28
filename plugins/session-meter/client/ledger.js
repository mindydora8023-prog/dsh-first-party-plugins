/**
 * Daily spend ledger mirrored in memory and persisted best-effort in
 * localStorage with bounded days, sessions, and serialized size.
 *
 * Pure ASCII only.
 */

const LEDGER_STORAGE_KEY = "dsh-session-meter-ledger";
const LEDGER_VERSION = 3;
const LEDGER_MAX_DAYS = 60;
const LEDGER_MAX_SESSIONS = 200;
const LEGACY_OVERFLOW = "__overflow";
// Leave room for the host's own data in the origin's localStorage quota.
const LEDGER_MAX_CHARS = 2_000_000;

/** In-memory mirror avoiding redundant JSON.parse/stringify on idle renders. */
let mirroredLedger = null;
let mirroredRaw = null;

function localDateKey(ms) {
	const date = new Date(Number.isFinite(ms) ? ms : Date.now());
	return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function normalizeLedger(ledger) {
	if (ledger?.days && typeof ledger.days === "object" && !Array.isArray(ledger.days)) {
		if (ledger.version === LEDGER_VERSION) return ledger;
		if (ledger.version === 2) return { version: LEDGER_VERSION, days: ledger.days };
	}
	return { version: LEDGER_VERSION, days: {} };
}

function sameLedgerRecord(before, after) {
	if (before === after) return true;
	if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
	return Object.keys(after).every((key) => before[key] === after[key]);
}

function ledgerCost(record) {
	return Number.isFinite(record) ? record : record?.costCny;
}

function preserveRecordedDates(days, sessionId, datedCosts) {
	const dateByRequest = new Map();
	for (const [date, sessions] of Object.entries(days)) {
		if (!sessions || !Object.hasOwn(sessions, sessionId)) continue;
		for (const id of Object.keys(sessions[sessionId] ?? {})) dateByRequest.set(id, date);
	}
	if (dateByRequest.size === 0) return datedCosts;
	const byDate = new Map();
	for (const [date, costs] of datedCosts) {
		for (const [id, cost] of costs) {
			const recorded = dateByRequest.get(id) ?? date;
			if (!byDate.has(recorded)) byDate.set(recorded, new Map());
			byDate.get(recorded).set(id, cost);
		}
	}
	return byDate;
}

function mergeLedgerSession(previous, costs) {
	const next = { ...previous };
	let changed = false;
	if (Number.isFinite(previous[LEGACY_OVERFLOW])) {
		// V2 collapsed the oldest entries without their IDs. Rehydrate them
		// only when this snapshot's prefix reconciles with the stored amount.
		const snapshot = [...costs];
		const firstKnown = snapshot.findIndex(([id]) => Object.hasOwn(previous, id));
		if (firstKnown < 0) return previous;
		const prefix = snapshot.slice(0, firstKnown).map(([, record]) => ledgerCost(record));
		const total = prefix.reduce((sum, cost) => sum + cost, 0);
		if (prefix.length > 0 && prefix.every(Number.isFinite)
			&& Math.abs(total - previous[LEGACY_OVERFLOW]) < 1e-9) {
			delete next[LEGACY_OVERFLOW];
			changed = true;
		} else {
			costs = snapshot.slice(firstKnown);
		}
	}
	for (const [id, record] of costs) {
		const prior = Object.hasOwn(previous, id) ? previous[id] : undefined;
		if (record?.costCny === null && Number.isFinite(ledgerCost(prior))) continue;
		if (sameLedgerRecord(prior, record)) continue;
		Object.defineProperty(next, id, { value: record, enumerable: true, configurable: true, writable: true });
		changed = true;
	}
	return changed ? next : previous;
}

function limitLedgerSize(ledger) {
	const days = Object.entries(ledger.days).sort(([a], [b]) => a.localeCompare(b));
	let size = JSON.stringify({ ...ledger, days: {} }).length;
	let start = days.length;
	while (start > 0) {
		const nextSize = size + JSON.stringify(days[start - 1]).length;
		if (nextSize > LEDGER_MAX_CHARS) break;
		size = nextSize;
		start -= 1;
	}
	return start === 0 ? ledger : { ...ledger, days: Object.fromEntries(days.slice(start)) };
}

/** Upsert dated estimates by session and request, keeping requests already seen. */
function updateDayLedger(ledger, sessionId, datedCosts) {
	ledger = normalizeLedger(ledger);
	if (typeof sessionId !== "string" || sessionId === "" || !(datedCosts instanceof Map) || datedCosts.size === 0) return ledger;
	const days = { ...ledger.days };
	datedCosts = preserveRecordedDates(days, sessionId, datedCosts);
	const retainedDates = [...new Set([...Object.keys(days), ...datedCosts.keys()])].sort().slice(-LEDGER_MAX_DAYS);
	let changed = false;
	for (const date of retainedDates) {
		const costs = datedCosts.get(date);
		if (costs === undefined) continue;
		const sessions = days[date] ?? {};
		const previous = (Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined) ?? {};
		const nextSession = mergeLedgerSession(previous, costs);
		if (previous === nextSession) continue;
		const merged = { ...sessions, [sessionId]: nextSession };
		const ids = Object.keys(merged);
		for (const id of ids.slice(0, Math.max(0, ids.length - LEDGER_MAX_SESSIONS))) delete merged[id];
		days[date] = merged;
		changed = true;
	}
	if (!changed) return ledger;
	return limitLedgerSize({ version: LEDGER_VERSION, days: Object.fromEntries(retainedDates.map((date) => [date, days[date]])) });
}

/** One day's summed cost from the ledger. */
function dayTotal(ledger, date) {
	const sessions = normalizeLedger(ledger).days[date];
	let total = 0;
	for (const requests of Object.values(sessions ?? {})) {
		for (const record of Object.values(requests ?? {})) {
			const cost = ledgerCost(record);
			if (Number.isFinite(cost)) total += cost;
		}
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
	if (mirroredLedger !== null) return mirroredLedger;
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
