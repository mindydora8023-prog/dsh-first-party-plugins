/**
 * Real-cordis load test.
 *
 * Runs the plugin's `apply()` on an actual `@deepseek-ai/cordis` Context with
 * minimal stand-ins for the three services filekit touches. This proves what a
 * fake ctx cannot:
 *
 *   1. Declaring 'fs' in `inject` makes cordis WAIT for the fs service: while
 *      it is unmounted, `apply()` never runs and no tool is registered. That is
 *      the correct load-order guarantee for a filesystem-backed plugin.
 *   2. With all three services mounted, `apply()` registers all four tools and
 *      one prompt section, and unloading removes them.
 *
 * Skips when the extracted cordis checkout is absent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostRoot = process.env.DSH_HOST_CHECKOUT
const CORDIS = hostRoot ? resolve(hostRoot, 'node_modules/@deepseek-ai/cordis/lib/index.js') : ''
const DSH_TOOLS = hostRoot ? resolve(hostRoot, 'node_modules/@deepseek-ai/dsh-tools') : ''
const available = existsSync(CORDIS) && existsSync(DSH_TOOLS)

/** A throwaway DSH_HOME whose profiles/node_modules exposes dsh-tools. */
function makeTempHome() {
  const home = join(tmpdir(), `filekit-cordis-${process.pid}-${Date.now()}`)
  const parent = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  mkdirSync(parent, { recursive: true })
  symlinkSync(DSH_TOOLS, join(parent, 'dsh-tools'), 'junction')
  return home
}

function stubServices() {
  return {
    tools: {
      registered: new Map(),
      register(definition) {
        this.registered.set(definition.name, definition)
        return () => this.registered.delete(definition.name)
      },
      get(name) { return this.registered.get(name) },
    },
    systemPrompt: {
      sections: new Map(),
      section(section) {
        this.sections.set(section.name, section)
        return () => this.sections.delete(section.name)
      },
      getSectionOrder() { return 1000 },
    },
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      async stat() { return { type: 'file', size: 4, version: 'v1' } },
      async readBytes() { return Buffer.from('ok\n') },
    },
  }
}

async function mountService(ctx, cordis, name, value) {
  const impl = new cordis.Service(ctx, name)
  Object.assign(impl, value)
  return impl
}

test('inject declares fs so cordis gates apply() on the fs service', async (t) => {
  if (!available) { t.skip('no extracted cordis checkout'); return }
  const cordis = await import(pathToFileURL(CORDIS).href)
  const { apply, inject, name } = await import('../lib/index.js')
  assert.deepEqual([...inject].sort(), ['fs', 'systemPrompt', 'tools'])

  // fs intentionally NOT mounted: the plugin must not apply at all.
  const services = stubServices()
  const ctx = new cordis.Context()
  await mountService(ctx, cordis, 'tools', services.tools)
  await mountService(ctx, cordis, 'systemPrompt', services.systemPrompt)
  ctx.plugin({ name, inject, apply }, { statusFile: false })
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(services.tools.registered.size, 0, 'no tools before fs is mounted')
})

test('apply() registers all four tools on a real cordis Context, and unload removes them', async (t) => {
  if (!available) { t.skip('no extracted cordis checkout'); return }
  const previousHome = process.env.DSH_HOME
  const home = makeTempHome()
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const cordis = await import(pathToFileURL(CORDIS).href)
  const { apply, inject, name } = await import('../lib/index.js')

  const services = stubServices()
  const ctx = new cordis.Context()
  await mountService(ctx, cordis, 'tools', services.tools)
  await mountService(ctx, cordis, 'systemPrompt', services.systemPrompt)

  // Load the plugin BEFORE fs exists; it must wait.
  const fiber = ctx.plugin({ name, inject, apply }, { statusFile: false })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(services.tools.registered.size, 0)

  // Mount fs: cordis should now apply the waiting plugin.
  await mountService(ctx, cordis, 'fs', services.fs)
  await new Promise((r) => setTimeout(r, 300))

  assert.equal(services.tools.registered.size, 4)
  assert.deepEqual(
    [...services.tools.registered.keys()].sort(),
    ['filekit_read_docx', 'filekit_read_pdf', 'filekit_read_table', 'filekit_read_xlsx'],
  )
  assert.equal(services.systemPrompt.sections.size, 1)

  // Unload just this plugin: its tools and section must be withdrawn.
  await fiber?.dispose?.()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(services.tools.registered.size, 0, 'tools withdrawn on unload')
  assert.equal(services.systemPrompt.sections.size, 0, 'section withdrawn on unload')
})
