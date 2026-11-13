/**
 * Unit tests for config parsing and repository reference handling.
 *
 *   node --test test/config.test.mjs
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { DEFAULT_API_BASE, readConfig, parseRepo } from '../lib/config.js'
import { statePath } from '../lib/state-dir.js'

const dirs = { pluginDir: join(tmpdir(), 'dsh-github-config-test'), profileDir: '', home: '' }

test('defaults are applied when the row has no config', () => {
  const config = readConfig(undefined, dirs)
  assert.equal(config.apiBaseUrl, DEFAULT_API_BASE)
  assert.equal(config.perPage, 25)
  assert.equal(config.maxChars, 20000)
  assert.equal(config.allowWrite, true)
  assert.equal(config.useGitCredential, true)
  // Credentials must default to the per-user state directory, never the source
  // tree (which is mirrored to git and may be read-only).
  assert.equal(config.credentialsFile, statePath('github', 'credentials.json'))
  assert.notEqual(config.credentialsFile, join(dirs.pluginDir, 'credentials.json'))
  assert.equal(config.killSwitch, join(dirs.pluginDir, 'dsh-github.disabled'))
})

test('explicit config overrides defaults and trailing slashes are stripped', () => {
  const config = readConfig(
    {
      apiBaseUrl: 'https://ghe.example.com/api/v3/',
      perPage: 5,
      allowWrite: false,
      defaultRepo: 'octo/hello',
      credentialsFile: 'C:/tmp/creds.json',
      timeoutMs: 999999999,
    },
    dirs,
  )
  assert.equal(config.apiBaseUrl, 'https://ghe.example.com/api/v3')
  assert.equal(config.perPage, 5)
  assert.equal(config.allowWrite, false)
  assert.equal(config.defaultRepo, 'octo/hello')
  assert.equal(config.credentialsFile, 'C:/tmp/creds.json')
  // An absurd timeout is clamped instead of silently breaking every call.
  assert.equal(config.timeoutMs, 180000)
})

test('perPage stays inside the API range', () => {
  assert.equal(readConfig({ perPage: 0 }, dirs).perPage, 1)
  assert.equal(readConfig({ perPage: 5000 }, dirs).perPage, 100)
  assert.equal(readConfig({ perPage: 'nonsense' }, dirs).perPage, 25)
})

test('statusFile can be disabled with false', () => {
  assert.equal(readConfig({ statusFile: false }, dirs).statusFile, false)
})

test('parseRepo accepts owner/name, urls, .git suffixes and slashes', () => {
  assert.equal(parseRepo('octo/hello').full, 'octo/hello')
  assert.equal(parseRepo('/octo/hello/').full, 'octo/hello')
  assert.equal(parseRepo('octo/hello.git').full, 'octo/hello')
  assert.equal(parseRepo('https://github.com/octo/hello').full, 'octo/hello')
  assert.equal(parseRepo('https://github.com/octo/hello.git').full, 'octo/hello')
  assert.equal(parseRepo('https://github.com/octo/hello/pull/12').full, 'octo/hello')
  assert.equal(parseRepo('', 'octo/fallback').full, 'octo/fallback')
})

test('parseRepo rejects malformed references with an actionable message', () => {
  assert.throws(() => parseRepo('', ''), /No repository/)
  assert.throws(() => parseRepo('justaname'), /expected "owner\/name"/)
  assert.throws(() => parseRepo('a/b/c'), /expected "owner\/name"/)
  assert.throws(() => parseRepo('own er/repo'), /Invalid repository/)
  assert.throws(() => parseRepo('owner/re po'), /Invalid repository/)
})
