/**
 * ops_tree: bounded directory listing against a fake ctx.fs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readConfig } from '../lib/config.js'
import { buildTreeTool } from '../lib/tools.js'

const TREE = {
  'C:/root': [
    { name: 'a.txt', type: 'file' },
    { name: 'src', type: 'directory' },
    { name: 'node_modules', type: 'directory' },
    { name: '.env', type: 'file' },
  ],
  'C:/root/src': [
    { name: 'index.js', type: 'file' },
    { name: 'lib', type: 'directory' },
  ],
  'C:/root/src/lib': [{ name: 'deep.js', type: 'file' }],
}

function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

function fakeCtx() {
  const dirs = new Set(Object.keys(TREE))
  const files = new Set()
  for (const [directory, children] of Object.entries(TREE)) {
    for (const child of children) if (child.type === 'file') files.add(`${directory}/${child.name}`)
  }
  return {
    fs: {
      async resolve(requested) {
        const key = norm(requested)
        return { target: { displayPath: key }, displayPath: key }
      },
      async stat(target) {
        const key = norm(target.displayPath)
        if (dirs.has(key)) return { type: 'directory', size: 0, version: 'v' }
        if (files.has(key)) return { type: 'file', size: 10, version: 'v' }
        return undefined
      },
      async listDir(target) {
        const key = norm(target.displayPath)
        return (TREE[key] ?? []).map((child) => ({
          name: child.name,
          type: child.type,
          target: { displayPath: `${key}/${child.name}` },
        }))
      },
    },
    emit() {},
  }
}

function tool() {
  const config = readConfig({}, {})
  return buildTreeTool(fakeCtx(), config)
}

test('ops_tree renders an indented tree and skips vendor and credential paths', async () => {
  const out = await tool().execute({ path: 'C:/root', depth: 3 }, { signal: new AbortController().signal })
  assert.match(out.text, /C:\/root\//)
  assert.match(out.text, /a\.txt/)
  assert.match(out.text, /  index\.js/)
  assert.match(out.text, /    deep\.js/)
  assert.doesNotMatch(out.text, /node_modules/)
  assert.doesNotMatch(out.text, /\.env/)
  assert.ok(out.entries >= 4)
})

test('ops_tree honours depth 0 (top level only)', async () => {
  const out = await tool().execute({ path: 'C:/root', depth: 0 }, { signal: new AbortController().signal })
  assert.match(out.text, /a\.txt/)
  assert.match(out.text, /src\//)
  assert.doesNotMatch(out.text, /index\.js/)
})

test('ops_tree truncates at max_entries', async () => {
  const out = await tool().execute({ path: 'C:/root', depth: 3, max_entries: 1 }, { signal: new AbortController().signal })
  assert.equal(out.entries, 1)
  assert.equal(out.truncated, true)
  assert.match(out.text, /truncated at 1 entries/)
})

test('ops_tree reports a missing directory without throwing', async () => {
  const out = await tool().execute({ path: 'C:/nope' }, { signal: new AbortController().signal })
  assert.match(out.text, /cannot list/)
  assert.equal(out.entries, 0)
})
