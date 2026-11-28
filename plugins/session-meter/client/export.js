/**
 * Pure CSV / JSON serializer for session cost breakdowns.
 *
 * Pure ASCII only.
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

function downloadSpendReport(ledger, options, format, language) {
	const report = createSpendReport(ledger, options);
	const content = serializeSpendReport(report, format, language);
	const link = document.createElement("a");
	const href = URL.createObjectURL(new Blob([content], { type: REPORT_FORMATS[format] }));
	try {
		link.href = href;
		link.download = spendReportFilename(report, format);
		document.body.appendChild(link);
		link.click();
	} finally {
		link.remove();
		setTimeout(() => URL.revokeObjectURL(href), 1000);
	}
}
