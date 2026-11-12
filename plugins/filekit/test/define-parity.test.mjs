/**
 * defineTool parity + real-cordis load test.
 *
 * Release-local parity tests. Set DSH_HOST_CHECKOUT to an optional extracted
 * host root containing node_modules/@deepseek-ai to enable host comparisons.
 *
 * WHAT IT PROVES
 * A `link:` plugin cannot import `@deepseek-ai/dsh-tools` (the package ships only
 * inside app.asar), so each plugin carries `lib/define.js`. For gmail that
 * substitution failing silently once meant a plugin that loaded and registered
 * nothing for nine days. These tests make the substitution verifiable:
 *
 *   1. every tool definition compiles with the bundled compiler;
 *   2. the compiled schema is deep-equal to the host's own compiler;
 *   3. argument validation agrees with the host case by case;
 *   4. the plugin really registers its tools on a real cordis Context.
 *
 * Step 2 and 4 SKIP when the DSH_HOST_CHECKOUT is absent, so the
 * suite still runs elsewhere -- the skip is visible in the counts rather than
 * passing silently.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { defineTool as bundledDefineTool, compileParameters, validateArgs } from '../lib/define.js'

// ---------------------------------------------------------------- plugin block

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The only plugin-specific part of this file.
 *
 * `expectTools` is the exact registered tool-name list: an extra or missing name
 * fails, so adding a tool without updating this list is caught rather than
 * silently tolerated.
 */
const PLUGIN = {
  name: 'filekit',

  /**
   * Build the plugin's tool definitions plus its module namespace.
   *
   * filekit's `buildTools(config, ctx)` needs the host filesystem service at
   * build time, so this returns a minimal stub: registration does not read any
   * file, and a stub that refuses every read cannot make the test lie about what
   * is registered.
   */
  async load() {
    const { readConfig } = await import('../lib/config.js')
    const { buildTools } = await import('../lib/tools.js')
    const config = readConfig({}, { pluginDir: PLUGIN_ROOT, profileDir: '', home: '' })
    const ctx = {
      fs: {
        async resolve(requested) {
          return { targetKey: requested, displayPath: requested }
        },
        async stat() {
          return undefined
        },
        async readBytes() {
          throw new Error('the parity test registers tools; it never reads a file')
        },
      },
      emit() {},
    }
    return { tools: buildTools(config, ctx), mod: await import('../lib/index.js') }
  },

  /**
   * One tool whose arguments are worth comparing against the host validator.
   * `filekit_read_table` replaced `filekit_read` when that tool was removed
   * (2026-10-26); it has required, typed, page-shaped arguments, which is what
   * makes a parity comparison meaningful.
   */
  validationSample: 'filekit_read_table',
  validationCases: [
    { path: 'a.csv' },
    { path: 'a.csv', offset: 10, limit: 20 },
    { path: 'a.csv', delimiter: ',' },
    {},
    { path: 123 },
    { path: 'a.csv', bogus: 1 },
    { path: 'a.csv', limit: 'x' },
  ],

  expectTools: [
    'filekit_read_docx',
    'filekit_read_pdf',
    'filekit_read_table',
    'filekit_read_xlsx',
  ],

  /** The prompt section order this plugin asks for (see its cordis section). */
  sectionOrder: 985,
}

// ---------------------------------------------------------------- host checkout

