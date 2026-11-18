/**
 * The sync status must follow the shared state directory, not a private path.
 *
 * The old helper only knew LOCALAPPDATA and then fell through to the temp
 * directory. That skipped the XDG and home locations every other plugin uses,
 * so the same override meant different files depending on which plugin wrote.
 */
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { statusFile } from '../lib/index.js'
import { statePath } from '../lib/state-dir.js'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function withStateRoot(value, fn) {
  const previous = process.env.DSH_PLUGIN_STATE_DIR
  process.env.DSH_PLUGIN_STATE_DIR = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PLUGIN_STATE_DIR
    else process.env.DSH_PLUGIN_STATE_DIR = previous
  }
}

test('the status file does not default into the plugin source tree', () => {
  const actual = statusFile().replace(/\//g, '\\')
  const prefix = (PLUGIN_DIR.endsWith('\\') || PLUGIN_DIR.endsWith('/') ? PLUGIN_DIR : `${PLUGIN_DIR}\\`).replace(/\//g, '\\')
  assert.equal(actual.startsWith(prefix), false, `status file landed in the source tree: ${actual}`)
})

test('an explicit state root moves the status file and keeps the file name', () => {
  withStateRoot('D:\\state-root', () => {
    const actual = statusFile()
    assert.equal(actual.replace(/\//g, '\\'), 'D:\\state-root\\magpie-models\\status.json')
    assert.equal(actual, statePath('magpie-models', 'status.json'))
  })
})
