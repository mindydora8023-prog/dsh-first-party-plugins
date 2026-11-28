/**
 * Pure calendar, ledger aggregation, and spend report rendering.
 * Inlined into the browser client so its ledger can stay on the device.
 */
import { LOCALES } from './locales.js';

const REPORT_DAY_MS = 86_400_000;
export const REPORT_FORMATS = Object.freeze({
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
});

function dayMillis(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const ms = Date.parse(key + 'T00:00:00Z');
  return Number.isFinite(ms) && dayKey(ms) === key ? ms : NaN;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function spendRange(options, dates) {
  const { period = 'month', today, month = typeof today === 'string' ? today.slice(0, 7) : '', from, to } = options;
  switch (period) {
    case 'month': {
      const start = dayMillis(month + '-01');
      if (!Number.isFinite(start)) break;
      const next = new Date(start);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return { period, from: dayKey(start), to: dayKey(next.getTime() - REPORT_DAY_MS) };
    }
    case 'last30': {
      const end = dayMillis(today);
      if (!Number.isFinite(end) || end - 29 * REPORT_DAY_MS < dayMillis('0000-01-01')) break;
      return { period, from: dayKey(end - 29 * REPORT_DAY_MS), to: today };
    }
    case 'all':
      return { period, from: dates[0] ?? null, to: dates.at(-1) ?? null };
    case 'custom':
      if (Number.isFinite(dayMillis(from)) && Number.isFinite(dayMillis(to)) && from <= to) return { period, from, to };
      break;
  }
  throw new RangeError('Invalid spend report period or dates');
}

function reportNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function spendCounts() {
  return { requests: 0, pricedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCny: 0, cacheSavedCny: 0 };
}

function addSpendCounts(counts, record) {
  counts.requests += 1;
  counts.inputTokens += reportNumber(record.uncachedInputTokens)
    + reportNumber(record.cacheReadTokens) + reportNumber(record.cacheWriteTokens);
  counts.outputTokens += reportNumber(record.outputTokens);
  counts.cacheReadTokens += reportNumber(record.cacheReadTokens);
  if (Number.isFinite(record.costCny) && record.costCny >= 0) {
    counts.pricedRequests += 1;
    counts.costCny += record.costCny;
    counts.cacheSavedCny += reportNumber(record.cacheSavedCny);
  }
}

function spendRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function ledgerValues(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [];
}

/** Aggregate literal browser-local day keys without reinterpreting them in the caller's TZ. */
export function createSpendReport(ledger, options = {}) {
  const days = ledger?.version === 2 || ledger?.version === 3 ? ledger.days ?? {} : {};
  const dates = Object.keys(days).filter((date) => Number.isFinite(dayMillis(date))).sort();
  const range = spendRange(options, dates);
  const totals = spendCounts();
  const models = new Map();
  const byDay = new Map();
  let legacyCostCny = 0;
  let hasLegacyCosts = false;
  for (const date of dates) {
    if (date < range.from || date > range.to) continue;
    let costCny = 0;
    let recorded = false;
    for (const requests of ledgerValues(days[date])) {
      for (const record of ledgerValues(requests)) {
        if (Number.isFinite(record) && record >= 0) {
          hasLegacyCosts = true;
          legacyCostCny += record;
          costCny += record;
        } else if (record && typeof record === 'object' && typeof record.model === 'string') {
          const provider = typeof record.provider === 'string' ? record.provider : '';
          const key = JSON.stringify([provider, record.model]);
          if (!models.has(key)) models.set(key, { provider, model: record.model, ...spendCounts() });
          addSpendCounts(models.get(key), record);
          addSpendCounts(totals, record);
          costCny += reportNumber(record.costCny);
        } else {
          continue;
        }
        recorded = true;
      }
    }
    if (recorded) byDay.set(date, { date, costCny, recorded });
  }
  const knownCostCny = totals.costCny;
  totals.costCny += legacyCostCny;
  const rows = [...models.values()].map((row) => ({
    ...row,
    cacheHitRate: spendRatio(row.cacheReadTokens, row.inputTokens),
    averageRequestCostCny: spendRatio(row.costCny, row.pricedRequests),
    costShare: spendRatio(row.costCny, totals.costCny),
  })).sort((a, b) => b.costCny - a.costCny || b.requests - a.requests);

  const start = dayMillis(range.from);
  const end = dayMillis(range.to);
  const daily = [];
  if (end - start < 366 * REPORT_DAY_MS) {
    for (let ms = start; ms <= end; ms += REPORT_DAY_MS) {
      const date = dayKey(ms);
      daily.push(byDay.get(date) ?? { date, costCny: 0, recorded: false });
    }
  } else {
    daily.push(...byDay.values());
  }
  return {
    currency: 'CNY', range,
    totals: {
      ...totals, legacyCostCny, hasLegacyCosts,
      cacheSavingsRate: spendRatio(totals.cacheSavedCny, knownCostCny + totals.cacheSavedCny),
    },
    models: rows, daily,
  };
}

export function spendReportFilename(report, format) {
  const { period, from, to } = report.range;
  const suffix = period === 'month' ? from.slice(0, 7) : from === null ? 'all' : from + '_to_' + to;
  return 'session-meter-' + suffix + '.' + format;
}

function reportCsvCell(value) {
  if (value == null) return '';
  let cell = String(value);
  // Spreadsheet applications can execute cells starting with formula markers.
  if (typeof value === 'string' && /^(?:[\t\r\n]|\s*[=+@-])/.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell;
}

function renderSpendCsv(report) {
  const fields = [
    'section', 'from', 'to', 'date', 'provider', 'model', 'requests', 'pricedRequests',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'costCny', 'cacheSavedCny',
    'cacheSavingsRate', 'cacheHitRate', 'averageRequestCostCny', 'costShare', 'legacyCostCny', 'hasLegacyCosts', 'recorded',
  ];
  const { from, to } = report.range;
  const rows = [
    { section: 'total', ...report.totals },
    ...report.models.map((model) => ({ section: 'model', ...model })),
    ...report.daily.map((day) => ({ section: 'day', ...day })),
  ];
  return [fields.join(','), ...rows.map((row) => {
    const values = { from, to, ...row };
    return fields.map((field) => reportCsvCell(values[field])).join(',');
  })].join('\r\n') + '\r\n';
}

function escapeReportHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function spendChart(daily, label, money) {
  const height = 148;
  const step = 16;
  const width = daily.length * step;
  const max = daily.reduce((highest, day) => Math.max(highest, day.costCny), 0);
  const bars = daily.map((day, index) => {
    const barHeight = max > 0 ? day.costCny / max * (height - 2) : 0;
    const x = index * step;
    if (barHeight === 0) return '';
    const tip = escapeReportHtml(day.date + ' ' + money(day.costCny));
    return '<rect x="' + x + '" y="' + (height - barHeight) + '" width="12" height="' + barHeight + '" rx="2"><title>' + tip + '</title></rect>';
  }).join('');
  const first = daily[0].date;
  const middle = daily.length > 2 ? '<time>' + escapeReportHtml(daily[Math.floor(daily.length / 2)].date) + '</time>' : '';
  const last = daily.length > 1 ? '<time>' + escapeReportHtml(daily.at(-1).date) + '</time>' : '';
  return '<figure><div class="axis" aria-hidden="true"><span>' + (max > 0 ? escapeReportHtml(money(max)) : '')
    + '</span><span>' + escapeReportHtml(money(0)) + '</span></div>'
    + '<svg role="img" aria-label="' + escapeReportHtml(label) + '" width="' + width + '" height="' + height
    + '" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' + bars + '</svg>'
    + '<figcaption><time>' + escapeReportHtml(first) + '</time>' + middle + last + '</figcaption></figure>';
}

function renderSpendHtml(report, language) {
  const lang = language === 'zh' ? 'zh' : 'en';
  const l = LOCALES[lang];
  const escape = escapeReportHtml;
  const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'CNY', maximumFractionDigits: 6 }).format;
  const count = new Intl.NumberFormat(lang).format;
  const percent = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format;
  const metric = (format, value) => value === null ? '&mdash;' : escape(format(value));
  const { totals, models, daily, range } = report;
  const rangeText = range.from === null ? '' : escape(range.from + ' \u2013 ' + range.to);
  const headers = [l.reportModel, l.reportCost, l.reportAverage, l.reportShare, l.reportRequests, l.reportInput, l.reportOutput, l.reportCacheHit];
  const modelRows = models.map((row) => {
    const model = escape(row.model || l.unknown);
    const provider = row.provider ? '<small>' + escape(row.provider) + '</small>' : '';
    const requests = row.pricedRequests < row.requests
      ? count(row.pricedRequests) + ' / ' + count(row.requests) : count(row.requests);
    const cells = [
      metric(money, row.pricedRequests > 0 ? row.costCny : null),
      metric(money, row.averageRequestCostCny), metric(percent, row.costShare),
      escape(requests), escape(count(row.inputTokens)), escape(count(row.outputTokens)), metric(percent, row.cacheHitRate),
    ];
    return '<tr><th scope="row">' + model + provider + '</th><td>' + cells.join('</td><td>') + '</td></tr>';
  }).join('');
  const hasDays = daily.some((day) => day.recorded);
  const chart = hasDays ? spendChart(daily, l.reportTrend, money) : '<p>' + escape(l.reportEmpty) + '</p>';
  const dayRows = daily.filter((day) => day.recorded).map((day) => '<tr><th scope="row">' + escape(day.date)
    + '</th><td>' + escape(money(day.costCny)) + '</td></tr>').join('');
  const summary = [
    [l.reportCost, escape(money(totals.costCny))],
    [l.reportSaved, metric(money, totals.pricedRequests > 0 ? totals.cacheSavedCny : null)],
    [l.reportSavingsRate, metric(percent, totals.cacheSavingsRate)],
  ].map(([label, value]) => '<div><dt>' + escape(label) + '</dt><dd>' + value + '</dd></div>').join('');

  return (
    '<!doctype html>\n<html lang="' + lang + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<title>' + escape(l.reportTitle) + '</title><style>\n'
    + ':root{color-scheme:light dark;--bg:#f6f8f7;--surface:#fff;--text:#152522;--muted:#536760;--line:#d5dfda;--accent:#11725c}\n'
    + '@media(prefers-color-scheme:dark){:root{--bg:#101917;--surface:#172422;--text:#edf4f0;--muted:#a7bcb3;--line:#344943;--accent:#62d5b0}}\n'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.5 system-ui,sans-serif}\n'
    + 'main{width:min(72rem,100%);margin:auto;padding:clamp(1rem,4vw,3rem)}header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1rem}\n'
    + 'h1,h2,p,dl,dd,figure{margin:0}h1{font-size:clamp(1.45rem,4vw,2rem)}h2{font-size:1.15rem;margin-bottom:.8rem}p,dt,figcaption,small,header span{color:var(--muted)}\n'
    + 'dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:1rem;padding:1rem 0;border-bottom:1px solid var(--line)}\n'
    + 'dd{font-size:clamp(1.25rem,4vw,2rem);font-weight:670;overflow-wrap:anywhere}dd,td,figcaption{font-variant-numeric:tabular-nums}section{margin-top:1.6rem}\n'
    + 'figure,.table{background:var(--surface);border-radius:.6rem;padding:.75rem 1rem}figure{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:.6rem}\n'
    + 'svg{display:block;width:100%;height:9.25rem;fill:var(--accent);border-bottom:1px solid var(--line)}.axis{display:flex;flex-direction:column;justify-content:space-between;color:var(--muted);font-size:.8rem;text-align:right}\n'
    + 'figcaption{grid-column:2;display:flex;justify-content:space-between;gap:.5rem;margin-top:.4rem;font-size:.85rem}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}\n'
    + 'th,td{padding:.5rem .6rem;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}th:first-child{text-align:left;white-space:normal;min-width:7rem;max-width:20rem;overflow-wrap:anywhere}\n'
    + 'tr:last-child td,tbody tr:last-child th{border-bottom:0}small{display:block;font-weight:400}details,p{margin-top:.6rem}summary{cursor:pointer}\n'
    + '.scroll-note{display:none;margin:0 0 .5rem;font-size:.85rem}@media(max-width:48rem){.scroll-note{display:block}}@media(max-width:30rem){figcaption time:nth-child(2):not(:last-child){display:none}}\n'
    + '</style></head><body><main><header><h1>' + escape(l.reportTitle) + '</h1><span>' + rangeText + '</span></header><dl>'
    + summary + '</dl><section><h2>' + escape(l.reportTrend) + '</h2>' + chart
    + (hasDays ? '<details><summary>' + escape(l.reportDaily) + '</summary><div class="table"><table><thead><tr><th scope="col">'
      + escape(l.reportDate) + '</th><th scope="col">' + escape(l.reportCost) + '</th></tr></thead><tbody>' + dayRows + '</tbody></table></div></details>' : '')
    + '</section><section aria-labelledby="models"><h2 id="models">' + escape(l.reportModels) + '</h2>'
    + (models.length > 0 ? '<p class="scroll-note">' + escape(l.reportScroll)
      + '</p><div class="table" role="region" aria-labelledby="models" tabindex="0"><table><thead><tr><th scope="col">'
      + headers.map(escape).join('</th><th scope="col">') + '</th></tr></thead><tbody>' + modelRows + '</tbody></table></div>' : '<p>' + escape(l.reportNoModelData) + '</p>')
    + (totals.hasLegacyCosts ? '<p>' + escape(l.reportLegacy) + ' ' + escape(money(totals.legacyCostCny)) + '</p>' : '')
    + (totals.pricedRequests < totals.requests ? '<p>' + escape(l.reportUnpriced) + '</p>' : '')
    + '<p>' + escape(l.reportEstimate) + '</p></section></main></body></html>\n'
  );
}

export function serializeSpendReport(report, format, language = 'en') {
  switch (format) {
    case 'json': return JSON.stringify(report, null, 2) + '\n';
    case 'csv': return renderSpendCsv(report);
    case 'html': return renderSpendHtml(report, language);
    default: throw new RangeError('Invalid spend report format');
  }
}
