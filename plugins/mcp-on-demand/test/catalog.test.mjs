/**
 * The catalog is the part the model can read without starting a process.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CATALOG_DESC_CAP,
  CATALOG_MAX_AGE_MS,
  CATALOG_TOOL_CAP,
  catalogPrompt,
  readCatalog,
  remember,
  rememberFailure,
  searchCatalog,
  summaryOf,
  writeCatalog,
} from '../lib/catalog.js'

test('a missing or broken catalog reads as empty', () => {
  assert.deepEqual(readCatalog(false), { servers: {} })
  assert.deepEqual(readCatalog(join(tmpdir(), 'mcpod-missing-catalog.json')), { servers: {} })
  const dir = mkdtempSync(join(tmpdir(), 'mcpod-catalog-'))
  const file = join(dir, 'catalog.json')
  writeFileSync(file, '{', 'utf8')
  assert.deepEqual(readCatalog(file), { servers: {} })
  rmSync(dir, { recursive: true, force: true })
})

test('remember keeps names, drops schemas, and survives a rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpod-catalog-'))
  const file = join(dir, 'nested', 'catalog.json')
  const catalog = { servers: {} }
  const tools = Array.from({ length: CATALOG_TOOL_CAP + 5 }, (_, index) => ({
    name: `mcp__REA__tool_${String(index).padStart(3, '0')}`,
    description: `line one\n${'x'.repeat(CATALOG_DESC_CAP + 40)}`,
    inputSchema: { type: 'object', secret: 'do-not-store' },
  }))
  remember(catalog, 'REA', { ok: true, tools, toolCount: tools.length, truncated: true })
  assert.equal(catalog.servers.REA.tools.length, CATALOG_TOOL_CAP)
  assert.equal(catalog.servers.REA.tools[0].name.startsWith('mcp__'), false)
  assert.equal(catalog.servers.REA.tools[0].description.length <= CATALOG_DESC_CAP, true)
  assert.equal(JSON.stringify(catalog).includes('do-not-store'), false)
  writeCatalog(file, catalog)
  const loaded = readCatalog(file)
  assert.equal(loaded.servers.REA.toolCount, tools.length)
  rmSync(dir, { recursive: true, force: true })
})

test('search ignores a stale catalog and matches purpose words', () => {
  const now = 1_000_000
  const catalog = { servers: {} }
  remember(catalog, 'REA', { ok: true, tools: [{ name: 'open_binary', description: 'load a file' }], toolCount: 1 })
  catalog.servers.REA.at = now - CATALOG_MAX_AGE_MS - 1
  const fresh = { servers: {} }
  remember(fresh, 'desk', { ok: true, tools: [{ name: 'click', description: 'press a button' }], toolCount: 1 })
  fresh.servers.desk.at = now
  const hits = searchCatalog(fresh, 'button', { now })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].call, 'mcp__desk__click')
  assert.deepEqual(searchCatalog(catalog, 'open', { now }), [])
})

test('the prompt names a server without dumping every tool', () => {
  const catalog = { servers: {} }
  remember(catalog, 'REA', {
    ok: true,
    tools: [{ name: 'open_binary', description: 'load' }, { name: 'decompile', description: 'c' }],
    toolCount: 2,
  })
  const text = catalogPrompt({ REA: { description: 'Ghidra reverse engineering' }, other: {} }, catalog)
  assert.match(text, /Ghidra reverse engineering/)
  assert.match(text, /open_binary/)
  assert.match(text, /other: no current catalog/)
  assert.equal(text.includes('inputSchema'), false)
})

test('searchCatalog handles CJK, 1-char, empty queries and allowedServers filtering', () => {
  const now = 1_000_000
  const catalog = { servers: {} }
  // \u9006\u5411 = reverse-engineering; \u6309\u94ae = button (kept ASCII via \u escapes).
  remember(catalog, 'REA', {
    ok: true,
    tools: [{ name: 'decompile', description: '\u9006\u5411 C code' }],
    toolCount: 1,
  })
  remember(catalog, 'desk', {
    ok: true,
    tools: [{ name: 'click', description: 'press \u6309\u94ae' }],
    toolCount: 1,
  })
  remember(catalog, 'removed', {
    ok: true,
    tools: [{ name: 'old_click', description: 'press \u6309\u94ae' }],
    toolCount: 1,
  })
  catalog.servers.REA.at = now
  catalog.servers.desk.at = now
  catalog.servers.removed.at = now

  // CJK query must match ONLY matching entries, never collapse to empty terms matching everything.
  const cjkHits = searchCatalog(catalog, '\u9006\u5411', { now })
  assert.deepEqual(cjkHits.map((h) => h.call), ['mcp__REA__decompile'])

  // Unmatched CJK query returns zero hits.
  assert.deepEqual(searchCatalog(catalog, '\u4e0d\u5b58\u5728', { now }), [])

  // 1-char query filters instead of matching everything.
  const oneChar = searchCatalog(catalog, 'c', { now })
  assert.equal(oneChar.length, 3)
  assert.deepEqual(searchCatalog(catalog, 'z', { now }), [])

  // Empty / whitespace query returns zero hits.
  assert.deepEqual(searchCatalog(catalog, '   ', { now }), [])

  // allowedServers hides servers no longer present in config.servers.
  const filtered = searchCatalog(catalog, '\u6309\u94ae', { now, allowedServers: { REA: {}, desk: {} } })
  assert.deepEqual(filtered.map((h) => h.server), ['desk'])
})

test('rememberFailure preserves valid cached tools and records lastError', () => {
  const catalog = { servers: {} }
  remember(catalog, 'REA', {
    ok: true,
    tools: [{ name: 'decompile', description: 'decompile function' }],
    toolCount: 1,
  })
  rememberFailure(catalog, 'REA', 'connect ECONNREFUSED', 2000)
  const summary = summaryOf(catalog.servers.REA, 2000)
  assert.equal(summary.ok, true)
  assert.equal(summary.tools.length, 1)
  assert.equal(summary.tools[0].name, 'decompile')
  assert.match(summary.error, /ECONNREFUSED/)
  assert.match(summary.lastError, /ECONNREFUSED/)
})
