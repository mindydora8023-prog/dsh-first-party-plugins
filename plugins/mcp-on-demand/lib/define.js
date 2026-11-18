/**
 * Canonical `defineTool` implementation shared by the in-house DSH plugins.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A `link:` plugin lives outside the profile and outside the app install, so
 * `import '@deepseek-ai/dsh-tools'` cannot resolve from its real path: on this
 * machine that package ships only inside `app.asar`, which a plain ESM import
 * cannot read. Every plugin that registers a tool therefore carries its own copy
 * of this module.
 *
 * Measured 2026-10-26: all four copies were byte-identical (SHA-256
 * C4848154CBB7D2C4...), and the `loadTools()` probe in each plugin's index.js
 * tried five candidates that ALL fail:
 *
 *   bare '@deepseek-ai/dsh-tools'                    ERR_MODULE_NOT_FOUND
 *   <home>/profiles/node_modules/...                 path does not exist
 *   <profile>/node_modules/...                       path does not exist
 *   <plugin>/../../node_modules/...                  path does not exist
 *   <plugin>/../node_modules/...                     path does not exist
 *
 * so `define_tool_source` was always "bundled" (confirmed in filekit / gmail /
 * github / ops-lite status files, all written at the same host load).
 *
 * THIS FILE IS THE SOURCE OF TRUTH. The copies in each plugin are generated from
 * it by `tools/sync-shared-code.mjs` and must stay byte-identical; a test in each
 * plugin fails when they drift. Do not hand-edit a plugin's copy -- edit here and
 * run the sync tool.
 *
 * It stays a plain ES module with no imports so that copying it is safe.
 *
 * The host's `register()` requires:
 *   { name, description, parameters: <raw JSON Schema>, output: { schema, render },
 *     execute(args, exec), isConcurrencySafe?, timeoutMs? }
 *
 * So this module supplies exactly that:
 *   - compileParameters(): the authoring form -> the host's enforced JSON Schema
 *     subset (type/oneOf/properties/required/additionalProperties/items/enum/const
 *     plus description/title/default/examples annotations), with per-property
 *     `required: true` lifted into the object's `required` array.
 *   - validateArgs(): strict validation against that subset, returning
 *     path-qualified violations, so malformed model arguments fail before any
 *     file is touched (the host does the same for its own tools).
 *
 * The compiler and validator are deliberately faithful ports of the host's
 * behaviour; test/contract.test.mjs cross-checks them against the real host
 * implementation when a checkout is available.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

/** Author-only keys accepted on one schema node. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/** Schema types the host accepts (a single string, never an array). */
export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

class SchemaError extends Error {
  constructor(violations) {
    super(`unsupported JSON schema: ${violations.join('; ')}`)
    this.name = 'SchemaError'
    this.violations = violations
  }
}

class ArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ArgsError'
    this.violations = violations
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertAuthorKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new SchemaError([`${path}.${key} is not an authoring key`])
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key]
  }
}

/**
 * Compile one authoring node into the enforced raw schema subset.
 * @param {object} node authoring form
 * @param {string} path diagnostic path
 * @param {boolean} allowRequired whether `required: true` may appear here
 * @returns {{schema: object, required: boolean}}
 */
