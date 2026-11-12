/**
 * Real-Cordis mount test.
 *
 * Unit tests prove the modules behave; this proves the plugin actually loads on
 * a real cordis Context, which is where a `link:` plugin fails first in
 * practice. Two things it pins:
 *
 *   1. `fs` is declared in `inject`, so cordis gates `apply()` on it. Without
 *      that declaration `ctx.fs` throws inside the plugin and the whole thing
 *      fails to load -- silently, from the user's point of view.
 *   2. Unloading the plugin removes its registration and its prompt section.
 *      A registry contribution that leaks on unload breaks HMR.
 *
 * Skips when the extracted cordis checkout is absent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CORDIS = join(process.env.DSH_HOST_CHECKOUT || join(tmpdir(), 'dsh-host-not-configured'), 'node_modules/@deepseek-ai/cordis/lib/index.js')
const available = existsSync(CORDIS)

/** Build the three services the plugin touches, recording registrations. */
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

test('inject declares fs, so apply() is gated on the fs service', async (t) => {
  if (!available) { t.skip('no extracted cordis checkout'); return }
  const cordis = await import(pathToFileURL(CORDIS).href)
  const { apply, inject, name } = await import('../lib/index.js')
  assert.deepEqual([...inject].sort(), ['fs', 'systemPrompt', 'tools'])

  // fs intentionally NOT mounted: the plugin must not apply at all.
  const services = stubServices()
  const ctx = new cordis.Context()
  await mountService(ctx, cordis, 'tools', services.tools)
  await mountService(ctx, cordis, 'systemPrompt', services.systemPrompt)
  ctx.plugin({ name, inject, apply }, {})
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(services.tools.registered.size, 0, 'no tools may register before fs is mounted')
})

test('apply() registers the tool and its prompt section, and unload removes both', async (t) => {
  if (!available) { t.skip('no extracted cordis checkout'); return }
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'ops-lite-home-'))
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
  await mountService(ctx, cordis, 'fs', services.fs)

  const fiber = ctx.plugin({ name, inject, apply }, { promptGuidance: true })
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.ok(services.tools.registered.has('ops_read_files'), 'the tool must be registered')
  const definition = services.tools.registered.get('ops_read_files')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['files'])
  assert.equal(services.systemPrompt.sections.has('ops-lite:read'), true, 'guidance must be published')

  // The registered definition is callable through the real service surface.
  const value = await definition.execute({ files: [{ path: 'a.txt' }] }, {
    agent: { session: { header: { cwd: home } } },
    callId: 'c1',
  })
  assert.equal(typeof value.text, 'string')
  assert.equal(value.total, 1)

  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(services.tools.registered.has('ops_read_files'), false, 'unload must remove the tool')
  assert.equal(services.systemPrompt.sections.has('ops-lite:read'), false, 'unload must remove the section')
})

test('promptGuidance: false registers the tool without a prompt section', async (t) => {
  if (!available) { t.skip('no extracted cordis checkout'); return }
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'ops-lite-home2-'))
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
  await mountService(ctx, cordis, 'fs', services.fs)

  ctx.plugin({ name, inject, apply }, { promptGuidance: false })
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.ok(services.tools.registered.has('ops_read_files'))
  assert.equal(services.systemPrompt.sections.has('ops-lite:read'), false)
})

/**
 * The plugin page resolves the display description THROUGH the package's
 * `exports` map. Declaring `exports` without `"./package.json"` makes Node
 * refuse that subpath, the reader gets nothing, and the card renders with no
 * description at all -- silently, with no error anywhere.
 *
 * This was a real defect on 2026-10-24: ops-lite shipped
 * `exports: { ".", "./lib/*" }` and its card was blank in the plugins page while
 * every sibling plugin showed Chinese text. The assertion below fails if either
 * subpath is dropped again.
 */
test('the manifest stays readable through exports (the plugins page needs this)', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.exports !== undefined, 'exports must exist; the loader reads the root entry through it')
  assert.equal(
    manifest.exports['./package.json'],
    './package.json',
    'without this the plugin page cannot read the description and the card is blank',
  )
  assert.equal(
    manifest.exports['./locale/*.json'],
    './locale/*.json',
    'without this the localized description in locale/ cannot be resolved',
  )
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 0, 'an empty description renders an empty card')
})