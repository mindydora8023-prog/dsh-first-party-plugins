/**
 * filekit_search: in-document text search with locations.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'
import { searchDocument } from '../lib/search.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

function fakeCtx(baseCwd) {
  return {
    fs: {
      async resolve(requested, opts = {}) {
        const cwd = opts.cwd ?? baseCwd
        const abs = isAbsolute(requested) ? requested : resolve(cwd, requested)
        return { targetKey: abs, displayPath: abs }
      },
      async stat(target) {
        if (!existsSync(target.targetKey)) return undefined
        const s = statSync(target.targetKey)
        if (s.isDirectory()) return { type: 'directory', size: 0, version: 'v' }
        return { type: 'file', size: s.size, version: `v${s.mtimeMs}` }
      },
      async readBytes(target) {
        return readFileSync(target.targetKey)
      },
    },
    emit() {},
  }
}

const baseConfig = readConfig({}, { pluginDir: join(here, '..'), profileDir: '', home: '' })
const ctx = fakeCtx(fixtures)
const searchTool = buildTools(baseConfig, ctx).find((d) => d.name === 'filekit_search')

function run(path, query, args = {}) {
  return searchTool.execute({ path, query, ...args }, { signal: new AbortController().signal })
}

test('filekit_search finds a DOCX paragraph with its location', async () => {
  const out = await run('sample.docx', 'FileKit')
  assert.match(out.text, /para \d+: FileKit Report/)
  assert.ok(out.hits >= 1)
})

test('filekit_search finds an XLSX header row by sheet', async () => {
  const out = await run('sample.xlsx', 'Region')
  assert.match(out.text, /Sales!row 1: Region \| Units/)
})

test('filekit_search finds a PPTX slide title', async () => {
  const out = await run('sample.pptx', 'Quarterly')
  assert.match(out.text, /slide 1: Quarterly review/)
})

test('filekit_search finds PDF page text', async () => {
  const out = await run('sample.pdf', 'page one')
  assert.match(out.text, /p1: FileKit PDF page one/)
})

test('filekit_search is case-insensitive by default and honours the flag', async () => {
  const ci = await run('sample.docx', 'filekit')
  assert.ok(ci.hits >= 1, 'lowercase query matches by default')
  const cs = await run('sample.docx', 'filekit', { ignore_case: false })
  assert.equal(cs.hits, 0)
})

test('filekit_search reports no matches cleanly', async () => {
  const out = await run('sample.docx', 'zzz-not-present')
  assert.match(out.text, /\(no matches\)/)
  assert.equal(out.hits, 0)
})

test('filekit_search rejects a non-document path', async () => {
  await assert.rejects(() => run('sample.csv', 'x'), /supports \.docx, \.xlsx, \.pptx and \.pdf only/)
})

test('filekit_search aligns DOCX matches with block offset, searches PPTX notes, and warns on truncated PDF scan', async () => {
  // DOCX paragraph after a table must report its exact block offset (block 5 in sample.docx).
  const docxHit = await run('sample.docx', 'Paragraph after the table')
  assert.match(docxHit.text, /block \d+ \/ para \d+: Paragraph after the table/)

  // PPTX speaker notes must be searchable.
  const pptxNotes = await run('sample.pptx', 'Remember the bolt count')
  assert.equal(pptxNotes.hits, 1)
  assert.match(pptxNotes.text, /slide 1 notes: Remember the bolt count/)

  // PDF search capped below total pageCount must emit an explicit truncation warning.
  const pdfBuf = readFileSync(join(fixtures, 'sample.pdf'))
  const partialPdf = searchDocument(pdfBuf, 'pdf', 'page', { maxPdfPages: 1 })
  assert.ok(
    partialPdf.warnings.some((w) => /first 1 of 2 pages/.test(w)),
    `expected PDF truncation warning, got: ${JSON.stringify(partialPdf.warnings)}`,
  )

  // Early-stop when match limit is reached (limit=1 stops before scanning all rows).
  const xlsxBuf = readFileSync(join(fixtures, 'sample.xlsx'))
  const all = searchDocument(xlsxBuf, 'xlsx', '0', { limit: 50 })
  const limited = searchDocument(xlsxBuf, 'xlsx', '0', { limit: 1 })
  assert.equal(limited.hits, 1)
  assert.equal(limited.truncated, true)
  assert.ok(limited.scanned < all.scanned, 'early stop should scan fewer units than a full scan')
})
