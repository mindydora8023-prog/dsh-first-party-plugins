/**
 * Load test: run the plugin's real `apply()` against a minimal fake host that
 * implements just enough of the Cordis contract filekit uses
 * (inject/effect/logger/tools.register/systemPrompt.section/fs/emit).
 *
 * This catches wiring mistakes that unit tests of pure functions cannot:
 * a bad `inject` list, a section that throws, a registration loop that double
 * disposes, or a status file that cannot be written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

// The default loader uses the bundled compiler and needs no host checkout.

function fakeHost() {
  const registered = []
  const sections = []
  const effects = []
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: {
      info: (...args) => logs.info.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
    },
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      async stat() { return { type: 'file', size: 10, version: 'v1' } },
      async readBytes() { return Buffer.from('hello\nworld\n') },
    },
    emit() {},
    tools: {
      register(definition) {
        if (registered.some((r) => r.name === definition.name)) {
          throw new Error(`duplicate tool ${definition.name}`)
        }
        registered.push(definition)
        return () => {
          const i = registered.findIndex((r) => r.name === definition.name)
          if (i >= 0) registered.splice(i, 1)
        }
      },
      get(toolName) {
        return registered.find((r) => r.name === toolName)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const i = sections.findIndex((s) => s.name === section.name)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    effect(fn, label) { effects.push({ fn, label }) },
    // Minimal cordis-style inject: fail when a requested dependency is missing,
    // then call back with the same ctx. This mirrors cordis's own gate (a fiber
    // only sees services it asked for), so a forgotten `fs` fails here instead
    // of silently degrading at runtime.
    inject(deps, cb) {
      for (const dep of deps) {
        if (ctx[dep] === undefined) throw new Error(`cannot get property "${dep}" without inject`)
      }
      return cb(ctx)
    },
  }
  return { ctx, registered, sections, effects, logs }
}

test('plugin declares the services it needs', () => {
  assert.equal(name, 'filekit')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('systemPrompt'))
  // fs must be declared or cordis refuses ctx.fs access entirely.
  assert.ok(inject.includes('fs'))
})

test('apply() registers all four tools, one prompt section, and disposes cleanly', async (t) => {
  const host = fakeHost()
  // NEVER write the plugin's real status file: the running host owns it as its
  // load receipt, and a test that deletes it makes a healthy boot look failed.
  const statusFile = join(tmpdir(), `filekit-status-${process.pid}-${Date.now()}.json`)

  apply(host.ctx, { statusFile })

  // The register() inside inject() is async; let its microtasks settle.
  await new Promise((r) => setTimeout(r, 200))

  assert.deepEqual(host.logs.warn, [], `unexpected warnings: ${host.logs.warn.join(' | ')}`)
  assert.equal(host.registered.length, 4)
  assert.deepEqual(
    host.registered.map((r) => r.name).sort(),
    ['filekit_read_docx', 'filekit_read_pdf', 'filekit_read_table', 'filekit_read_xlsx'],
  )
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'filekit')

  // The prompt section renders a non-empty string only while tools are visible.
  const text = host.sections[0].text({ scope: undefined })
  assert.match(text, /filekit_read_table/)
  assert.match(text, /offset=N to continue/)

  // Status file was written and names the tools.
  assert.equal(existsSync(statusFile), true)
  const status = JSON.parse(readFileSync(statusFile, 'utf8'))
  assert.deepEqual(status.tools.sort(), ['filekit_read_docx', 'filekit_read_pdf', 'filekit_read_table', 'filekit_read_xlsx'])
  assert.equal(status.has_fs_service, true)

  // Disposal removes every tool and the section.
  assert.equal(host.effects.length, 1)
  host.effects[0].fn()()
  assert.equal(host.registered.length, 0)
  assert.equal(host.sections.length, 0)

  rmSync(statusFile, { force: true })
})

test('apply() never registers when the fs service is absent (cordis gates the inner inject)', async (t) => {
  const host = fakeHost()
  delete host.ctx.fs
  // With fs missing, the nested ctx.inject(['tools','systemPrompt','fs']) throws
  // exactly as real cordis does; either way no tool is registered.
  assert.throws(() => apply(host.ctx, { statusFile: false }), /without inject/)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(host.registered.length, 0)
})
