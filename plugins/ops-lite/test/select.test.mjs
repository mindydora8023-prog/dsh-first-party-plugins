/**
 * Path selection: globs, directory listings, and literal line lookup.
 *
 * The walk is bounded on purpose. A pattern that could recurse forever, or
 * pull a credential file in through a wide `**`, has to fail these tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { expandEntry, hasGlob, segmentMatch, splitPattern } from '../lib/select.js'
import { lineOfLiteral } from '../lib/text.js'

function host(root) {
  return {
    async resolve(requested, options = {}) {
      const absolute = resolve(options.cwd ?? root, requested)
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      try {
        const stats = (await import('node:fs')).statSync(target.targetKey)
        return { type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other', size: stats.size }
      } catch {
        return undefined
      }
    },
    async listDir(target) {
      const { readdirSync } = await import('node:fs')
      return readdirSync(target.targetKey, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: {
          targetKey: join(target.targetKey, entry.name),
          displayPath: join(target.targetKey, entry.name),
        },
      }))
    },
  }
}

test('hasGlob only fires on * and ?', () => {
  assert.equal(hasGlob('src/index.js'), false)
  assert.equal(hasGlob('src/*.js'), true)
  assert.equal(hasGlob('src/file?.js'), true)
})

test('splitPattern keeps the concrete prefix', () => {
  const parts = splitPattern('src/lib/**/*.js')
  assert.equal(parts.base, join('src', 'lib'))
  assert.deepEqual(parts.segments, ['**', '*.js'])
})

test('segmentMatch is literal except for * and ?', () => {
  assert.equal(segmentMatch('*.js', 'a.js'), true)
  assert.equal(segmentMatch('*.js', 'a.jsx'), false)
  assert.equal(segmentMatch('file?.js', 'fileA.js'), true)
  assert.equal(segmentMatch('a+b.js', 'a+b.js'), true)
  assert.equal(segmentMatch('a+b.js', 'aaab.js'), false)
})

test('** walks nested files, skips node_modules, and drops credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-select-'))
  try {
    mkdirSync(join(root, 'src', 'nested'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), 'a\n', 'utf8')
    writeFileSync(join(root, 'src', 'nested', 'b.js'), 'b\n', 'utf8')
    writeFileSync(join(root, 'src', '.env'), 'SECRET=1\n', 'utf8')
    writeFileSync(join(root, 'node_modules', 'pkg', 'c.js'), 'c\n', 'utf8')
    const ctx = { fs: host(root) }
    const exec = { agent: { session: { header: { cwd: root } } } }
    const result = await expandEntry(ctx, exec, { path: 'src/**/*', limit: 10 }, 32)
    const names = result.entries.map((entry) => entry.path.split(/[\\/]/).at(-1)).sort()
    assert.deepEqual(names, ['a.js', 'b.js'])
    assert.equal(result.entries.every((entry) => entry.limit === 10), true)
    assert.ok(result.notes.some((note) => note.includes('credential')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a directory with no text files is an empty expansion, not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-select-'))
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'blob.exe'), Buffer.from([0]))
    const ctx = { fs: host(root) }
    const exec = { agent: { session: { header: { cwd: root } } } }
    const result = await expandEntry(ctx, exec, { path: 'bin' }, 32)
    assert.equal(result.entries.length, 0)
    assert.ok(result.notes.some((note) => note.includes('no text files')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lineOfLiteral counts physical LF and ignores a missing needle', () => {
  assert.equal(lineOfLiteral('a\nb\nc\n', 'c'), 3)
  assert.equal(lineOfLiteral('a\r\nb\r\n', 'b'), 2)
  assert.equal(lineOfLiteral('abc', 'zzz'), undefined)
  assert.equal(lineOfLiteral('abc', ''), undefined)
})

test('splitPattern preserves POSIX absolute, UNC, and Windows drive roots', () => {
  assert.deepEqual(splitPattern('/etc/nginx/*.conf'), { base: '/etc/nginx', segments: ['*.conf'] })
  assert.deepEqual(splitPattern('/*.conf'), { base: '/', segments: ['*.conf'] })
  const unc = splitPattern('\\\\server\\share\\dir\\*.js')
  assert.equal(unc.base, sep + sep + ['server', 'share', 'dir'].join(sep))
  assert.deepEqual(unc.segments, ['*.js'])
  const driveRoot = splitPattern('C:\\*.js')
  assert.equal(driveRoot.base, 'C:' + sep)
  assert.deepEqual(driveRoot.segments, ['*.js'])
})

test('credentials are dropped before hitting cap and ** does not double-list directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-select-cap-'))
  try {
    mkdirSync(join(root, 'src', '.ssh'), { recursive: true })
    writeFileSync(join(root, 'src', '.env'), 'SECRET=1\n', 'utf8')
    writeFileSync(join(root, 'src', '.env.local'), 'SECRET=2\n', 'utf8')
    writeFileSync(join(root, 'src', '.ssh', 'id_rsa'), 'KEY\n', 'utf8')
    writeFileSync(join(root, 'src', 'z.js'), 'ok\n', 'utf8')
    const listCounts = new Map()
    const baseFs = host(root)
    const ctx = {
      fs: {
        ...baseFs,
        async listDir(target) {
          const k = target.targetKey.toLowerCase()
          listCounts.set(k, (listCounts.get(k) ?? 0) + 1)
          return baseFs.listDir(target)
        },
      },
    }
    const exec = { agent: { session: { header: { cwd: root } } } }
    const result = await expandEntry(ctx, exec, { path: 'src/**/*' }, 1)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].path.split(/[\\/]/).at(-1), 'z.js')
    for (const [dir, count] of listCounts.entries()) {
      assert.equal(count, 1, `directory ${dir} was listed ${count} times instead of once`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
