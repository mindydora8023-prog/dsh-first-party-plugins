/**
 * Config: new fields, and the catalog file staying out of the source tree.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../lib/config.js'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('description and keywords are kept short and out of the manager entry', () => {
  const config = readConfig({
    servers: {
      REA: {
        transport: 'stdio',
        command: 'node',
        description: '  Ghidra   reverse\nengineering  ',
        keywords: ['binary', 12, 'x'.repeat(80)],
      },
    },
  })
  assert.equal(config.servers.REA.description, 'Ghidra reverse engineering')
  assert.deepEqual(config.servers.REA.keywords[0], 'binary')
  assert.equal(config.servers.REA.keywords[1].length, 40)
  assert.equal(config.servers.REA.entry.description, undefined)
  assert.equal(config.maxConcurrent, 2)
})

test('maxConcurrent only accepts 1 through 4', () => {
  assert.equal(readConfig({ maxConcurrent: 4 }).maxConcurrent, 4)
  assert.equal(readConfig({ maxConcurrent: 9 }).maxConcurrent, 2)
  assert.equal(readConfig({ maxConcurrent: 0 }).maxConcurrent, 2)
})

test('the catalog file does not default into the plugin source tree', () => {
  const file = readConfig({}).catalogFile
  assert.equal(typeof file, 'string')
  const prefix = PLUGIN_DIR.replace(/\//g, '\\').replace(/[\\/]+$/, '') + '\\'
  assert.equal(String(file).replace(/\//g, '\\').toLowerCase().startsWith(prefix.toLowerCase()), false)
  assert.equal(readConfig({ catalogFile: false }).catalogFile, false)
  assert.equal(readConfig({ catalogFile: 'C:/explicit/catalog.json' }).catalogFile, 'C:/explicit/catalog.json')
})
