/**
 * Inject-consistency guard.
 *
 * Cordis gates every service a plugin reads on that fiber's `inject` list: an
 * undeclared service does not resolve, it throws "cannot get property X without
 * inject". That bit filekit during its first boot (apply() threw, so NO tool
 * registered), and the nested `ctx.inject(...)` inside apply() is a *separate*
 * fiber that must repeat the full list.
 *
 * The failure is silent from the model's point of view - the host logs one warn
 * and the plugin simply has no tools. This test makes the whole bug class loud:
 * it scans the executable sources for every `ctx.<service>` read and asserts the
 * declaration covers it, at both the top-level and the nested inject site.
 *
 * It deliberately does NOT demand services the plugin never uses: an unused
 * entry in `inject` would make the plugin wait for a service it does not need.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** Cordis services a plugin can request by name. */
const KNOWN_SERVICES = [
  'tools',
  'systemPrompt',
  'fs',
  'shell',
  'subprocess',
  'jobs',
  'llm',
  'settings',
  'attachments',
  'sandboxPolicy',
  'ptcRuntime',
]

/** Every `ctx.<service>` / `runtimeCtx.<service>` read in the executable sources. */
function usedServices() {
  const used = new Set()
  for (const file of readdirSync(libDir).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(join(libDir, file), 'utf8')
    for (const service of KNOWN_SERVICES) {
      // Match `ctx.tools`, `runtimeCtx.tools`, `c.fs`, etc. - any identifier
      // ending in "ctx"/"Ctx" followed by the service name.
      const pattern = new RegExp(`\\b\\w*[Cc]tx\\.${service}\\b`)
      if (pattern.test(source)) used.add(service)
    }
  }
  return used
}

/** The top-level `export const inject = [...]` declaration. */
function declaredInject() {
  const source = readFileSync(join(libDir, 'index.js'), 'utf8')
  const match = /export const inject\s*=\s*\[([^\]]*)\]/.exec(source)
  assert.ok(match, 'lib/index.js must declare `export const inject = [...]`')
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0)
}

/** Every nested `ctx.inject([...])` dependency list inside apply(). */
function nestedInjectLists() {
  const source = readFileSync(join(libDir, 'index.js'), 'utf8')
  const lists = []
  const pattern = /\w*[Cc]tx\.inject\(\s*\[([^\]]*)\]/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    lists.push(
      match[1]
        .split(',')
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
        .filter((part) => part.length > 0),
    )
  }
  return lists
}

test('every service the code reads is declared in `inject`', () => {
  const used = usedServices()
  const declared = new Set(declaredInject())
  assert.ok(used.size > 0, 'expected to find at least one ctx.<service> read')
  const missing = [...used].filter((service) => !declared.has(service))
  assert.deepEqual(
    missing,
    [],
    `lib/ reads ctx.<${missing.join('>, ctx.<')}> but \`inject\` omits it - cordis will throw at load time`,
  )
})

test('the nested ctx.inject() inside apply() repeats every declared service', () => {
  const declared = declaredInject()
  const nested = nestedInjectLists()
  // A plugin that never nests is fine; one that nests must not narrow the list.
  for (const list of nested) {
    const missing = declared.filter((service) => !list.includes(service))
    assert.deepEqual(
      missing,
      [],
      `nested ctx.inject(${JSON.stringify(list)}) drops ${JSON.stringify(missing)}; `
        + 'a nested fiber only sees what it asks for, so ctx.<service> would throw inside apply()',
    )
  }
})

test('`inject` names no unknown service and no duplicates', () => {
  const declared = declaredInject()
  assert.equal(new Set(declared).size, declared.length, 'duplicate entry in inject')
  const unknown = declared.filter((service) => !KNOWN_SERVICES.includes(service))
  assert.deepEqual(unknown, [], `inject names services this guard does not know: ${unknown.join(', ')}`)
})

test('the guard actually detects a missing service (self-check)', () => {
  // Prove the detector is not vacuous: a source that reads ctx.fs but declares
  // only tools/systemPrompt must produce a non-empty "missing" list.
  const fakeSource = 'ctx.tools.get("x"); ctx.systemPrompt.section({}); ctx.fs.resolve("p")'
  const used = new Set(KNOWN_SERVICES.filter((service) => new RegExp(`\\b\\w*[Cc]tx\\.${service}\\b`).test(fakeSource)))
  assert.deepEqual([...used].sort(), ['fs', 'systemPrompt', 'tools'])
  const declared = new Set(['tools', 'systemPrompt'])
  assert.deepEqual([...used].filter((s) => !declared.has(s)), ['fs'])
})