const CHECKOUT = process.env.DSH_HOST_CHECKOUT
const HOST = CHECKOUT ? resolve(CHECKOUT, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js') : ''
const CORDIS = CHECKOUT ? resolve(CHECKOUT, 'node_modules/@deepseek-ai/cordis/lib/index.js') : ''
const hasHost = existsSync(HOST)
const hasCordis = existsSync(CORDIS)

// ---------------------------------------------------------------------- tests

test('every tool compiles with the bundled defineTool', async () => {
  const { tools } = await PLUGIN.load()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...PLUGIN.expectTools].sort(),
    'the registered tool names changed; update expectTools in this file',
  )
  for (const definition of tools) {
    const tool = bundledDefineTool(definition)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('compiled parameter schemas are deep-equal to the host compiler', async (t) => {
  if (!hasHost) { t.skip('no extracted dsh-tools checkout'); return }
  const host = await import(pathToFileURL(HOST).href)
  const { tools } = await PLUGIN.load()
  for (const definition of tools) {
    assert.deepEqual(
      compileParameters(definition.parameters),
      host.defineTool(definition).parameters,
      `${definition.name}: compiled schema differs from host`,
    )
    host.assertSupportedJsonSchema(compileParameters(definition.parameters))
  }
})

test('argument validation agrees with the host', async (t) => {
  if (!hasHost) { t.skip('no extracted dsh-tools checkout'); return }
  const host = await import(pathToFileURL(HOST).href)
  const { tools } = await PLUGIN.load()
  const definition = tools.find((entry) => entry.name === PLUGIN.validationSample)
  assert.ok(definition, `no tool named ${PLUGIN.validationSample} to validate against`)
  const mine = compileParameters(definition.parameters)
  const theirs = host.defineTool(definition).parameters

  for (const args of PLUGIN.validationCases) {
    assert.deepEqual(
      validateArgs(mine, args).length === 0,
      host.validateJsonSchemaValue(theirs, args, '').length === 0,
      `${JSON.stringify(args)}: validity disagrees`,
    )
  }
})

test('both implementations throw the same argument-error shape', async (t) => {
  if (!hasHost) { t.skip('no extracted dsh-tools checkout'); return }
  const host = await import(pathToFileURL(HOST).href)
  const { tools } = await PLUGIN.load()
  const definition = tools.find((entry) => entry.name === PLUGIN.validationSample)
  const exec = { signal: new AbortController().signal }

  const hostTool = host.defineTool(definition)
  const mineTool = bundledDefineTool(definition)

  // `path: 123` is the interesting case: the schema says string, so both must
  // reject it before any file is touched.
  for (const args of [{}, { path: 123 }]) {
    let hostMessage
    try { await hostTool.execute(args, exec) } catch (error) { hostMessage = error.message }
    let mineMessage
    try { await mineTool.execute(args, exec) } catch (error) { mineMessage = error.message }
    assert.ok(hostMessage, 'host rejects the arguments')
    assert.ok(mineMessage, 'bundled rejects the arguments')
    assert.match(hostMessage, /^invalid arguments:/)
    assert.match(mineMessage, /^invalid arguments:/)
  }
})

test('bundled defineTool enforces the same authoring rules the host does', () => {
  // A type array is not a single type string.
  assert.throws(
    () => compileParameters({ a: { type: ['string', 'null'] } }),
    /unsupported JSON schema|not an authoring key|must be/,
  )
  // An unknown authoring key must be refused rather than silently dropped.
  assert.throws(() => compileParameters({ a: { type: 'string', pattern: 'x' } }), /not an authoring key/)
  // An object without an explicit additionalProperties is rejected.
  assert.throws(
    () => compileParameters({ a: { type: 'object', properties: {} } }),
    /additionalProperties must be explicitly true or false/,
  )
  // oneOf needs at least two branches.
  assert.throws(() => compileParameters({ a: { oneOf: [{ type: 'string' }] } }), /at least two/)
  // Per-property required is lifted into the object's required array.
  assert.deepEqual(compileParameters({ a: { type: 'string', required: true } }).required, ['a'])
})

test('a definition built by the bundled compiler is registry-shaped', async () => {
  const { tools } = await PLUGIN.load()
  const tool = bundledDefineTool(tools[0])
  assert.equal(typeof tool.name, 'string')
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('the plugin registers its tools on a real cordis Context', async (t) => {
  if (!hasCordis) { t.skip('no extracted cordis checkout'); return }
  // The host-tools probe is opt-in now (DSH_PROBE_HOST_TOOLS). Clearing it proves
  // the bundled path is taken whatever the environment says.
  const saved = ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_PROBE_HOST_TOOLS'].map((key) => [key, process.env[key]])
  delete process.env['DSH_PROBE_HOST_TOOLS']
  process.env['DSH_HOME'] = ''
  process.env['DSH_PROFILE_DIR'] = ''
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const cordis = await import(pathToFileURL(CORDIS).href)
  const { mod } = await PLUGIN.load()

  const registered = new Map()
  const sections = new Map()
  const ctx = new cordis.Context()
  const tools = new cordis.Service(ctx, 'tools')
  tools.register = (definition) => {
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  }
  tools.get = (name) => registered.get(name)
  const prompt = new cordis.Service(ctx, 'systemPrompt')
  prompt.section = (section) => {
    sections.set(section.name, section)
    return () => sections.delete(section.name)
  }
  prompt.getSectionOrder = () => PLUGIN.sectionOrder
  // filekit and ops-lite also declare `fs`; a stub is enough for registration.
  if ((mod.inject ?? []).includes('fs')) {
    new cordis.Service(ctx, 'fs')
    ctx.fs = { resolve: async () => ({}), stat: async () => undefined, readBytes: async () => Buffer.alloc(0) }
  }

  ctx.plugin({ name: mod.name, inject: mod.inject, apply: mod.apply }, { statusFile: false })
  await new Promise((done) => setTimeout(done, 1200))

  assert.equal(registered.size, PLUGIN.expectTools.length, `registered: ${[...registered.keys()].join(', ')}`)
  assert.equal(sections.size, 1)
  assert.deepEqual([...registered.keys()].sort(), [...PLUGIN.expectTools].sort())
})
