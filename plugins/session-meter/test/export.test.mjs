/**
 * exportBreakdown: CSV/JSON serialization of a cost breakdown (pure).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpendReport } from '../lib/report.js'

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  memo: (fn) => fn,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
}

let captured
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition } },
}
await import('../lib/client.js')
const plugin = captured.factory((name) => {
  if (name === 'react') return REACT_STUB
  throw new Error('unexpected require: ' + name)
})
const I = plugin.__internals

function sample() {
  return {
    cost: 1.5,
    unpricedTokens: 0,
    remainderTokens: 0,
    rows: [
      { model: 'deepseek-flash', priced: true, cost: 1.5, reference: false, estimated: false, usage: { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0 } },
    ],
  }
}

test('exportBreakdown csv emits a header and one row per model', () => {
  const csv = I.exportBreakdown(sample(), 'csv')
  const lines = csv.split('\n')
  assert.match(lines[0], /^model,priced,uncachedInputTokens/)
  assert.match(lines[1], /^deepseek-flash,true,1000,500,200,0,/)
  assert.match(lines[1], /,1\.5,false,false$/)
})

test('exportBreakdown csv quotes a model name that contains a comma', () => {
  const breakdown = sample()
  breakdown.rows[0].model = 'relay/a,b'
  const csv = I.exportBreakdown(breakdown, 'csv')
  assert.match(csv, /"relay\/a,b"/)
})

test('exportBreakdown json is valid and marks unpriced rows', () => {
  const breakdown = {
    cost: 0,
    unpricedTokens: 300,
    remainderTokens: 0,
    rows: [{ model: 'llama-pro', priced: false, cost: undefined, usage: { uncachedInputTokens: 300, outputTokens: 10 } }],
  }
  const parsed = JSON.parse(I.exportBreakdown(breakdown, 'json'))
  assert.equal(parsed.unpricedTokens, 300)
  assert.equal(parsed.rows[0].model, 'llama-pro')
  assert.equal(parsed.rows[0].priced, false)
  assert.equal(parsed.rows[0].costCny, null)
  assert.equal(parsed.rows[0].billedTokens, 310)
})

test('exportBreakdown handles an empty breakdown', () => {
  assert.equal(I.exportBreakdown({ rows: [] }, 'csv').split('\n').length, 1)
  const parsed = JSON.parse(I.exportBreakdown({ rows: [] }, 'json'))
  assert.deepEqual(parsed.rows, [])
})

const FLAT_RATE = () => ({ rate: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } })

test('requestCosts prices each request at the supplied rate', () => {
  const requests = [
    { turn: 1, step: 1, startedAt: 1000, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    { turn: 2, step: 1, startedAt: 2000, usage: { inputTokens: 0, outputTokens: 1_000_000 } },
  ]
  const rows = I.requestCosts(requests, { rateAt: FLAT_RATE })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].cost, 1) // 1M input * 1 CNY/M
  assert.equal(rows[1].cost, 2) // 1M output * 2 CNY/M
  assert.equal(rows[0].priced, true)
})

test('requestCosts skips empty usage and flags unpriced', () => {
  const requests = [
    { turn: 1, usage: { inputTokens: 0 } },
    { turn: 2, usage: { inputTokens: 500000 } },
  ]
  const unpriced = I.requestCosts(requests, { rateAt: () => undefined })
  assert.equal(unpriced.length, 1, 'empty usage is skipped')
  assert.equal(unpriced[0].priced, false)
  assert.equal(unpriced[0].cost, 0)
  assert.equal(unpriced[0].tokens, 500000)
})

test('localDateKey yields a stable YYYY-MM-DD', () => {
  const ms = new Date(2026, 10, 22, 12).getTime()
  const key = I.localDateKey(ms)
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(I.localDateKey(ms), key, 'same instant, same key')
  assert.equal(key, '2026-11-22')
})

function inputRequest(turn, startedAt, inputTokens) {
  return { turn, step: 1, startedAt, usage: { inputTokens } }
}

test('today only includes requests dated on the current side of local midnight', () => {
  const before = new Date(2026, 10, 22, 23, 59).getTime()
  const after = new Date(2026, 10, 23, 0, 1).getTime()
  const yesterdayRequest = inputRequest(1, before, 1_000_000)
  const dates = I.costBreakdown({ requests: [yesterdayRequest], now: after, rateAt: FLAT_RATE }).datedCosts
  let ledger = I.updateDayLedger(undefined, 'a', dates)
  assert.equal(I.dayTotal(ledger, '2026-11-22'), 1)
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 0, 'the old session cost stays on its original day')

  const breakdown = I.costBreakdown({
    requests: [yesterdayRequest, inputRequest(2, after, 2_000_000), inputRequest(3, undefined, 3_000_000)],
    totals: { uncachedInputTokens: 10_000_000 },
    now: after,
    rateAt: FLAT_RATE,
  })
  assert.equal(breakdown.cost, 10)
  ledger = I.updateDayLedger(ledger, 'a', breakdown.datedCosts)
  assert.equal(I.dayTotal(ledger, '2026-11-22'), 1)
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 2, 'undated and projection-only costs stay out of the day total')
  assert.equal(I.updateDayLedger(ledger, 'a', breakdown.datedCosts), ledger, 'a repeated update changes nothing')
})

test('day ledger merges sessions and keeps already seen requests after a partial reload', () => {
  const after = new Date(2026, 10, 23, 0, 1).getTime()
  const dates = (requests) => I.costBreakdown({ requests, rateAt: FLAT_RATE }).datedCosts
  let ledger = I.updateDayLedger(undefined, 'a', dates([inputRequest(1, after, 1_000_000), inputRequest(2, after, 2_000_000)]))
  ledger = I.updateDayLedger(ledger, 'b', dates([inputRequest(1, after, 3_000_000)]))
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 6)
  ledger = JSON.parse(JSON.stringify(ledger))
  ledger = I.updateDayLedger(ledger, 'a', dates([inputRequest(2, after, 4_000_000)]))
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 8, 'keeps request 1 and replaces request 2 after reload')
  assert.equal(I.updateDayLedger(ledger, undefined, dates([inputRequest(3, after, 1_000_000)])), ledger)
})

test('a retained request keeps its confirmed day when a rewritten record drops its timestamp', () => {
  const before = new Date(2026, 10, 22, 23, 59).getTime()
  const after = new Date(2026, 10, 23, 0, 1).getTime()
  const original = I.costBreakdown({ requests: [inputRequest(2, before, 1_000_000)], rateAt: FLAT_RATE })
  const rewritten = I.costBreakdown({
    requests: [inputRequest(2, undefined, 1_000_000), inputRequest(3, after, 2_000_000)],
    pinned: original.pinned,
    rateAt: FLAT_RATE,
  })
  const ledger = I.updateDayLedger(undefined, 'a', rewritten.datedCosts)
  assert.equal(I.dayTotal(ledger, '2026-11-22'), 1)
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 2)
})

test('updateDayLedger keeps at most 60 dates', () => {
  const dates = new Map()
  for (let day = 1; day <= 61; day += 1) {
    dates.set(I.localDateKey(new Date(2026, 0, day, 12).getTime()), new Map([['request', 1]]))
  }
  const ledger = I.updateDayLedger(undefined, 'session', dates)
  assert.equal(Object.keys(ledger.days).length, 60)
  assert.equal(I.dayTotal(ledger, '2026-01-01'), 0)
})

test('dayTotal ignores the undated lifetime sums in legacy storage', () => {
  const legacy = { days: { '2026-11-23': { total: 1000, sessions: { a: 1000 } } } }
  assert.equal(I.dayTotal(legacy, '2026-11-23'), 0)
  const ledger = I.updateDayLedger(legacy, 'a', new Map([['2026-11-23', new Map([['x', 1]])]]))
  assert.equal(I.dayTotal(ledger, '2026-11-23'), 1)
})

test('replaying a long trajectory keeps the rolled-up cost exact', () => {
  const day = '2026-11-23'
  const entries = new Map()
  for (let i = 0; i < 650; i += 1) {
    entries.set(`req-${i}`, 0.01)
  }
  const dated = new Map([[day, entries]])
  const ledger = I.updateDayLedger(undefined, 'long-session', dated)
  assert.equal(I.updateDayLedger(ledger, 'long-session', dated), ledger)
  assert.ok(Math.abs(I.dayTotal(ledger, day) - 6.5) < 1e-9)
})

test('a v2 overflow keeps its cost and can be replaced by a matching full replay', () => {
  const day = '2026-11-23'
  const ledger = { version: 2, days: { [day]: { session: { __overflow: 1, latest: 2 } } } }
  const partial = new Map([[day, new Map([['old', 0.5], ['latest', 2]])]])
  assert.equal(I.dayTotal(I.updateDayLedger(ledger, 'session', partial), day), 3)
  const full = new Map([[day, new Map([['earliest', 0.5], ['old', 0.5], ['latest', 2]])]])
  const updated = I.updateDayLedger(ledger, 'session', full)
  assert.equal(updated.version, 3)
  assert.equal(I.dayTotal(updated, day), 3)
  assert.deepEqual(Object.keys(updated.days[day].session), ['latest', 'earliest', 'old'])
  assert.equal(I.updateDayLedger(updated, 'session', full), updated)
})

test('month-end snapshots follow browser local time and keep the originally recorded date', (t) => {
  const oldZone = process.env.TZ
  t.after(() => {
    if (oldZone === undefined) delete process.env.TZ
    else process.env.TZ = oldZone
  })
  const at = Date.parse('2026-11-30T16:01:00Z')
  const priced = (inputTokens) => I.costBreakdown({
    requests: [inputRequest(1, at, inputTokens)], rateAt: FLAT_RATE,
  }).datedCosts

  process.env.TZ = 'UTC'
  const first = I.updateDayLedger(undefined, 'session', priced(1_000_000))
  assert.equal(I.localDateKey(at), '2026-11-30')
  process.env.TZ = 'Asia/Shanghai'
  const shanghai = I.updateDayLedger(undefined, 'session', priced(1_000_000))
  assert.equal(I.localDateKey(at), '2026-12-01')
  assert.equal(createSpendReport(shanghai, { month: '2026-12' }).totals.costCny, 1)
  assert.equal(createSpendReport(first, { month: '2026-11' }).totals.costCny, 1)
  const reloaded = I.updateDayLedger(JSON.parse(JSON.stringify(first)), 'session', priced(2_000_000))
  assert.equal(createSpendReport(reloaded, { month: '2026-11' }).totals.costCny, 2)
  assert.equal(createSpendReport(reloaded, { month: '2026-12' }).totals.costCny, 0)
})

test('the shipped report buttons download HTML, JSON and CSV for the local month', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 23, 12) })
  const downloaded = []
  const blobs = []
  const revoked = []
  t.mock.method(URL, 'createObjectURL', (blob) => {
    blobs.push(blob)
    return 'blob:fixture/' + blobs.length
  })
  t.mock.method(URL, 'revokeObjectURL', (href) => revoked.push(href))
  const previousDocument = globalThis.document
  globalThis.document = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'a')
      return {
        click() { downloaded.push({ filename: this.download, href: this.href }) },
        remove() {},
      }
    },
  }
  t.after(() => { globalThis.document = previousDocument })
  const ledger = { version: 2, days: { '2026-11-23': { session: { request: 1.5 } } } }
  const controls = I.SpendReportControls({ t: (key) => I.en[key], ledger })
  for (const child of controls.children.flatMap((node) => node.children ?? [])) {
    if (child.type === 'button') child.props.onClick()
  }
  assert.deepEqual(downloaded.map((file) => file.filename), [
    'session-meter-2026-11.html', 'session-meter-2026-11.json', 'session-meter-2026-11.csv',
  ])
  assert.match(await blobs[0].text(), /<svg/)
  assert.equal(JSON.parse(await blobs[1].text()).totals.costCny, 1.5)
  assert.match(await blobs[2].text(), /total,2026-11-01,2026-11-30,/)
  t.mock.timers.tick(1000)
  assert.deepEqual(revoked, downloaded.map((file) => file.href))
})