function compileNode(node, path, allowRequired) {
  if (!isRecord(node)) throw new SchemaError([`${path} must be a value schema object`])
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  const out = {}
  const required = node.required === true

  if (Object.prototype.hasOwnProperty.call(node, 'oneOf')) {
    assertAuthorKeys(node, path, [...authorKeys, 'oneOf', 'type'])
    if (Object.prototype.hasOwnProperty.call(node, 'type')) {
      throw new SchemaError([`${path} cannot declare both type and oneOf`])
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new SchemaError([`${path}.oneOf must be an array of at least two value schemas`])
    }
    copyAnnotations(node, out)
    out.oneOf = node.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false).schema)
    return { schema: out, required }
  }

  const type = Object.prototype.hasOwnProperty.call(node, 'type') ? node.type : undefined
  switch (type) {
    case 'object': {
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      // The host requires an explicit boolean here rather than defaulting it.
      if (typeof node.additionalProperties !== 'boolean') {
        throw new SchemaError([`${path}.additionalProperties must be explicitly true or false`])
      }
      out.type = 'object'
      copyAnnotations(node, out)
      out.additionalProperties = node.additionalProperties
      if (Object.prototype.hasOwnProperty.call(node, 'properties')) {
        const compiled = compilePropertyMap(node.properties, `${path}.properties`)
        out.properties = compiled.properties
        if (compiled.required !== undefined) out.required = compiled.required
      }
      return { schema: out, required }
    }
    case 'array': {
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'items'])
      out.type = 'array'
      copyAnnotations(node, out)
      if (Object.prototype.hasOwnProperty.call(node, 'items')) {
        out.items = compileNode(node.items, `${path}.items`, false).schema
      }
      return { schema: out, required }
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'enum', 'const'])
      out.type = type
      copyAnnotations(node, out)
      if (Object.prototype.hasOwnProperty.call(node, 'enum')) {
        if (!Array.isArray(node.enum) || node.enum.length === 0) {
          throw new SchemaError([`${path}.enum must be a non-empty array of scalar values`])
        }
        out.enum = [...node.enum]
      }
      if (Object.prototype.hasOwnProperty.call(node, 'const')) out.const = node.const
      return { schema: out, required }
    }
    case 'json': {
      // Annotation-only schema: any JSON value.
      assertAuthorKeys(node, path, [...authorKeys, 'type'])
      copyAnnotations(node, out)
      return { schema: out, required }
    }
    default:
      throw new SchemaError([
        `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`,
      ])
  }
}

/** Compile a property map, lifting per-property `required: true` into an array. */
function compilePropertyMap(spec, path) {
  if (!isRecord(spec)) throw new SchemaError([`${path} must be an object of value schemas`])
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const compiled = compileNode(node, `${path}.${key}`, true)
    properties[key] = compiled.schema
    if (compiled.required) required.push(key)
  }
  return { properties, required: required.length > 0 ? required : undefined }
}

/**
 * Compile an authoring parameter map into the host's raw JSON Schema form.
 * @param {object} spec per-property authoring definitions
 * @returns {object} object-rooted JSON Schema
 */
export function compileParameters(spec) {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) schema.required = compiled.required
  assertSupportedSchema(schema)
  return schema
}

/**
 * Assert a raw schema stays inside the host's enforced subset.
 * @param {object} root raw schema
 * @returns {object} the same schema
 */
export function assertSupportedSchema(root) {
  const violations = []
  const seen = new Set()

  const walk = (node, path) => {
    if (!isRecord(node)) { violations.push(`${path} must be a schema object`); return }
    if (seen.has(node)) { violations.push(`${path} is circular`); return }
    seen.add(node)
    try {
      for (const key of Object.keys(node)) {
        const allowed = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
        if (!allowed.includes(key) && !ANNOTATION_KEYS.includes(key)) {
          violations.push(`${path}.${key} is not a supported keyword`)
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, 'description') && typeof node.description !== 'string') {
        violations.push(`${path}.description must be a string`)
      }
      if (Object.prototype.hasOwnProperty.call(node, 'title') && typeof node.title !== 'string') {
        violations.push(`${path}.title must be a string`)
      }
      const hasType = Object.prototype.hasOwnProperty.call(node, 'type')
      const hasOneOf = Object.prototype.hasOwnProperty.call(node, 'oneOf')
      if (hasType && hasOneOf) { violations.push(`${path} cannot declare both type and oneOf`); return }
      if (hasOneOf) {
        if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
          violations.push(`${path}.oneOf must be an array of at least two schemas`)
        } else {
          node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`))
        }
        return
      }
      if (!hasType) return
      if (Array.isArray(node.type)) { violations.push(`${path}.type must be a single type string`); return }
      if (!SCHEMA_TYPES.includes(node.type)) { violations.push(`${path}.type is not a supported schema type`); return }
      const type = node.type
      const onObject = ['properties', 'required', 'additionalProperties']
      for (const key of onObject) {
        if (Object.prototype.hasOwnProperty.call(node, key) && type !== 'object') {
          violations.push(`${path}.${key} is not supported on type "${type}"`)
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, 'items') && type !== 'array') {
        violations.push(`${path}.items is not supported on type "${type}"`)
      }
      if (type === 'object' && Object.prototype.hasOwnProperty.call(node, 'properties')) {
        if (!isRecord(node.properties)) violations.push(`${path}.properties must be an object of schemas`)
        else for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${key}`)
      }
      if (type === 'array' && Object.prototype.hasOwnProperty.call(node, 'items')) {
        walk(node.items, `${path}.items`)
      }
    } finally {
      seen.delete(node)
    }
  }

  walk(root, 'schema')
  if (violations.length > 0) throw new SchemaError(violations)
  return root
}

