/**
 * Composer dock pill and breakdown popover UI for dsh-plugin-session-meter.
 *
 * Pure ASCII only.
 */

function pillGesture(open, swallowClick, phase) {
	if (phase === "pointerdown") {
		if (!open) return { open: false, swallowClick: false };
		return { open: false, swallowClick: true };
	}
	if (swallowClick) return { open: false, swallowClick: false };
	return { open: !open, swallowClick: false };
}

let breakdownSerial = 0;
function nextBreakdownId() {
	breakdownSerial += 1;
	return breakdownSerial;
}

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
	reportControls: {
		display: "flex",
		flexWrap: "wrap",
		gap: "4px 8px",
		marginTop: "4px",
	},
	reportInput: {
		border: "1px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "inherit",
		font: "inherit",
	},
};

function SpendReportControls({ t, ledger }) {
	const [period, setPeriod] = React.useState("month");
	const [month, setMonth] = React.useState("");
	const [from, setFrom] = React.useState("");
	const [to, setTo] = React.useState("");
	const [error, setError] = React.useState(false);
	const tReport = (key) => textKey(t, key);
	const today = localDateKey(Date.now());
	const selectedMonth = month || today.slice(0, 7);
	const download = (format) => {
		try {
			downloadSpendReport(loadLedger(ledger), { period, today, month: selectedMonth, from, to }, format, tReport("reportLanguage"));
			setError(false);
		} catch {
			setError(true);
		}
	};
	const dateField = (type, label, value, onChange) => h("input", {
		type, value, style: style.reportInput, "aria-label": tReport(label), onChange: (event) => onChange(event.target.value),
	});

	return h("div", { style: style.panelLine },
		h("strong", null, tReport("reportTitle")),
		h("div", { style: style.reportControls },
			h("select", {
				value: period, style: style.reportInput, "aria-label": tReport("reportPeriod"),
				onChange: (event) => { setPeriod(event.target.value); setError(false); },
			},
			h("option", { value: "month" }, tReport("reportMonth")),
			h("option", { value: "last30" }, tReport("reportLast30")),
			h("option", { value: "all" }, tReport("reportAll")),
			h("option", { value: "custom" }, tReport("reportCustom"))),
			period === "month" && dateField("month", "reportMonth", selectedMonth, setMonth),
			period === "custom" && dateField("date", "reportFrom", from, setFrom),
			period === "custom" && dateField("date", "reportTo", to, setTo),
		),
		h("div", { style: style.reportControls },
			["html", "json", "csv"].map((format) => h("button", {
				key: format, type: "button", style: style.exportButton, onClick: () => download(format),
				"aria-label": tReport("reportTitle") + " (" + format.toUpperCase() + ")",
			}, format.toUpperCase())),
		),
		error && h("span", { role: "alert" }, tReport("reportError")),
	);
}

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

function modelLine(row, t) {
	return modelLines(row, t).join("  ");
}

const EMPTY_TRAJECTORY = Object.freeze({ requests: Object.freeze([]) });
function useEmptyTrajectory(selector) {
	return selector(EMPTY_TRAJECTORY);
}

function useEmptyProjection() {
	return undefined;
}

function useRequestRecords(useTrajectory) {
	const reader = typeof useTrajectory === "function" ? useTrajectory : useEmptyTrajectory;
	return reader((snapshot) => snapshot.requests);
}

const BALANCE_FETCH_TIMEOUT_MS = 8000;

