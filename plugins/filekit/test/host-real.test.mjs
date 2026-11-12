/**
 * Real-host contract test: compile the four definitions with the ACTUAL
 * `defineTool` from an extracted DSH checkout, when one is available.
 *
 * This is the strongest check we can run outside the running host: it uses the
 * host's own authoring-form compiler, JSON-Schema subset checker, argument
 * validator, and registration-time checks. It skips when no checkout exists so
 * `npm test` still works on a machine without one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

const PLUGIN_DIR = fileURLToPath(new URL('../', import.meta.url))
const CANDIDATE = process.env.DSH_HOST_CHECKOUT ? resolve(process.env.DSH_HOST_CHECKOUT, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js') : ''

const available = existsSync(CANDIDATE)

test('definitions compile with the real host defineTool', async (t) => {
  if (!available) { t.skip('no extracted DSH checkout'); return }
  const { defineTool } = await import(pathToFileURL(CANDIDATE).href)
  assert.equal(typeof defineTool, 'function')

  const config = readConfig({}, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })
  const definitions = buildTools(config)
  assert.equal(definitions.length, 4)
  for (const definition of definitions) {
    const tool = defineTool(definition)
    assert.equal(tool.name, definition.name)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('real validator rejects malformed args before execute runs', async (t) => {
  if (!available) { t.skip('no extracted DSH checkout'); return }
  const { defineTool } = await import(pathToFileURL(CANDIDATE).href)
  const config = readConfig({}, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })
  // `filekit_read_table` stands in for the removed `filekit_read` (2026-10-26):
  // it has a required, typed, page-shaped argument set, which is what makes a
  // validator comparison meaningful.
  //
  // `buildTools` needs the `fs` service while building (the closure captures
  // `ctx`), so even a validation-only test has to hand it a stub.
  const tableTool = defineTool(buildTools(config, { fs: {}, emit() {} }).find((d) => d.name === 'filekit_read_table'))

  const exec = { signal: new AbortController().signal }
  // Missing required `path` and a wrong-typed `path` are the host validator's job,
  // and both must fail with its INVALID_ARGS wording.
  await assert.rejects(() => tableTool.execute({}, exec), /invalid arguments/i)
  await assert.rejects(() => tableTool.execute({ path: 123 }, exec), /invalid arguments/i)
  // An out-of-enum delimiter is also caught by the host validator (the enum is
  // part of the subset), before the reader ever opens the file.
  await assert.rejects(() => tableTool.execute({ path: 'a.csv', delimiter: '#' }, exec), /invalid arguments/i)
})

test('a well-formed call reaches our body and reports the read failure in text', async (t) => {
  if (!available) { t.skip('no extracted DSH checkout'); return }
  const { defineTool } = await import(pathToFileURL(CANDIDATE).href)
  const config = readConfig({}, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })

  // The host calls execute(args, exec) only; `ctx` is captured by the tool
  // factory. Give it a fake fs so we exercise filekit's own error path instead of
  // a real disk hit: resolve() throws, which is what a bad path produces.
  const ctx = {
    fs: {
      async resolve() { throw new Error('resolved-not-a-file') },
      async stat() { return undefined },
      async readBytes() { return Buffer.alloc(0) },
    },
    emit() {},
  }
  const tableTool = defineTool(buildTools(config, ctx).find((d) => d.name === 'filekit_read_table'))
  let message = ''
  try {
    await tableTool.execute({ path: 'nope.csv' }, { signal: new AbortController().signal })
  } catch (error) {
    message = error.message
  }
  // A single-file document reader reports failure by throwing (it has no
  // multi-entry envelope to carry per-file errors), so the message is the surface.
  assert.match(message, /resolved-not-a-file/)
})
