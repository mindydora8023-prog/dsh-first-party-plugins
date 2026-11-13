/**
 * Credential resolution tests.
 *
 * The gh CLI path is the one users hit first, and it depends on process
 * environment and an executable that may be missing, so it is tested with a
 * fake gh script rather than the real one.
 *
 *   node --test test/auth.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { clearTokenCache, resolveToken, scrub } from '../lib/auth.js'
import { readConfig } from '../lib/config.js'

const PLUGIN_DIR = 'E:/tmp/github-auth-test'
const TOKEN = 'ghp_fromfaketool00000000000000000000000'

function configFor(overrides = {}) {
  return readConfig(
    { useGitCredential: false, useGhCli: true, credentialsFile: join(PLUGIN_DIR, 'missing.json'), ...overrides },
    { pluginDir: PLUGIN_DIR, profileDir: '', home: '' },
  )
}

function withCleanEnv(fn) {
  return async () => {
    const saved = {
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
      GH_TOKEN: process.env['GH_TOKEN'],
    }
    delete process.env['GITHUB_TOKEN']
    delete process.env['GH_TOKEN']
    clearTokenCache()
    try {
      await fn()
    } finally {
      clearTokenCache()
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value
      }
    }
  }
}

/**
 * Create a stand-in for gh.exe that answers `--version` and `auth token`.
 * On Windows an executable needs a .cmd wrapper; that is what the plugin runs
 * when the configured path points at a non-.exe file.
 */
function fakeGh(script) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-fake-gh-'))
  const nodePath = join(directory, 'fake-gh.mjs')
  writeFileSync(nodePath, script, 'utf8')
  const wrapper = join(directory, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  if (process.platform === 'win32') {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${nodePath}" %*\r\n`, 'utf8')
  } else {
    writeFileSync(wrapper, `#!${process.execPath}\n${script}`, 'utf8')
    chmodSync(wrapper, 0o700)
  }
  return wrapper
}

// Real installed-CLI discovery is a manual integration check, excluded offline.

test('with gh disabled there is no fallback, so a missing file means no token', withCleanEnv(async () => {
  const config = configFor({ ghExecutable: 'C:/definitely/not/here/gh.exe', useGhCli: false })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, '')
  assert.equal(resolved.source, 'none')
}))

test('a token is read from the gh CLI and reported with its source', withCleanEnv(async () => {
  const gh = fakeGh(`
if (process.argv[2] === '--version') {
  console.log('gh version 9.9.9')
  process.exit(0)
}
if (process.argv[2] === 'auth' && process.argv[3] === 'token') {
  console.log('${TOKEN}')
  process.exit(0)
}
process.exit(1)
`)
  const config = configFor({ ghExecutable: gh })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, TOKEN)
  assert.equal(resolved.source, 'gh-cli')
  assert.equal(resolved.detail, 'gh auth token')
}))

test('a gh CLI that is installed but logged out yields no token and no error', withCleanEnv(async () => {
  const gh = fakeGh(`
if (process.argv[2] === '--version') {
  console.log('gh version 9.9.9')
  process.exit(0)
}
process.exit(1)
`)
  const config = configFor({ ghExecutable: gh })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, '')
  assert.equal(resolved.source, 'none')
}))

test('a gh CLI that hangs is not allowed to block the host', withCleanEnv(async () => {
  const gh = fakeGh(`
if (process.argv[2] === '--version') {
  console.log('gh version 9.9.9')
  process.exit(0)
}
// Never answer: the 10s spawn timeout must cut this off.
setTimeout(() => {}, 12000)
`)
  const config = configFor({ ghExecutable: gh })
  const started = Date.now()
  const resolved = resolveToken(config, { refresh: true })
  const elapsed = Date.now() - started
  assert.equal(resolved.token, '')
  assert.ok(elapsed < 30000, `took ${elapsed}ms, expected the timeout to end it`)
}))

test('credentials.json is preferred over the gh CLI', withCleanEnv(async () => {
  const gh = fakeGh(`
if (process.argv[2] === '--version') { console.log('gh version 9.9.9'); process.exit(0) }
if (process.argv[2] === 'auth' && process.argv[3] === 'token') { console.log('${TOKEN}'); process.exit(0) }
process.exit(1)
`)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-github-creds-'))
  const file = join(directory, 'credentials.json')
  writeFileSync(file, JSON.stringify({ token: 'ghp_fromfile000000000000000000000000000' }), 'utf8')
  const config = configFor({ ghExecutable: gh, credentialsFile: file })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.source, 'credentials-file')
  assert.match(resolved.token, /^ghp_fromfile/)
}))

test('the token cache honours tokenCacheSeconds: 0', withCleanEnv(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-token-cache-'))
  const file = join(dir, 'credentials.json')
  writeFileSync(file, JSON.stringify({ token: 'ghp_first000000000000' }), 'utf8')
  const config = configFor({ credentialsFile: file, useGitCredential: false, useGhCli: false, tokenCacheSeconds: 0 })
  const first = resolveToken(config)
  assert.equal(first.token, 'ghp_first000000000000')
  // Change the underlying source; a zero-second cache must re-read it on the very
  // next call instead of serving the stale in-memory token. (File-based so it
  // works on every OS without a gh executable.)
  writeFileSync(file, JSON.stringify({ token: 'ghp_second00000000000' }), 'utf8')
  const second = resolveToken(config)
  assert.equal(second.token, 'ghp_second00000000000', 'tokenCacheSeconds:0 must re-read the source')
}))

test('scrub removes a token from textual diagnostics', () => {
  assert.equal(scrub(`failed with ${TOKEN}`, TOKEN), 'failed with [redacted]')
  assert.equal(scrub('nothing', TOKEN), 'nothing')
})

test('the plugin sources never contain a hard-coded token', () => {
  for (const file of ['../lib/auth.js', '../lib/config.js', '../lib/tools.js', '../lib/index.js', '../lib/api.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{30,}/, `${file} must not embed a token`)
  }
})
