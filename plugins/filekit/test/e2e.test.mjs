/**
 * End-to-end test through the real tool bodies, using a `ctx.fs` shim backed by
 * node:fs. This exercises the whole pipeline (resolve -> stat -> readBytes ->
 * decode -> window/render) against REAL files, including a real Word document
 * built by our standard-library OOXML generator and a CSV with quoted fields and embedded newlines.
 *
 * The shim mirrors the host contract surface filekit depends on:
 *   resolve(path,{cwd}) -> {targetKey, displayPath}
 *   stat(target,signal) -> {type,size,version}|undefined
 *   readBytes(target,signal,maxBytes) -> Buffer
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

/** Build a ctx whose fs reads the real disk. */
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

function tool(ctx, config, name) {
  return buildTools(config, ctx).find((d) => d.name === name)
}

const baseConfig = readConfig({}, { pluginDir: join(here, '..'), profileDir: '', home: '' })

test('filekit_read_table pages a real CSV with quoted commas and embedded newlines', async () => {
  const ctx = fakeCtx(fixtures)
  const def = tool(ctx, baseConfig, 'filekit_read_table')
  const first = await def.execute({ path: 'sample.csv', limit: 2 }, { signal: new AbortController().signal })
  assert.match(first.text, /# id,? \| name,? \| score,? \| note/) // header rendered with " | "
  assert.match(first.text, /Alice, A\./)
  assert.match(first.text, /she said "hi"/)
  assert.equal(first.returned, 2)
  // Page the rest.
  const page2 = await def.execute({ path: 'sample.csv', offset: 3, limit: 5 }, { signal: new AbortController().signal })
  assert.match(page2.text, /Carol/)
  assert.match(page2.text, /multi/)
})

test('filekit_read_docx reads the real Word document body and tables', async () => {
  const ctx = fakeCtx(fixtures)
  const def = tool(ctx, baseConfig, 'filekit_read_docx')
  const result = await def.execute({ path: 'sample.docx', limit: 50 }, { signal: new AbortController().signal })
  assert.match(result.text, /<type>docx<\/type>/)
  assert.match(result.text, /FileKit Report/)
  assert.match(result.text, /First paragraph with an & ampersand and <angle> brackets\./)
  assert.match(result.text, /Second paragraph\s+after a tab/)
  assert.match(result.text, /\[table 2x3\]/)
  assert.match(result.text, /R1C1 \| R1C2 \| R1C3/)
  assert.match(result.text, /Paragraph after the table\./)
})

test('filekit_read_pdf reads a real PDF page by page', async () => {
  const ctx = fakeCtx(fixtures)
  const def = tool(ctx, baseConfig, 'filekit_read_pdf')
  const result = await def.execute({ path: 'sample.pdf' }, { signal: new AbortController().signal })
  assert.match(result.text, /<type>pdf<\/type>/)
  assert.match(result.text, /--- page 1 ---[\s\S]*FileKit PDF page one/)
  assert.match(result.text, /--- page 2 ---[\s\S]*FileKit PDF page two/)
  assert.match(result.text, /End of document - 2 pages/)
  assert.equal(result.pageCount, 2)
})

test('filekit_read_xlsx reads a real workbook sheet and selects another', async () => {
  const ctx = fakeCtx(fixtures)
  const def = tool(ctx, baseConfig, 'filekit_read_xlsx')
  const first = await def.execute({ path: 'sample.xlsx', limit: 10 }, { signal: new AbortController().signal })
  assert.match(first.text, /<type>xlsx<\/type>/)
  assert.match(first.text, /# Region \| Units \| Revenue \| Note/)
  assert.match(first.text, /North \| 120 \| 4800\.5 \| ok/)
  assert.match(first.text, /\(sheets: Sales, Meta\)/)
  const meta = await def.execute({ path: 'sample.xlsx', sheet: 'Meta' }, { signal: new AbortController().signal })
  assert.equal(meta.sheet, 'Meta')
  assert.match(meta.text, /generated \| 2026-10-23/)
})

test('filekit_read_pdf rejects a non-PDF file with a readable message', async () => {
  const ctx = fakeCtx(fixtures)
  const def = tool(ctx, baseConfig, 'filekit_read_pdf')
  await assert.rejects(
    () => def.execute({ path: 'sample.csv' }, { signal: new AbortController().signal }),
    /not a pdf|pdf/i,
  )
})