/** Whether a value matches one declared scalar type. */
function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return isRecord(value)
    default: return false
  }
}

function displayPath(path) {
  return path === '' ? 'arguments' : path
}

/**
 * Validate model-generated arguments against a raw schema.
 * @param {object} schema raw JSON Schema (object root)
 * @param {unknown} value candidate arguments
 * @returns {string[]} path-qualified violations; empty means valid
 */
export function validateArgs(schema, value) {
  const violations = []
  const walk = (node, candidate, path) => {
    if (Object.prototype.hasOwnProperty.call(node, 'enum')) {
      const allowed = node.enum
      if (!allowed.some((entry) => entry === candidate)) {
        violations.push(`"${displayPath(path)}" must be one of ${JSON.stringify(allowed)}`)
        return
      }
    }
    if (Object.prototype.hasOwnProperty.call(node, 'const') && candidate !== node.const) {
      violations.push(`"${displayPath(path)}" must be ${JSON.stringify(node.const)}`)
      return
    }
    if (Array.isArray(node.oneOf)) {
      const matches = node.oneOf.filter((branch) => validateArgs(branch, candidate).length === 0)
      if (matches.length !== 1) {
        violations.push(`"${displayPath(path)}" must match exactly one oneOf branch (matched ${matches.length})`)
      }
      return
    }
    if (node.type === undefined) return
    if (!matchesType(node.type, candidate)) {
      violations.push(`"${displayPath(path)}" must be ${node.type === 'integer' ? 'an integer' : `a ${node.type}`}`)
      return
    }
    if (node.type === 'object' && isRecord(candidate)) {
      const props = isRecord(node.properties) ? node.properties : {}
      for (const key of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
          violations.push(`missing required property "${path === '' ? key : `${path}.${key}`}"`)
        }
      }
      for (const [key, child] of Object.entries(candidate)) {
        const childPath = path === '' ? key : `${path}.${key}`
        if (Object.prototype.hasOwnProperty.call(props, key)) walk(props[key], child, childPath)
        else if (node.additionalProperties === false) violations.push(`unexpected property "${childPath}"`)
      }
    }
    if (node.type === 'array' && Array.isArray(candidate) && node.items !== undefined) {
      candidate.forEach((item, index) => walk(node.items, item, `${path}[${index}]`))
    }
  }
  walk(schema, value, '')
  return violations
}

/**
 * Build a registry-ready tool definition, validating arguments first.
 * @param {object} options definition in the authoring form
 * @returns {object} definition the host's tools.register() accepts
 */
export function defineTool(options) {
  const parameters = compileParameters(options.parameters)
  const outputSchema = assertSupportedSchema(options.output.schema)
  const render = options.output.render
  const userExecute = options.execute
  const userConcurrencySafe = options.isConcurrencySafe

  if (typeof render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render must be a function`)
  }
  if (typeof userExecute !== 'function') {
    throw new TypeError(`defineTool(${options.name}): execute must be a function`)
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TypeError(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }

  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: (args, value) => render(args, value) },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ArgsError(violations)
      return userExecute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  if (typeof userConcurrencySafe === 'function') {
    definition.isConcurrencySafe = (args) => {
      if (validateArgs(parameters, args).length > 0) return false
      return userConcurrencySafe(args) === true
    }
  }
  return definition
}

export { ArgsError, SchemaError }
