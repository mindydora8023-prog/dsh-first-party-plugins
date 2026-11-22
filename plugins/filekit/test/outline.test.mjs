/**
 * filekit_outline: structure listing without reading the body.
 *
 * Uses the real fixtures under test/fixtures (a python-docx document, a
 * python-openpyxl workbook, a python-pptx deck and the generated PDF) through
 * the same ctx.fs shim the e2e suite uses, so the whole pipeline is exercised.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'
import { buildOutline } from '../lib/outline.js'

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
const outlineTool = buildTools(baseConfig, ctx).find((d) => d.name === 'filekit_outline')

function run(path, args = {}) {
  return outlineTool.execute({ path, ...args }, { signal: new AbortController().signal })
}

test('filekit_outline lists DOCX headings', async () => {
  const out = await run('sample.docx')
  assert.match(out.text, /<type>outline:docx<\/type>/)
  assert.match(out.text, /FileKit Report/)
  assert.match(out.text, /\(outline: \d+ entries\)/)
  assert.ok(out.entryCount >= 1)
})

test('filekit_outline lists XLSX sheets with their header row', async () => {
  const out = await run('sample.xlsx')
  assert.match(out.text, /## Sales/)
  assert.match(out.text, /Region \| Units \| Revenue \| Note/)
  assert.ok(out.totalEntries >= 2)
})

test('filekit_outline lists PPTX slide titles', async () => {
  const out = await run('sample.pptx')
  assert.match(out.text, /1\. Quarterly review/)
  assert.match(out.text, /2\. Second slide/)
})

test('filekit_outline lists PDF pages with their first line', async () => {
  const out = await run('sample.pdf')
  assert.match(out.text, /p1: FileKit PDF page one/)
  assert.match(out.text, /p2: FileKit PDF page two/)
})

test('filekit_outline truncates at the entry limit', async () => {
  const out = await run('sample.xlsx', { limit: 1 })
  assert.equal(out.entryCount, 1)
  assert.equal(out.truncated, true)
  assert.match(out.text, /outline truncated at 1 of/)
})

test('filekit_outline rejects a non-document path', async () => {
  await assert.rejects(() => run('sample.csv'), /supports \.docx, \.xlsx, \.pptx and \.pdf only/)
})

test('buildOutline rejects an unsupported format', () => {
  assert.throws(() => buildOutline(Buffer.from('x'), 'txt'), /not supported/)
})