/** The pill: current peak/off-peak state + this session's estimated cost. */
function SessionMeter(props) {
	const t = props.t;
	const readProjection = typeof props.useProjection === "function" ? props.useProjection : useEmptyProjection;
	const usage = readProjection("tokenUsage");
	const selection = readProjection("modelSelection");
	const pressure = readProjection("contextPressure");
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
	const needsClockRef = React.useRef(false);
	const clockTimerRef = React.useRef(null);
	const popIdRef = React.useRef("");
	if (popIdRef.current === "") popIdRef.current = "session-meter-breakdown-" + nextBreakdownId();

	React.useEffect(() => liveSubscribe(() => setLiveRevision((value) => value + 1)), []);

	// Account balance: fetched only when the panel opens, with same-origin
	// credentials and a hard timeout so a stalled host never hangs.
	React.useEffect(() => {
		if (!open) {
			setBalance(null);
			return undefined;
		}
		let alive = true;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS);
		try {
			if (typeof fetch === "function") {
				fetch("/session-meter/balance", {
					credentials: "same-origin",
					signal: controller.signal,
					headers: { accept: "application/json" },
				})
					.then((response) => (response && response.ok ? response.json() : null))
					.then((value) => { if (alive && value && value.ok === true) setBalance(value); })
					.catch(() => {})
					.finally(() => clearTimeout(timeout));
			} else {
				clearTimeout(timeout);
			}
		} catch {
			clearTimeout(timeout);
		}
		return () => {
			alive = false;
			clearTimeout(timeout);
			controller.abort();
		};
	}, [open]);

	const peak = isPeakAt(now);
	const model = selection && selection.next ? selection.next.model : undefined;
	const provider = selection && selection.next ? selection.next.provider : undefined;
	const current = rateAt(model, now);
	const rate = current ? current.rate : undefined;

	const pinnedRef = React.useRef(null);
	const memoRef = React.useRef(null);
	if (pinnedRef.current === null || memoRef.current?.sessionId !== props.sessionId) {
		pinnedRef.current = new Map();
		memoRef.current = null;
	}

	// O(1) fast-path: skip the O(N) `inputStamp` walk when the requests array
	// reference, length, tail record/usage, totals, model, and live generation
	// are all unchanged since the previous render (e.g. minute countdown ticks).
	const previousMemo = memoRef.current;
	const reqList = Array.isArray(requests) ? requests : [];
	const reqLen = reqList.length;
	const tailReq = reqLen > 0 ? reqList[reqLen - 1] : undefined;
	const tailUsage = tailReq && typeof tailReq === "object" ? tailReq.usage : undefined;
	const tailUsageStamp = mixUsage(0, tailUsage);
	const totalsStamp = mixUsage(0, usage);
	const fastHit = previousMemo !== null
		&& previousMemo.requests === requests
		&& previousMemo.requestsLen === reqLen
		&& previousMemo.tailReq === tailReq
		&& previousMemo.tailUsage === tailUsage
		&& previousMemo.tailUsageStamp === tailUsageStamp
		&& previousMemo.totals === usage
		&& previousMemo.totalsStamp === totalsStamp
		&& previousMemo.model === model
		&& previousMemo.provider === provider
		&& previousMemo.generation === live.generation
		&& previousMemo.pinned === pinnedRef.current;
	const stamp = fastHit ? previousMemo.stamp : inputStamp(requests, usage);

	const breakdownInput = {
		requests,
		totals: usage,
		current: { provider, model },
		now,
		pinned: pinnedRef.current,
		_memo: previousMemo,
		_liveGeneration: live.generation,
		_stamp: stamp,
	};
	const breakdown = costBreakdown(breakdownInput);
	memoRef.current = {
		sessionId: props.sessionId,
		requests,
		requestsLen: reqLen,
		tailReq,
		tailUsage,
		tailUsageStamp,
		totals: usage,
		totalsStamp,
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

	// Merge into the mirrored day ledger and persist only when totals actually changed.
	React.useEffect(() => {
		const stored = loadLedger(ledger);
		const updated = updateDayLedger(stored, props.sessionId, breakdown.datedCosts);
		if (updated !== stored) saveLedger(updated);
		if (updated !== ledger) setLedger(updated);
	}, [breakdown.datedCosts, open, props.sessionId]);

	const tokens = totalBilledTokens(usage);
	const flip = nextFlipAt(now);
	const fill = contextFill(pressure);
	// Pinned-rate cache savings computed inside costBreakdown so crossing 09:00/18:00
	// never double-jumps historical savings.
	const saved = Number.isFinite(breakdown.cacheSaved)
		? breakdown.cacheSaved
		: cacheSaved(breakdown.rows, (m, at) => rateAt(m, at), now);
	const hasUnpricedUsage = breakdown.unpricedTokens > 0;
	const allUnpriced = hasUnpricedUsage && unpricedOnly(breakdown);
	const burn = hasUnpricedUsage ? undefined : burnPerHour(breakdown.cost, breakdown.pinned, now);
	const showFill = fill !== undefined && (fill.band === "mid" || fill.band === "high");

	const asked = [model, ...breakdown.rows.map((row) => row.model)].filter(Boolean).join(",");
	const priceTick = priceEffectTick(now, live.lastError);
	React.useEffect(() => {
		requestLivePrices(asked.split(","));
	}, [asked, liveRevision, priceTick]);

	const showPeriod = breakdown.periodPriced === true;
	const periodLabel = showPeriod ? textKey(t, peak ? "peak" : "offPeak") : undefined;
	const costKey = hasUnpricedUsage && !allUnpriced ? "pricedSubtotal" : "spend";
	const costLabel = textKey(t, costKey) + " " + (allUnpriced ? textKey(t, "noPrice") : fmtMoney(breakdown.cost));
	const showCost = tokens > 0;
	const showPill = showPeriod || showCost || Object.keys(ledger.days).length > 0;
	const soon = showPeriod && flip !== undefined && flip - now <= 60 * MINUTE_MS;
	const soonLabel = soon ? fmtSpan(flip - now, t) : undefined;
	countdownRef.current = soon;
	periodRef.current = showPeriod;
	const needsClock = pillNeedsClock(showPill, live.lastError !== undefined);
	needsClockRef.current = needsClock;
	const clockStale = countdownStale(now, Date.now(), soon);

	// Keep the `visibilitychange` listener stable (outside `[now]` deps) so
	// minute ticks never churn DOM event listeners.
	React.useEffect(() => {
		const hidden = () => {
			try { return typeof document !== "undefined" && document.visibilityState === "hidden"; }
			catch { return false; }
		};
		const onVisible = () => {
			if (hidden()) {
				if (clockTimerRef.current !== null) {
					clearTimeout(clockTimerRef.current);
					clockTimerRef.current = null;
				}
				return;
			}
			if (needsClockRef.current) setNow(Date.now());
		};
		try { document.addEventListener("visibilitychange", onVisible); } catch { /* non-DOM host */ }
		return () => {
			try { document.removeEventListener("visibilitychange", onVisible); } catch { /* ignore */ }
		};
	}, []);

	// Schedule the next redraw timer (flip, retry, or clamped local midnight).
	React.useEffect(() => {
		if (clockStale) {
			setNow(Date.now());
			return undefined;
		}
		if (!needsClock) return undefined;
		let stopped = false;
		const hidden = () => {
			try { return typeof document !== "undefined" && document.visibilityState === "hidden"; }
			catch { return false; }
		};
		const clear = () => {
			if (clockTimerRef.current === null) return;
			clearTimeout(clockTimerRef.current);
			clockTimerRef.current = null;
		};
		if (!hidden()) {
			const nowMs = Date.now();
			const wait = nextDelayMs(nowMs, {
				flipAt: nextFlipAt(nowMs),
				period: periodRef.current,
				countdown: countdownRef.current,
				retryAt: live.retryAt,
				retryDue: live.lastError !== undefined && nowMs >= live.retryAt,
			});
			const midnight = new Date(nowMs);
			const midnightWait = Math.max(250, midnight.setHours(24, 0, 0, 0) - nowMs);
			const delay = open ? Math.min(wait, midnightWait) : wait;
			clockTimerRef.current = setTimeout(() => {
				clockTimerRef.current = null;
				if (!stopped) setNow(Date.now());
			}, delay);
		}
		return () => {
			stopped = true;
			clear();
		};
	}, [now, liveRevision, showPeriod, soon, clockStale, needsClock, open]);

	const summary = [];
	if (showPeriod) summary.push(textKey(t, peak ? "peakTip" : "offPeakTip"));
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
	if (live.lastError !== undefined && breakdown.rows.some((row) => !row.priced)) {
		summary.push(textKey(t, "catalogError") + " " + live.lastError);
	}

	// Per-model detail stays cached across clock ticks; per-request costs are
	// computed lazily ONLY when the breakdown panel is open.
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
		}
		detailText = detail.join("\n");
	}
	memoRef.current.detailText = detailText;
	memoRef.current.localeTag = localeTag;

	const titleParts = detailText.length > 0 ? summary.concat(textKey(t, "details")) : summary;
	const title = titleParts.join(" \u00b7 ");

	const lines = [];
	if (open) {
		const parts = [summary.join("\n")];
		if (detailText.length > 0) parts.push(detailText);
		if (breakdown.rows.length > 0) {
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
				parts.push(textKey(t, "byRequest") + ":\n" + reqLines.join("\n"));
			}
		}
		const chunks = parts.join("\n").split("\n");
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
				Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {});
			}
		} catch { /* clipboard unavailable: the breakdown is still visible in the panel */ }
	};

	const dotColor = peak
		? "var(--dsw-alias-state-warn-primary)"
		: "var(--dsw-alias-state-success-primary)";

	if (!showPill) return null;

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
				!showPeriod && !showCost && h("span", { style: style.label }, textKey(t, "reportTitle")),
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
			h(SpendReportControls, { t, ledger }),
		),
	);
}
