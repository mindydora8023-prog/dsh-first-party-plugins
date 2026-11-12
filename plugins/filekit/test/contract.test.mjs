/**
 * Schema-subset conformance test.
 *
 * The riskiest part of adding tools is the JSON Schema subset the host enforces.
 * That subset is closed: only type/oneOf/properties/required/additionalProperties/
 * items/enum/const plus annotations (description/title/...) are accepted, and one
 * scalar `type` string only (no type arrays), oneOf needs >= 2 branches.
 *
 * The host's compiler is not runnable from a bare checkout here (its vendor
 * dependency tree is not installed), so this file carries a faithful port of the
 * host's authoring-form compiler and its schema checker. If a definition would be
 * rejected at load time, it fails here instead.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const PLUGIN_DIR = fileURLToPath(new URL('../', import.meta.url))

import { readConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

const CONSTRAINT = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** Authoring form -> raw JSON Schema (port of parameterSchemaSpecToJsonSchema). */
function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    properties[key] = compileNode(node)
    if (node && node.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

function compileNode(node) {
  if (node === null || typeof node !== 'object') {
    throw new Error('author schema node must be an object')
  }
  const out = {}
  if (typeof node.type === 'string') out.type = node.type
  if (typeof node.description === 'string') out.description = node.description
  if (typeof node.title === 'string') out.title = node.title
  if (Array.isArray(node.enum)) out.enum = [...node.enum]
  if (Object.prototype.hasOwnProperty.call(node, 'const')) out.const = node.const
  if (node.items !== undefined) out.items = compileNode(node.items)
  if (node.properties !== undefined) {
    out.type = out.type ?? 'object'
    out.properties = {}
    const req = []
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = compileNode(v)
      if (v && v.required === true) req.push(k)
    }
    if (req.length > 0) out.required = req
  }
  if (node.additionalProperties !== undefined) out.additionalProperties = node.additionalProperties
  if (node.oneOf !== undefined) out.oneOf = node.oneOf.map(compileNode)
  return out
}

/** Faithful port of the host's checkSchemaNode, returning a violation list. */
function checkSchema(root) {
  const violations = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${path} must be a schema object`)
      return
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINT.has(key)) continue
      if (ANNOTATIONS.has(key)) continue
      violations.push(`${path}.${key} is not a supported keyword`)
    }
    if (Object.prototype.hasOwnProperty.call(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    const hasType = Object.prototype.hasOwnProperty.call(node, 'type')
    const hasOneOf = Object.prototype.hasOwnProperty.call(node, 'oneOf')
    if (hasType && hasOneOf) { violations.push(`${path} cannot declare both type and oneOf`); return }
    if (!hasType && !hasOneOf) return
    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${path}.oneOf must be at least two schemas`)
      } else {
        node.oneOf.forEach((branch, i) => walk(branch, `${path}.oneOf[${i}]`))
      }
      return
    }
    if (Array.isArray(node.type)) { violations.push(`${path}.type must be a single type string`); return }
    if (!SCHEMA_TYPES.includes(node.type)) { violations.push(`${path}.type is not a schema type`); return }
    const type = node.type
    const misplaced = {
      properties: 'object', required: 'object', additionalProperties: 'object', items: 'array',
      enum: null, const: null,
    }
    for (const [key, allowedOn] of Object.entries(misplaced)) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue
      if (allowedOn !== null && allowedOn !== type) violations.push(`${path}.${key} not supported on type "${type}"`)
    }
    if (type === 'object' && node.properties !== undefined) {
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.properties.${k}`)
    }
    if (type === 'array' && node.items !== undefined) walk(node.items, `${path}.items`)
  }
  walk(root, 'schema')
  return violations
}

test('every tool parameter schema is inside the host subset', () => {
  const config = readConfig({}, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })
  const definitions = buildTools(config)
  assert.equal(definitions.length, 4)
  for (const definition of definitions) {
    const schema = compilePropertyMap(definition.parameters)
    const violations = checkSchema(schema)
    assert.deepEqual(violations, [], `${definition.name}: ${violations.join('; ')}`)
    assert.equal(schema.type, 'object')
    // Every required key exists in properties.
    for (const req of schema.required ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(schema.properties, req), `${definition.name}: required ${req} missing`)
    }
  }
})

test('the subset checker actually rejects the shapes it claims to', () => {
  assert.deepEqual(checkSchema({ type: 'object', properties: { a: { type: 'string' } } }), [])
  assert.ok(checkSchema({ type: ['object', 'null'] }).length > 0, 'type arrays rejected')
  assert.ok(checkSchema({ type: 'object', maxLength: 5 }).length > 0, 'unknown keyword rejected')
  assert.ok(checkSchema({ oneOf: [{ type: 'string' }] }).length > 0, 'oneOf needs two branches')
  assert.ok(checkSchema({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } }).length > 0)
})

test('tool names are unique and do not collide with the reserved run_code', () => {
  const config = readConfig({}, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })
  const names = buildTools(config).map((d) => d.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) {
    assert.notEqual(name, 'run_code')
    assert.match(name, /^[a-z][a-z0-9_]*$/)
  }
})
